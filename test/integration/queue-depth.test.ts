import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config';
import { dlqAttributes } from '../../src/infrastructure/messaging/queue-attributes';
import { queueDepth } from '../../src/infrastructure/messaging/queue-depth';

// The figure behind `wagering_dlq_messages`, read from a throwaway queue so the development DLQ is never touched.
describe('queueDepth (MiniStack)', () => {
  let sqs: SQSClient;
  let queueUrl: string;
  const queueName = `depth-test-${crypto.randomUUID().slice(0, 8)}.fifo`;

  beforeAll(async () => {
    const { sqs: config } = loadConfig();
    sqs = new SQSClient({ endpoint: config.endpoint, region: config.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: dlqAttributes() }))).QueueUrl!;
  });
  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
  });

  it('counts the messages waiting in the queue', async () => {
    expect(await queueDepth(sqs, queueName)).toBe(0);
    for (const id of ['a', 'b', 'c']) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: id, MessageGroupId: 'g', MessageDeduplicationId: id }));
    }

    const deadline = Date.now() + 5_000; // SQS reports an approximate figure; give it a moment
    let depth = await queueDepth(sqs, queueName);
    while (depth !== 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      depth = await queueDepth(sqs, queueName);
    }

    expect(depth).toBe(3);
  });

  it('fails for a queue that does not exist, so the gauge reads NaN instead of 0', async () => {
    await expect(queueDepth(sqs, `missing-${crypto.randomUUID()}.fifo`)).rejects.toThrow();
  });
});
