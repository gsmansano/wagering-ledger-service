import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/transaction/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { loadConfig } from '../../src/config';
import { dlqAttributes, mainQueueAttributes } from '../../src/infrastructure/messaging/queue-attributes';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { SqsConsumer, type MessageHandler } from '../../src/interfaces/sqs/sqs-consumer';
import { WagerMessageHandler } from '../../src/interfaces/sqs/wager-message.handler';
import { CountingMetrics } from '../support/counting-metrics';
import { initTestOrm, truncateAll } from '../support/database';
import { assertLedgerMatchesBalance } from '../support/ledger';

const MAX_RECEIVE_COUNT = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const transientError = () => Object.assign(new Error('connection terminated'), { code: '08006' });

/** Fails the first `failures` runs with a transient database error, then delegates to the real unit of work. */
class FlakyUnitOfWork implements UnitOfWork {
  failures = 0;
  constructor(private readonly inner: UnitOfWork) {}
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(transientError());
    }
    return this.inner.run(work);
  }
}

describe('SqsConsumer (real PostgreSQL and MiniStack)', () => {
  const { sqs: cfg } = loadConfig();
  const sqs = new SQSClient({ endpoint: cfg.endpoint, region: cfg.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const faulty = new SQSClient({ endpoint: cfg.endpoint, region: cfg.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  /** Faults of the client the consumer uses: a delete or a DLQ send that fails, as a crash before the ack would. */
  const faults = { deletes: 0, sendsToDlq: 0 };

  /** Holds every message before it reaches the real handler, so a test can stop the consumer mid-handling. */
  const gate = { open: Promise.resolve() as Promise<void> };
  const closeGate = () => {
    let release!: () => void;
    gate.open = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  };

  let orm: MikroORM;
  let flaky: FlakyUnitOfWork;
  let metrics: CountingMetrics;
  let consumer: SqsConsumer;
  let newConsumer: () => SqsConsumer;
  let handler: MessageHandler;
  let consumerOptions: ConstructorParameters<typeof SqsConsumer>[2];
  let walletId: string;
  let queueUrl: string;
  let dlqUrl: string;
  const queuesToDelete: string[] = [];
  let sequence = 0;

  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const count = async (table: string) => Number((await query<{ n: string }>(`select count(*) as n from ${table}`))[0]!.n);
  const balanceOf = async () => (await query<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;
  const statusOf = async (externalId: string) =>
    (await query<{ status: string }>('select status from wager_transactions where external_transaction_id = ?', [externalId]))[0]?.status;

  const messageBody = (messageId: string, externalId: string, amount = '30.00', data: Record<string, unknown> = {}) =>
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-1',
        externalTransactionId: externalId,
        idempotencyKey: `provider-1:${externalId}`,
        playerId: 'player-1',
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
        ...data,
      },
    });
  // FIFO drops a repeated deduplication id within five minutes, so a redelivery test needs a fresh one each time.
  const send = (body: string, groupId = walletId) =>
    sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: `d-${++sequence}-${crypto.randomUUID()}` }));

  const queueCounts = async (url: string) => {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
    );
    return { visible: Number(Attributes!.ApproximateNumberOfMessages), inFlight: Number(Attributes!.ApproximateNumberOfMessagesNotVisible) };
  };
  const receiveFromDlq = async (): Promise<Message[]> =>
    (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 1, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['MessageGroupId'] }))).Messages ?? [];
  /** Polls until `done` holds or the time is up: the emulator decides when a hidden message becomes visible again. */
  const pollUntil = async (done: () => Promise<boolean>, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await consumer.pollOnce();
      if (await done()) return;
      await sleep(200);
    }
    throw new Error('Condition not met in time');
  };

  beforeAll(async () => {
    orm = await initTestOrm();
    // `send` of the consumer's client goes through the fault switches above; every other command is untouched.
    const original = faulty.send.bind(faulty) as (command: unknown, ...rest: unknown[]) => Promise<unknown>;
    faulty.send = ((command: unknown, ...rest: unknown[]) => {
      if (command instanceof DeleteMessageCommand && faults.deletes > 0) {
        faults.deletes -= 1;
        return Promise.reject(new Error('process died before the ack'));
      }
      if (command instanceof SendMessageCommand && faults.sendsToDlq > 0) {
        faults.sendsToDlq -= 1;
        return Promise.reject(new Error('DLQ unavailable'));
      }
      return original(command, ...rest);
    }) as typeof faulty.send;
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    faults.deletes = 0;
    faults.sendsToDlq = 0;
    const uow = new MikroOrmUnitOfWork(orm.em);
    walletId = (
      await new CreateWallet({ unitOfWork: uow, now: () => new Date(), newId: () => crypto.randomUUID() }).execute({
        playerId: 'player-1',
        currency: 'BRL',
        initialAmount: '100.00',
      })
    ).id;

    // Throwaway queues per test; a 1 s visibility timeout so that a message left in flight returns quickly.
    const suffix = crypto.randomUUID().slice(0, 8);
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `consumer-test-dlq-${suffix}.fifo`, Attributes: dlqAttributes() }));
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }));
    const main = await sqs.send(
      new CreateQueueCommand({
        QueueName: `consumer-test-${suffix}.fifo`,
        Attributes: { ...mainQueueAttributes(Attributes!.QueueArn!, MAX_RECEIVE_COUNT), VisibilityTimeout: '1' },
      }),
    );
    dlqUrl = dlq.QueueUrl!;
    queueUrl = main.QueueUrl!;
    queuesToDelete.push(dlqUrl, queueUrl);

    flaky = new FlakyUnitOfWork(uow);
    gate.open = Promise.resolve();
    const real = new WagerMessageHandler(
      new ProcessWagerTransaction({ unitOfWork: flaky, now: () => new Date(), newId: () => crypto.randomUUID() }),
      { baseMs: 100, capMs: 1_000 },
    );
    handler = {
      handle: async (body, receiveCount) => {
        await gate.open;
        return real.handle(body, receiveCount);
      },
    };
    metrics = new CountingMetrics();
    consumerOptions = {
      enabled: false,
      queueName: `consumer-test-${suffix}.fifo`,
      dlqName: `consumer-test-dlq-${suffix}.fifo`,
      batchSize: 10,
      pollers: 1,
      waitTimeSeconds: 1,
      shutdownTimeoutMs: 500,
    };
    newConsumer = () => new SqsConsumer(faulty, handler, consumerOptions, metrics);
    consumer = newConsumer();
  });

  afterEach(async () => {
    await consumer.stop();
  });

  afterAll(async () => {
    await Promise.all(queuesToDelete.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined)));
  });

  it('processes a message through the use case and deletes it after the commit', async () => {
    await send(messageBody('msg-1', 'ext-1'));

    expect(await consumer.pollOnce()).toBe(1);

    expect(await balanceOf()).toBe('70.00');
    expect(await statusOf('ext-1')).toBe('PROCESSED');
    expect(await count('inbox_messages')).toBe(1);
    expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 0 });
    await assertLedgerMatchesBalance(orm, walletId);
  });

  it('a business rejection is final: stored, acknowledged, not retried', async () => {
    await send(messageBody('msg-1', 'ext-1', '500.00'));

    await consumer.pollOnce();

    expect(await statusOf('ext-1')).toBe('REJECTED');
    expect(await balanceOf()).toBe('100.00');
    expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 0 });
    expect(await queueCounts(dlqUrl)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('the same message delivered twice has one effect', async () => {
    const body = messageBody('msg-1', 'ext-1');
    await send(body);
    await send(body); // a redelivery from the producer's side: same messageId, new SQS message

    await pollUntil(async () => (await queueCounts(queueUrl)).visible + (await queueCounts(queueUrl)).inFlight === 0);

    expect(await balanceOf()).toBe('70.00');
    expect(await count('inbox_messages')).toBe(1);
    expect(await count('ledger_entries')).toBe(2); // opening credit + one debit
    await assertLedgerMatchesBalance(orm, walletId);
  });

  it('a crash after the commit and before the ack redelivers the message and changes nothing', async () => {
    faults.deletes = 1;
    await send(messageBody('msg-1', 'ext-1'));

    await consumer.pollOnce(); // committed; the delete "fails"
    expect(await balanceOf()).toBe('70.00');
    expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 1 });

    await pollUntil(async () => (await queueCounts(queueUrl)).visible + (await queueCounts(queueUrl)).inFlight === 0);

    expect(await balanceOf()).toBe('70.00');
    expect(await count('inbox_messages')).toBe(1);
    expect(await count('ledger_entries')).toBe(2);
    await assertLedgerMatchesBalance(orm, walletId);
  });

  it('a transient failure keeps the message; the retry processes it once', async () => {
    flaky.failures = 1;
    await send(messageBody('msg-1', 'ext-1'));

    await consumer.pollOnce();
    expect(await balanceOf()).toBe('100.00');
    expect(await count('inbox_messages')).toBe(0);
    expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 1 });

    expect(metrics.messageRetries).toBe(1);

    await pollUntil(async () => (await statusOf('ext-1')) === 'PROCESSED');

    expect(await balanceOf()).toBe('70.00');
    expect(await count('inbox_messages')).toBe(1);
    await pollUntil(async () => (await queueCounts(queueUrl)).inFlight === 0);
  });

  it('a message that keeps failing is moved to the DLQ after the receive limit', async () => {
    flaky.failures = 1_000;
    const body = messageBody('msg-1', 'ext-1');
    await send(body);

    await pollUntil(async () => (await queueCounts(dlqUrl)).visible === 1, 15_000);

    expect(await balanceOf()).toBe('100.00');
    expect(await count('inbox_messages')).toBe(0);
    expect((await receiveFromDlq())[0]?.Body).toBe(body);
  });

  describe('permanent errors go straight to the DLQ', () => {
    it('an unparseable body: sent with the reason, deleted at once, received only once', async () => {
      await send('{oops');

      await consumer.pollOnce();

      expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 0 });
      const [dead] = await receiveFromDlq();
      expect(dead?.Body).toBe('{oops');
      expect(dead?.MessageAttributes?.ErrorCode?.StringValue).toBe('InvalidMessageError');
      expect(dead?.MessageAttributes?.ErrorReason?.StringValue).toContain('not valid JSON');
      expect(dead?.Attributes?.MessageGroupId).toBe(walletId);
      expect(metrics.deadLettered).toBe(1);
      expect(metrics.messageRetries).toBe(0);
    });

    it('an unknown wallet: dead-lettered, nothing written', async () => {
      await send(messageBody('msg-1', 'ext-1', '30.00', { walletId: crypto.randomUUID() }));

      await consumer.pollOnce();

      expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 0 });
      expect((await receiveFromDlq())[0]?.MessageAttributes?.ErrorCode?.StringValue).toBe('WalletNotFoundError');
      expect(await count('inbox_messages')).toBe(0);
      expect(await count('wager_transactions')).toBe(1); // only the wallet's opening transaction
    });

    it('a message id reused with another payload: dead-lettered, balance untouched', async () => {
      await send(messageBody('msg-1', 'ext-1', '30.00'));
      await consumer.pollOnce();
      await send(messageBody('msg-1', 'ext-2', '50.00'));

      await consumer.pollOnce();

      expect(await balanceOf()).toBe('70.00');
      expect((await receiveFromDlq())[0]?.MessageAttributes?.ErrorCode?.StringValue).toBe('InboxPayloadConflictError');
    });

    it('if the DLQ send fails the message is left alone and comes back', async () => {
      faults.sendsToDlq = 1;
      await send('{oops');

      await consumer.pollOnce();
      expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 1 });
      expect(await queueCounts(dlqUrl)).toEqual({ visible: 0, inFlight: 0 });

      await pollUntil(async () => (await queueCounts(dlqUrl)).visible === 1); // the second attempt succeeds
      expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 0 });
    });
  });

  describe('ordering within a wallet', () => {
    it('applies messages of one wallet in order: 80.00 then 80.00 on 100.00', async () => {
      await send(messageBody('msg-1', 'ext-1', '80.00'));
      await send(messageBody('msg-2', 'ext-2', '80.00'));

      await pollUntil(async () => (await statusOf('ext-2')) !== undefined);

      expect(await statusOf('ext-1')).toBe('PROCESSED');
      expect(await statusOf('ext-2')).toBe('REJECTED');
      expect(await balanceOf()).toBe('20.00');
    });

    it('a failing message holds back the later ones of its wallet instead of letting them overtake', async () => {
      flaky.failures = 1;
      await send(messageBody('msg-1', 'ext-1', '80.00'));
      await send(messageBody('msg-2', 'ext-2', '80.00'));

      await consumer.pollOnce(); // msg-1 fails; msg-2 must not be applied before it
      expect(await statusOf('ext-2')).toBeUndefined();

      await pollUntil(async () => (await statusOf('ext-2')) !== undefined);

      expect(await statusOf('ext-1')).toBe('PROCESSED');
      expect(await statusOf('ext-2')).toBe('REJECTED');
      expect(await balanceOf()).toBe('20.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });
  });

  it('with the default batch size, a message behind a failing one keeps its receives and is not dead-lettered unprocessed (decision #67)', async () => {
    const { batchSize } = loadConfig().sqs.consumer;
    consumer = new SqsConsumer(faulty, handler, { ...consumerOptions, batchSize }, metrics);
    flaky.failures = MAX_RECEIVE_COUNT; // msg-1 fails on every receive the queue allows, then goes to the DLQ
    await send(messageBody('msg-1', 'ext-1', '10.00'));
    await send(messageBody('msg-2', 'ext-2', '10.00'));

    await pollUntil(async () => (await statusOf('ext-2')) !== undefined, 20_000);

    expect(await statusOf('ext-1')).toBeUndefined();
    expect(await statusOf('ext-2')).toBe('PROCESSED');
    expect(await balanceOf()).toBe('90.00');
  }, 30_000);

  it('keeps consuming in the background until stopped, and stop() returns promptly', async () => {
    consumer.start();
    await send(messageBody('msg-1', 'ext-1'));

    const deadline = Date.now() + 8_000;
    while ((await statusOf('ext-1')) !== 'PROCESSED' && Date.now() < deadline) await sleep(100);
    expect(await statusOf('ext-1')).toBe('PROCESSED');

    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  describe('shutdown', () => {
    it('lets the message being handled finish and hands back the ones not started', async () => {
      await send(messageBody('msg-1', 'ext-1', '10.00'));
      await send(messageBody('msg-2', 'ext-2', '10.00'));
      const open = closeGate();

      const polling = consumer.pollOnce(); // msg-1 waits at the gate, msg-2 behind it
      await sleep(300);
      const stopping = consumer.stop();
      open();
      await Promise.all([polling, stopping]);

      expect(await statusOf('ext-1')).toBe('PROCESSED');
      expect(await statusOf('ext-2')).toBeUndefined();
      // msg-1 is deleted, msg-2 is back in the queue at once (not hidden until its visibility timeout ends).
      expect(await queueCounts(queueUrl)).toEqual({ visible: 1, inFlight: 0 });
    });

    it('hands everything back when handling outlasts the shutdown timeout', async () => {
      await send(messageBody('msg-1', 'ext-1', '10.00'));
      const open = closeGate();

      const polling = consumer.pollOnce();
      await sleep(300);
      expect(await queueCounts(queueUrl)).toEqual({ visible: 0, inFlight: 1 });

      const started = Date.now();
      await consumer.stop(); // the gate never opens within the 500 ms timeout
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await queueCounts(queueUrl)).toEqual({ visible: 1, inFlight: 0 });
      expect(await statusOf('ext-1')).toBeUndefined();

      open(); // the abandoned handler may still finish; the cleanup below must tolerate it
      await polling;
    });

    it('a message that was handed back is processed once by the next consumer', async () => {
      await send(messageBody('msg-1', 'ext-1', '10.00'));
      const open = closeGate();
      const polling = consumer.pollOnce();
      await sleep(300);
      await consumer.stop();
      open();
      await polling; // the first consumer may commit it after handing it back

      consumer = newConsumer(); // the next instance
      await pollUntil(async () => (await queueCounts(queueUrl)).visible + (await queueCounts(queueUrl)).inFlight === 0);

      expect(await balanceOf()).toBe('90.00');
      expect(await count('inbox_messages')).toBe(1);
      await assertLedgerMatchesBalance(orm, walletId);
    });
  });
});
