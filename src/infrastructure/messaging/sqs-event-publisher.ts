import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/**
 * Sends outbox events to a FIFO queue (decision #57). The group is the wallet, so SQS keeps a wallet's events in
 * order, and the deduplication id is the event id, so a second send of the same event within the SQS window (5
 * minutes) is dropped by the broker. Beyond that window the consumer deduplicates by the event id in the body.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    /** A hung call would hold the claimed row and its connection; the attempt fails instead and is retried. */
    private readonly sendTimeoutMs = 10_000,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: { EventType: { DataType: 'String', StringValue: message.eventType } },
      }),
      { abortSignal: AbortSignal.timeout(this.sendTimeoutMs) },
    );
  }

  // Cached once it resolves; a failed lookup is not cached, so the next attempt asks again. The queue itself is
  // created by the provisioner at startup.
  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then(({ QueueUrl }) => {
        if (!QueueUrl) throw new Error(`Could not resolve the URL of ${this.queueName}`);
        return QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }
}
