import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../config';
import { dlqAttributes, mainQueueAttributes } from './queue-attributes';
import { WAGER_DLQ, WAGER_QUEUE } from './queue-names';

// Creates the queues on startup. CreateQueue is idempotent for identical
// attributes, so every instance can run this concurrently.
@Injectable()
export class QueueProvisioner implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueProvisioner.name);

  constructor(private readonly sqs: SQSClient) {}

  async onApplicationBootstrap(): Promise<void> {
    // The DLQ must exist first: the main queue's redrive policy references its ARN.
    const dlq = await this.sqs.send(
      new CreateQueueCommand({ QueueName: WAGER_DLQ, Attributes: dlqAttributes() }),
    );
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
    );
    const dlqArn = Attributes?.QueueArn;
    if (!dlqArn) throw new Error(`Could not resolve ARN for ${WAGER_DLQ}`);

    await this.sqs.send(
      new CreateQueueCommand({
        QueueName: WAGER_QUEUE,
        Attributes: mainQueueAttributes(dlqArn, loadConfig().sqs.maxReceiveCount),
      }),
    );
    this.logger.log(`Queues ready: ${WAGER_QUEUE}, ${WAGER_DLQ}`);
  }
}
