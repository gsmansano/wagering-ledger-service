import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutbox } from '../../src/application/outbox/publish-outbox';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/transaction/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { loadConfig } from '../../src/config';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WagerTransactionKind } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { eventsQueueAttributes } from '../../src/infrastructure/messaging/queue-attributes';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { OutboxWorker } from '../../src/infrastructure/workers/outbox.worker';
import { CountingMetrics } from '../support/counting-metrics';
import { initTestOrm, truncateAll } from '../support/database';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Refuses the first `failures` sends and can hold a send until released; otherwise delegates to the real publisher. */
class FlakyPublisher implements EventPublisher {
  failures = 0;
  gate: Promise<void> | undefined;
  constructor(private readonly inner: EventPublisher) {}
  async publish(message: OutboxMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('broker unavailable');
    }
    await this.inner.publish(message);
    await this.gate;
  }
}

describe('OutboxWorker (real PostgreSQL and MiniStack)', () => {
  const { sqs: cfg } = loadConfig();
  const sqs = new SQSClient({ endpoint: cfg.endpoint, region: cfg.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const queueName = `test-outbox-${crypto.randomUUID().slice(0, 8)}.fifo`;
  let queueUrl: string;
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  let createWallet: CreateWallet;
  let processTransaction: ProcessWagerTransaction;
  const started: OutboxWorker[] = [];

  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const unpublished = async () =>
    Number((await query<{ n: string }>('select count(*) as n from outbox_messages where published_at is null'))[0]!.n);
  const outboxTotal = async () => Number((await query<{ n: string }>('select count(*) as n from outbox_messages'))[0]!.n);

  /** An instance: its own publisher, use case and worker, all against the same database and queue. */
  const instance = (
    options: { unitOfWork?: UnitOfWork; publisher?: EventPublisher; pollIntervalMs?: number; retry?: { baseMs: number; capMs: number; maxAttempts: number }; metrics?: CountingMetrics } = {},
  ) => {
    const publisher = options.publisher ?? new SqsEventPublisher(sqs, queueName);
    const publishOutbox = new PublishOutbox({
      unitOfWork: options.unitOfWork ?? uow,
      publisher,
      now: () => new Date(),
      retry: options.retry,
    });
    const worker = new OutboxWorker(publishOutbox, { enabled: true, pollIntervalMs: options.pollIntervalMs ?? 20, batchSize: 50 }, options.metrics);
    started.push(worker);
    return worker;
  };
  const untilDrained = async (timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await outboxTotal()) > 0 && (await unpublished()) === 0) return;
      await sleep(25);
    }
    throw new Error('The outbox was not drained in time');
  };

  /** Receives and deletes until `expected` messages arrived or the time is up. FIFO hands out one group's messages in order. */
  const receive = async (expected: number, timeoutMs = 15_000): Promise<Message[]> => {
    const received: Message[] = [];
    const deadline = Date.now() + timeoutMs;
    while (received.length < expected && Date.now() < deadline) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['MessageGroupId'] }),
      );
      for (const m of Messages ?? []) {
        received.push(m);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
      }
    }
    return received;
  };

  const bet = (walletId: string, playerId: string, n: number) => ({
    idempotencyKey: `key-${walletId}-${n}`,
    providerId: 'provider-1',
    externalTransactionId: `ext-${walletId}-${n}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  });
  const openWallet = (name: string) => createWallet.execute({ playerId: `player-${name}`, currency: 'BRL', initialAmount: '1000.00' });

  beforeAll(async () => {
    orm = await initTestOrm();
    uow = new MikroOrmUnitOfWork(orm.em);
    const deps = { unitOfWork: uow, now: () => new Date(), newId: () => Bun.randomUUIDv7() };
    createWallet = new CreateWallet(deps);
    processTransaction = new ProcessWagerTransaction(deps);
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: eventsQueueAttributes() }))).QueueUrl!;
  });

  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((w) => w.stop()));
  });

  it('publishes the events a committed change left in the outbox, and marks them published', async () => {
    const wallet = await openWallet('a');
    expect(await unpublished()).toBe(1); // the opening WalletBalanceChanged

    expect(await instance().tick()).toBe(1);

    const [message] = await receive(1);
    const event = JSON.parse(message!.Body!);
    expect(event).toMatchObject({ eventType: 'WalletBalanceChanged', aggregateId: wallet.id });
    expect(message!.Attributes?.MessageGroupId).toBe(wallet.id);
    expect(await unpublished()).toBe(0);
  });

  it('commit, then the process dies before publishing: another instance publishes the event', async () => {
    // Instance A commits the business change and dies before its worker ever runs: it simply publishes nothing.
    const wallet = await openWallet('a');
    await processTransaction.execute(bet(wallet.id, wallet.playerId, 1));
    expect(await unpublished()).toBe(3); // opening balance change, then the bet's processed + balance change
    expect((await receive(1, 1_500))).toHaveLength(0);

    // Instance B starts later and finds the work in the table.
    instance().start();
    await untilDrained();

    const received = await receive(3);
    expect(received.map((m) => JSON.parse(m.Body!).eventType)).toEqual([
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('send, then the process dies before the commit: the next instance sends it again and the broker keeps one copy', async () => {
    const wallet = await openWallet('a');
    const crashing: UnitOfWork = {
      run: <T>(work: (repositories: Repositories) => Promise<T>) =>
        uow.run(async (repos) => {
          await work(repos);
          throw new Error('process died before the commit');
        }),
    };
    const doomed = instance({ unitOfWork: crashing });
    await expect(doomed.tick()).rejects.toThrow('process died'); // sent to SQS, row still unpublished
    expect(await unpublished()).toBe(1);

    expect(await instance().tick()).toBe(1); // the second send of the same event id
    expect(await unpublished()).toBe(0);

    const received = await receive(2, 3_000);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.Body!).aggregateId).toBe(wallet.id);
  });

  it('several instances publish a loaded outbox once each, in order per wallet, through the real queue', async () => {
    const wallets = await Promise.all(['a', 'b', 'c'].map(openWallet));
    for (let n = 1; n <= 5; n++) {
      await Promise.all(wallets.map((w) => processTransaction.execute(bet(w.id, w.playerId, n))));
    }
    const expectedEvents = await outboxTotal(); // per wallet: 1 opening + 5 x (processed + balance changed) = 11
    expect(expectedEvents).toBe(33);

    for (let i = 0; i < 4; i++) instance().start();
    await untilDrained();

    const received = await receive(expectedEvents);
    expect(received).toHaveLength(expectedEvents);
    expect(new Set(received.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(expectedEvents);
    // Per wallet, the order in the queue is the order in the outbox.
    for (const w of wallets) {
      const inOutbox = (await query<{ id: string }>('select id from outbox_messages where aggregate_id = ? order by sequence', [w.id])).map((r) => r.id);
      const inQueue = received.filter((m) => m.Attributes?.MessageGroupId === w.id).map((m) => JSON.parse(m.Body!).eventId);
      expect(inQueue).toEqual(inOutbox);
    }
  });

  it('keeps polling after the broker refuses a send, and publishes once it recovers', async () => {
    await openWallet('a');
    const flaky = new FlakyPublisher(new SqsEventPublisher(sqs, queueName));
    flaky.failures = 2;

    const metrics = new CountingMetrics();
    instance({ publisher: flaky, retry: { baseMs: 20, capMs: 40, maxAttempts: 10 }, metrics }).start();
    await untilDrained();

    expect(await receive(1)).toHaveLength(1);
    expect(metrics.outboxFailures).toEqual(['retry', 'retry']);
    const [row] = await query<{ attempts: number }>('select attempts from outbox_messages');
    expect(row!.attempts).toBe(2);
  });

  it('stop() waits for the publish in flight and leaves a consistent row', async () => {
    await openWallet('a');
    const flaky = new FlakyPublisher(new SqsEventPublisher(sqs, queueName));
    let release!: () => void;
    flaky.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = instance({ publisher: flaky });
    worker.start();
    while ((await receive(1, 300)).length === 0) await sleep(10); // the send reached SQS, the transaction is still open

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await sleep(100);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(await unpublished()).toBe(0);
  });
});
