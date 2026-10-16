import { Logger } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MessageDisposition } from './message-disposition';

export interface SqsConsumerOptions {
  /** When false the Nest lifecycle does not start polling (tests and one-off runs); `start()` still works. */
  enabled: boolean;
  queueName: string;
  dlqName: string;
  /** Messages requested per receive (SQS allows 1 to 10). */
  batchSize: number;
  /** Parallel receive loops in this instance. */
  pollers: number;
  /** Long-poll wait; an idle loop costs one request per this many seconds. */
  waitTimeSeconds: number;
}

export interface MessageHandler {
  handle(body: string, receiveCount: number): Promise<MessageDisposition>;
}

const MAX_VISIBILITY_SECONDS = 43_200; // the SQS limit (12 hours)
const ERROR_BACKOFF_MS = 1_000;

/**
 * Long-polls the FIFO queue and applies the handler's verdict to each message. A message is deleted only after
 * the handler returned, that is after the SQL transaction committed: a crash in between redelivers it, and the
 * inbox turns the second delivery into a no-op (decision #51).
 * Messages of one wallet (one FIFO group) are handled in order; different groups of a batch run in parallel.
 * When a message is not settled the rest of its group in the batch is released, so it is neither handled out of
 * order nor held hidden for the full visibility timeout.
 */
export class SqsConsumer {
  private readonly logger = new Logger(SqsConsumer.name);
  private urls: { queue: string; dlq: string } | undefined;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];
  private stopped = true;

  constructor(
    private readonly sqs: SQSClient,
    private readonly handler: MessageHandler,
    private readonly options: SqsConsumerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.enabled) this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.loops = Array.from({ length: this.options.pollers }, () => this.loop());
  }

  /** Stops receiving and waits for the messages in flight to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await Promise.all(this.loops);
    this.loops = [];
  }

  /** One receive and the handling of what it returned. Returns how many messages were received. */
  async pollOnce(): Promise<number> {
    const { queue } = await this.queues();
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue,
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.abort.signal },
    );

    const groups = new Map<string, Message[]>();
    for (const message of Messages) {
      const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
    return Messages.length;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopped) break; // the receive was aborted by stop()
        // A failed receive (emulator down, queue not created yet) must not kill the loop.
        this.logger.error(`SQS poll failed: ${describe(error)}`);
        await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
      }
    }
  }

  /** The provisioner creates the queues at startup, possibly after this loop began, so resolve lazily. */
  private async queues(): Promise<{ queue: string; dlq: string }> {
    if (this.urls === undefined) {
      const [queue, dlq] = await Promise.all(
        [this.options.queueName, this.options.dlqName].map((QueueName) =>
          this.sqs.send(new GetQueueUrlCommand({ QueueName })).then((r) => r.QueueUrl!),
        ),
      );
      this.urls = { queue: queue!, dlq: dlq! };
    }
    return this.urls;
  }

  private async handleGroup(group: Message[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (!(await this.handleOne(message))) {
        await Promise.all(group.slice(index + 1).map((rest) => this.setVisibility(rest, 0)));
        return;
      }
    }
  }

  /** Returns true when the message is settled (deleted), false when it stays in the queue. */
  private async handleOne(message: Message): Promise<boolean> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const disposition = await this.handler.handle(message.Body ?? '', receiveCount);
    try {
      switch (disposition.kind) {
        case 'ack':
          await this.delete(message);
          return true;
        case 'retry':
          this.logger.warn(`Message ${message.MessageId} will be retried (receive ${receiveCount}): ${describe(disposition.cause)}`);
          await this.setVisibility(message, Math.ceil(disposition.delayMs / 1000));
          return false;
        case 'dead-letter':
          return await this.deadLetter(message, disposition);
      }
    } catch (error) {
      // The effect is committed or deliberately absent; whatever failed here only delays the message, and the
      // inbox absorbs a redelivery. It returns when its visibility timeout ends.
      this.logger.error(`Could not settle message ${message.MessageId}: ${describe(error)}`);
      return false;
    }
  }

  /** Explicit DLQ send, then delete. If the send fails the message stays and the redrive policy still applies. */
  private async deadLetter(message: Message, disposition: Extract<MessageDisposition, { kind: 'dead-letter' }>): Promise<boolean> {
    const { dlq } = await this.queues();
    this.logger.error(`Message ${message.MessageId} is permanently invalid (${disposition.code}): ${disposition.reason}`);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? message.MessageId,
        // The source message id makes a repeated send (crash between send and delete) a no-op in the FIFO window.
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          ErrorCode: { DataType: 'String', StringValue: disposition.code },
          ErrorReason: { DataType: 'String', StringValue: disposition.reason },
          SourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? '' },
        },
      }),
    );
    await this.delete(message);
    return true;
  }

  private async delete(message: Message): Promise<void> {
    const { queue } = await this.queues();
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle }));
  }

  private async setVisibility(message: Message, seconds: number): Promise<void> {
    try {
      const { queue } = await this.queues();
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queue,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: Math.min(seconds, MAX_VISIBILITY_SECONDS),
        }),
      );
    } catch (error) {
      this.logger.error(`Could not change visibility of ${message.MessageId}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
