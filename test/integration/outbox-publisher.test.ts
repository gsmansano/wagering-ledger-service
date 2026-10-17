import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutbox, PublishOutcome } from '../../src/application/outbox/publish-outbox';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/transaction/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { loadConfig } from '../../src/config';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WagerTransactionKind } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { eventsQueueAttributes } from '../../src/infrastructure/messaging/queue-attributes';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { initTestOrm, truncateAll } from '../support/database';

const T0 = new Date('2026-10-17T12:00:00.000Z');

/** Records what it was asked to publish; can be told to refuse, or to hold a send until released. */
class FakePublisher implements EventPublisher {
  sent: OutboxMessage[] = [];
  failures = 0;
  gate: Promise<void> | undefined;

  async publish(message: OutboxMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('broker unavailable');
    }
    this.sent.push(message);
    await this.gate;
  }
  get ids(): string[] {
    return this.sent.map((m) => m.id);
  }
}

describe('PublishOutbox (real PostgreSQL)', () => {
  let orm: MikroORM;
  let uow: UnitOfWork;
  let publisher: FakePublisher;
  let clock: Date;
  let publishOutbox: PublishOutbox;

  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const build = (retry = { baseMs: 1_000, capMs: 300_000, maxAttempts: 3 }) =>
    new PublishOutbox({ unitOfWork: uow, publisher, now: () => clock, retry });

  /** Inserted in call order, which is what gives the rows their sequence. `occurredAt` is deliberately independent. */
  const enqueue = async (aggregateId: string, occurredAt = T0): Promise<string> => {
    const id = crypto.randomUUID();
    const message = OutboxMessage.rehydrate({
      id,
      aggregateId,
      eventType: 'WalletBalanceChanged',
      payload: { eventId: id, aggregateId },
      occurredAt,
      attempts: 0,
      nextAttemptAt: undefined,
      publishedAt: undefined,
      failedAt: undefined,
    });
    await uow.run((r) => r.outbox.insert(message));
    return id;
  };
  const stored = async (id: string) => (await uow.run((r) => r.outbox.findById(id)))!;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  /** Publishes until nothing is eligible; returns the outcomes in order. */
  const drain = async (): Promise<PublishOutcome[]> => {
    const outcomes: PublishOutcome[] = [];
    for (;;) {
      const result = await publishOutbox.publishNext();
      if (result === undefined) return outcomes;
      outcomes.push(result.outcome);
    }
  };

  beforeAll(async () => {
    orm = await initTestOrm();
    uow = new MikroOrmUnitOfWork(orm.em);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    publisher = new FakePublisher();
    clock = new Date(T0);
    publishOutbox = build();
  });

  describe('one publisher', () => {
    it('publishes a message once and marks it published', async () => {
      const w = crypto.randomUUID();
      const id = await enqueue(w);

      const result = await publishOutbox.publishNext();

      expect(result?.outcome).toBe(PublishOutcome.Published);
      expect(publisher.ids).toEqual([id]);
      const message = await stored(id);
      expect(message.publishedAt).toEqual(clock);
      expect(message.isPending()).toBe(false);
      expect(await publishOutbox.publishNext()).toBeUndefined();
      expect(publisher.ids).toEqual([id]);
    });

    it('answers undefined when the outbox is empty', async () => {
      expect(await publishOutbox.publishNext()).toBeUndefined();
    });

    it('commits a refused attempt, so the retry is counted and waits for its backoff', async () => {
      const id = await enqueue(crypto.randomUUID());
      publisher.failures = 1;

      const result = await publishOutbox.publishNext();

      expect(result?.outcome).toBe(PublishOutcome.Retried);
      expect((result?.error as Error).message).toBe('broker unavailable');
      const message = await stored(id);
      expect(message.attempts).toBe(1);
      expect(message.nextAttemptAt).toEqual(new Date(T0.getTime() + 1_000));

      // Not due yet: nothing to do. Once the backoff has passed it is published.
      expect(await publishOutbox.publishNext()).toBeUndefined();
      advance(1_000);
      expect((await publishOutbox.publishNext())?.outcome).toBe(PublishOutcome.Published);
      expect(publisher.ids).toEqual([id]);
    });

    it('parks the message at the attempt limit and stops trying', async () => {
      const id = await enqueue(crypto.randomUUID());
      publisher.failures = 10;

      const outcomes: PublishOutcome[] = [];
      for (let i = 0; i < 3; i++) {
        outcomes.push((await publishOutbox.publishNext())!.outcome);
        advance(10_000);
      }

      expect(outcomes).toEqual([PublishOutcome.Retried, PublishOutcome.Retried, PublishOutcome.Parked]);
      const message = await stored(id);
      expect(message.isFailed()).toBe(true);
      expect(message.attempts).toBe(3);
      advance(86_400_000);
      expect(await publishOutbox.publishNext()).toBeUndefined();
    });
  });

  describe('order within a wallet (decisions #58 and #59)', () => {
    it('publishes a wallet in insertion order even when occurred_at says otherwise', async () => {
      const w = crypto.randomUUID();
      const first = await enqueue(w, new Date(T0.getTime() + 2_000));
      const second = await enqueue(w, new Date(T0.getTime() + 1_000));
      const third = await enqueue(w, T0);

      expect(await drain()).toEqual([PublishOutcome.Published, PublishOutcome.Published, PublishOutcome.Published]);
      expect(publisher.ids).toEqual([first, second, third]);
    });

    it('holds back the later events of a wallet while its first event waits for the backoff, and not other wallets', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const a1 = await enqueue(a);
      const a2 = await enqueue(a);
      const b1 = await enqueue(b);
      publisher.failures = 1; // the first send, a1

      expect((await publishOutbox.publishNext())!.outcome).toBe(PublishOutcome.Retried);
      expect(await drain()).toEqual([PublishOutcome.Published]);
      expect(publisher.ids).toEqual([b1]);

      advance(1_000);
      expect(await drain()).toEqual([PublishOutcome.Published, PublishOutcome.Published]);
      expect(publisher.ids).toEqual([b1, a1, a2]);
    });

    it('a parked event blocks its wallet until it is requeued, while other wallets carry on', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const a1 = await enqueue(a);
      const a2 = await enqueue(a);
      const a3 = await enqueue(a);
      const b1 = await enqueue(b);
      const b2 = await enqueue(b);
      publisher.failures = 3; // a1 on all three attempts

      for (let i = 0; i < 3; i++) {
        await publishOutbox.publishNext();
        advance(10_000);
      }
      expect((await stored(a1)).isFailed()).toBe(true);

      expect(await drain()).toEqual([PublishOutcome.Published, PublishOutcome.Published]);
      expect(publisher.ids).toEqual([b1, b2]);
      advance(86_400_000);
      expect(await drain()).toEqual([]); // a2 and a3 stay behind the parked a1

      await uow.run(async (r) => {
        const parked = (await r.outbox.findById(a1))!;
        parked.requeue();
        await r.outbox.update(parked);
      });

      expect(await drain()).toEqual([PublishOutcome.Published, PublishOutcome.Published, PublishOutcome.Published]);
      expect(publisher.ids).toEqual([b1, b2, a1, a2, a3]);
    });

    it('follows the order the wallet lock applied the changes in, under concurrent requests', async () => {
      const deps = { unitOfWork: uow, now: () => new Date(), newId: () => crypto.randomUUID() };
      const wallet = await new CreateWallet(deps).execute({ playerId: 'p1', currency: 'BRL', initialAmount: '1000.00' });
      const process = new ProcessWagerTransaction(deps);

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          process.execute({
            idempotencyKey: `key-${i}`,
            providerId: 'provider-1',
            externalTransactionId: `ext-${i}`,
            playerId: 'p1',
            walletId: wallet.id,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: i % 2 === 0 ? WagerTransactionKind.Bet : WagerTransactionKind.Win,
            money: { amount: `${i + 1}.00`, currency: 'BRL' },
          }),
        ),
      );

      // The wallet's balance changes, read in ledger order, must appear in the same order in the outbox.
      const ledger = await query<{ transaction_id: string }>(
        'select transaction_id from ledger_entries where wallet_id = ? order by sequence',
        [wallet.id],
      );
      const events = await query<{ transaction_id: string }>(
        `select payload->'data'->>'transactionId' as transaction_id from outbox_messages
          where aggregate_id = ? and event_type = 'WalletBalanceChanged' order by sequence`,
        [wallet.id],
      );
      expect(events.map((e) => e.transaction_id)).toEqual(ledger.map((l) => l.transaction_id));
      expect(ledger).toHaveLength(21); // the opening entry and 20 requests
    });
  });

  describe('concurrent publishers', () => {
    it('a message held by one publisher is skipped by another, and holds back its wallet', async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const a1 = await enqueue(a);
      const a2 = await enqueue(a);
      const b1 = await enqueue(b);

      // Publisher one claims a1 and is stuck inside the broker call, its transaction open.
      let release!: () => void;
      publisher.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stuck = publishOutbox.publishNext();
      while (publisher.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

      // Publisher two neither waits for it nor takes a2 (a1 is still unpublished); it publishes b1 and finds nothing else.
      publisher.gate = undefined;
      const other = build();
      expect((await other.publishNext())!.message.id).toBe(b1);
      expect(await other.publishNext()).toBeUndefined();

      release();
      expect((await stuck)!.outcome).toBe(PublishOutcome.Published);
      expect((await other.publishNext())!.message.id).toBe(a2);
      expect(publisher.ids).toEqual([a1, b1, a2]);
    });

    it('many publishers draining one outbox publish every message once, in order per wallet', async () => {
      const wallets = Array.from({ length: 6 }, () => crypto.randomUUID());
      const expectedByWallet = new Map<string, string[]>();
      for (let round = 0; round < 8; round++) {
        for (const w of wallets) {
          const id = await enqueue(w);
          expectedByWallet.set(w, [...(expectedByWallet.get(w) ?? []), id]);
        }
      }

      const workers = Array.from({ length: 5 }, async () => {
        const publishers = build();
        // Several rounds, since a publisher that finds nothing eligible while others hold rows must look again.
        for (let i = 0; i < 40; i++) {
          while ((await publishers.publishNext()) !== undefined);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      await Promise.all(workers);

      expect(new Set(publisher.ids).size).toBe(48);
      expect(publisher.ids).toHaveLength(48);
      for (const [w, expected] of expectedByWallet) {
        expect(publisher.sent.filter((m) => m.aggregateId === w).map((m) => m.id)).toEqual(expected);
      }
      expect(Number((await query<{ n: string }>('select count(*) as n from outbox_messages where published_at is null'))[0]!.n)).toBe(0);
    });
  });

  describe('crash between the send and the commit', () => {
    it('leaves the message unpublished, and the next publisher sends it again with the same event id', async () => {
      const id = await enqueue(crypto.randomUUID());
      // Runs the work (including the send), then dies before the transaction can commit.
      const crashing: UnitOfWork = {
        run: <T>(work: (repositories: Repositories) => Promise<T>) =>
          uow.run(async (repos) => {
            await work(repos);
            throw new Error('process died before the commit');
          }),
      };
      const doomed = new PublishOutbox({ unitOfWork: crashing, publisher, now: () => clock });
      await expect(doomed.publishNext()).rejects.toThrow('process died');
      expect((await stored(id)).isPending()).toBe(true);

      expect((await publishOutbox.publishNext())!.outcome).toBe(PublishOutcome.Published);

      // At-least-once: the broker saw it twice, under one event id, which is what consumers deduplicate on.
      expect(publisher.ids).toEqual([id, id]);
      expect((await stored(id)).isPending()).toBe(false);
    });
  });
});

describe('SqsEventPublisher (MiniStack)', () => {
  const { sqs: cfg } = loadConfig();
  const sqs = new SQSClient({ endpoint: cfg.endpoint, region: cfg.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const queueName = `test-events-${crypto.randomUUID().slice(0, 8)}.fifo`;
  let queueUrl: string;

  beforeAll(async () => {
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: eventsQueueAttributes() }))).QueueUrl!;
  });

  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  });

  const receiveAll = async () => {
    const received = [];
    for (let i = 0; i < 3; i++) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['MessageGroupId'],
        }),
      );
      received.push(...(Messages ?? []));
    }
    return received;
  };

  it('sends the envelope with the wallet as group, the event type as attribute, and drops a repeated event id', async () => {
    const wallet = crypto.randomUUID();
    const id = crypto.randomUUID();
    const message = OutboxMessage.rehydrate({
      id,
      aggregateId: wallet,
      eventType: 'WalletBalanceChanged',
      payload: { eventId: id, aggregateId: wallet, data: { walletVersion: 2 } },
      occurredAt: T0,
      attempts: 0,
      nextAttemptAt: undefined,
      publishedAt: undefined,
      failedAt: undefined,
    });
    const publisher = new SqsEventPublisher(sqs, queueName);

    await publisher.publish(message);
    await publisher.publish(message); // a retry after a crash: same event id

    const received = await receiveAll();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.Body!)).toEqual(message.payload as Record<string, unknown>);
    expect(received[0]!.Attributes?.MessageGroupId).toBe(wallet);
    expect(received[0]!.MessageAttributes?.EventType?.StringValue).toBe('WalletBalanceChanged');
  });

  it('fails the attempt when the queue does not exist, so the outbox retries', async () => {
    const publisher = new SqsEventPublisher(sqs, 'no-such-queue.fifo');
    const message = OutboxMessage.rehydrate({
      id: crypto.randomUUID(), aggregateId: crypto.randomUUID(), eventType: 'X', payload: {}, occurredAt: T0,
      attempts: 0, nextAttemptAt: undefined, publishedAt: undefined, failedAt: undefined,
    });
    await expect(publisher.publish(message)).rejects.toThrow();
  });
});
