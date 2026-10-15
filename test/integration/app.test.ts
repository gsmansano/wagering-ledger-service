import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';
import { WAGER_DLQ, WAGER_QUEUE } from '../../src/infrastructure/messaging/queue-names';

// Boots the full Nest app against real PostgreSQL and the SQS emulator.
// Booting at all proves decorator metadata works under Bun: the queue
// provisioner would receive `undefined` instead of an SQSClient otherwise.
describe('application (real PostgreSQL + SQS emulator)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0); // random free port
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns 200', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('provisions the FIFO queue with a redrive policy to the FIFO DLQ', async () => {
    const sqs = app.get(SQSClient);
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_QUEUE }));
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['FifoQueue', 'RedrivePolicy'] }),
    );
    expect(Attributes?.FifoQueue).toBe('true');

    const redrive = JSON.parse(Attributes?.RedrivePolicy ?? '{}');
    expect(redrive.deadLetterTargetArn).toEndWith(`:${WAGER_DLQ}`);
    expect(Number(redrive.maxReceiveCount)).toBe(5);
  });
});
