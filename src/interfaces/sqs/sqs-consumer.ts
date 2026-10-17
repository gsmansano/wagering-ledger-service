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
import { errorFields } from '../../infrastructure/logging/log-fields';
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
  /** How long `stop()` waits for messages in flight before it hands them back to the queue. */
  shutdownTimeoutMs: number;
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
 * On shutdown (decision #55) it stops receiving, lets the message being handled finish, releases the ones not yet
 * started and, if the wait exceeds `shutdownTimeoutMs`, hands everything unfinished back with visibility 0.
 */
export class SqsConsumer {
  private readonly logger = new Logger(SqsConsumer.name);
  private urls: { queue: string; dlq: string } | undefined;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];
  private stopped = true;
  /** Set by `stop()`; unlike `stopped` it is false for a consumer that is driven by `pollOnce` without `start()`. */
  private shuttingDown = false;
  /** Received and not yet settled or released: what shutdown must hand back if it cannot wait any longer. */
  private readonly inFlight = new Map<string, Message>();
  /** Polls under way, whoever started them (the loops or a direct `pollOnce`): `stop()` waits for all of them. */
  private readonly active = new Set<Promise<number>>();

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
    this.shuttingDown = false;
    this.abort = new AbortController();
    this.loops = Array.from({ length: this.options.pollers }, () => this.loop());
  }

  /**
   * Stops receiving, waits for the message being handled in each group, and releases the rest. If handling takes
   * longer than the shutdown timeout the unfinished messages return to the queue at once instead of after the
   * visibility timeout. Should such a handler still commit, the redelivery becomes a duplicate (decision #51).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.shuttingDown = true;
    this.abort.abort();
    const finished = Promise.allSettled([...this.loops, ...this.active]).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs);
    });
    const completed = await Promise.race([finished, timeout]);
    clearTimeout(timer);
    if (!completed) {
      const pending = [...this.inFlight.values()];
      this.logger.warn({ event: 'shutdown_timeout', count: pending.length }, 'Shutdown timeout: handing unfinished messages back to the queue');
      this.inFlight.clear();
      await Promise.all(pending.map((message) => this.setVisibility(message, 0)));
    }
    this.loops = [];
  }

  /** One receive and the handling of what it returned. Returns how many messages were received. */
  async pollOnce(): Promise<number> {
    const poll = this.receiveAndHandle();
    this.active.add(poll);
    try {
      return await poll;
    } finally {
      this.active.delete(poll);
    }
  }

  private async receiveAndHandle(): Promise<number> {
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
      this.inFlight.set(message.MessageId ?? '', message);
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
        this.logger.error({ event: 'sqs_poll_failed', ...errorFields(error) }, 'SQS poll failed');
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
      // Once stopped, messages not yet started go back untouched instead of lengthening the shutdown.
      if (this.shuttingDown) {
        await Promise.all(group.slice(index).map((m) => this.release(m)));
        return;
      }
      const settled = await this.handleOne(message);
      this.inFlight.delete(message.MessageId ?? '');
      if (!settled) {
        // The failed message keeps its backoff; the later ones of the wallet must not overtake it.
        await Promise.all(group.slice(index + 1).map((m) => this.release(m)));
        return;
      }
    }
  }

  private async release(message: Message): Promise<void> {
    this.inFlight.delete(message.MessageId ?? '');
    await this.setVisibility(message, 0);
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
          this.logger.warn(
            { event: 'message_retry', messageId: message.MessageId, receiveCount, ...errorFields(disposition.cause) },
            'Message will be retried',
          );
          await this.setVisibility(message, Math.ceil(disposition.delayMs / 1000));
          return false;
        case 'dead-letter':
          return await this.deadLetter(message, disposition);
      }
    } catch (error) {
      // The effect is committed or deliberately absent; whatever failed here only delays the message, and the
      // inbox absorbs a redelivery. It returns when its visibility timeout ends.
      this.logger.error({ event: 'message_settle_failed', messageId: message.MessageId, ...errorFields(error) }, 'Could not settle message');
      return false;
    }
  }

  /** Explicit DLQ send, then delete. If the send fails the message stays and the redrive policy still applies. */
  private async deadLetter(message: Message, disposition: Extract<MessageDisposition, { kind: 'dead-letter' }>): Promise<boolean> {
    const { dlq } = await this.queues();
    this.logger.error(
      { event: 'message_dead_lettered', messageId: message.MessageId, errorName: disposition.code, errorMessage: disposition.reason },
      'Message is permanently invalid',
    );
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
      this.logger.error({ event: 'message_visibility_failed', messageId: message.MessageId, ...errorFields(error) }, 'Could not change message visibility');
    }
  }
}
