import { afterAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config';
import { dlqAttributes, mainQueueAttributes } from '../../src/infrastructure/messaging/queue-attributes';

// Verifies the emulator itself: a FIFO message that is received but never
// deleted moves to the FIFO DLQ after maxReceiveCount receives.
// Uses throwaway queues so the application queues stay untouched.
describe('SQS emulator redrive (real MiniStack)', () => {
  const { sqs: cfg } = loadConfig();
  const sqs = new SQSClient({ endpoint: cfg.endpoint, region: cfg.region });
  const suffix = crypto.randomUUID().slice(0, 8);
  const created: string[] = [];

  afterAll(async () => {
    await Promise.all(created.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
  });

  it('moves a repeatedly failed message to the DLQ', async () => {
    const dlq = await sqs.send(
      new CreateQueueCommand({ QueueName: `redrive-test-dlq-${suffix}.fifo`, Attributes: dlqAttributes() }),
    );
    created.push(dlq.QueueUrl!);
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
    );
    const main = await sqs.send(
      new CreateQueueCommand({
        QueueName: `redrive-test-${suffix}.fifo`,
        Attributes: mainQueueAttributes(Attributes!.QueueArn!, 2),
      }),
    );
    created.push(main.QueueUrl!);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: main.QueueUrl,
        MessageBody: '{"poison":true}',
        MessageGroupId: 'wallet-1',
        MessageDeduplicationId: 'msg-1',
      }),
    );

    // Receive without deleting (a simulated failure). VisibilityTimeout 0 makes
    // the message visible again immediately instead of after the default 30 s.
    const receive = () =>
      sqs.send(new ReceiveMessageCommand({ QueueUrl: main.QueueUrl, VisibilityTimeout: 0, WaitTimeSeconds: 1 }));
    expect((await receive()).Messages).toHaveLength(1);
    expect((await receive()).Messages).toHaveLength(1);
    // Third receive exceeds maxReceiveCount = 2: the message is redriven instead of delivered.
    expect((await receive()).Messages ?? []).toHaveLength(0);

    const dead = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl, WaitTimeSeconds: 1 }));
    expect(dead.Messages?.[0]?.Body).toBe('{"poison":true}');
  });
});
