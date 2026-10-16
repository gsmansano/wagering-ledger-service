import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../src/application/transaction/process-wager-transaction';
import type { ReferenceRetryPolicy } from '../../src/application/transaction/reference-retry-policy';
import { ResolvePendingReference } from '../../src/application/transaction/resolve-pending-reference';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { FailureCode } from '../../src/domain/transaction/failure-code';
import { WagerTransactionKind as Kind } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { PendingReferenceWorker } from '../../src/infrastructure/workers/pending-reference.worker';
import { initTestOrm, truncateAll } from '../support/database';
import { assertLedgerMatchesBalance } from '../support/ledger';

describe('pending-reference worker (real PostgreSQL)', () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  let createWallet: CreateWallet;
  let process: ProcessWagerTransaction;
  let resolve: ResolvePendingReference;
  let walletId: string;
  let sequence = 0;
  const policy: ReferenceRetryPolicy = { maxAttempts: 3, baseMs: 1_000, capMs: 300_000 };

  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const balanceOf = async () =>
    (await query<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;
  const statusOf = async (id: string) =>
    (await query<{ status: string; failure_code: string | null; reference_attempts: number }>(
      'select status, failure_code, reference_attempts from wager_transactions where id = ?',
      [id],
    ))[0]!;
  /** Makes every pending retry due now (the real delays are seconds; tests do not wait for them). */
  const makeAllDue = () =>
    query(`update wager_transactions set reference_next_attempt_at = now() - interval '1 second' where status = 'PENDING_REFERENCE'`);
  const makeWorker = (options = {}) =>
    new PendingReferenceWorker(resolve, { enabled: true, pollIntervalMs: 20, batchSize: 50, ...options });

  const command = (kind: Kind, amount: string, o: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand => {
    sequence += 1;
    return {
      idempotencyKey: `key-${sequence}`,
      providerId: 'provider-1',
      externalTransactionId: `ext-${sequence}`,
      playerId: 'player-1',
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
      ...o,
    };
  };
  const refundOf = (externalId: string, amount: string) =>
    command(Kind.Refund, amount, { referenceExternalTransactionId: externalId });

  beforeAll(async () => {
    orm = await initTestOrm();
    uow = new MikroOrmUnitOfWork(orm.em);
    const deps = { unitOfWork: uow, now: () => new Date(), newId: () => Bun.randomUUIDv7(), referenceRetry: policy };
    createWallet = new CreateWallet(deps);
    process = new ProcessWagerTransaction(deps);
    resolve = new ResolvePendingReference(deps);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    walletId = (await createWallet.execute({ playerId: 'player-1', currency: 'BRL', initialAmount: '1000.00' })).id;
    await query('truncate outbox_messages');
  });

  it('retries only what is due', async () => {
    const waiting = await process.execute(refundOf('ext-late', '10.00'));
    const worker = makeWorker();

    expect(await worker.tick()).toBe(0); // first retry is due in 1s, not yet
    expect((await statusOf(waiting.transaction.id)).reference_attempts).toBe(0);

    await makeAllDue();
    expect(await worker.tick()).toBe(1);
    expect((await statusOf(waiting.transaction.id)).reference_attempts).toBe(1); // still waiting, rescheduled
    expect(await worker.tick()).toBe(0); // rescheduled for the future
  });

  it('applies a reversal once its reference has been processed', async () => {
    const pending = await process.execute(refundOf('ext-bet', '30.00'));
    await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' }));
    await makeAllDue();

    await makeWorker().tick();

    expect((await statusOf(pending.transaction.id)).status).toBe('PROCESSED');
    expect(await balanceOf()).toBe('1000.00');
    await assertLedgerMatchesBalance(orm, walletId);
  });

  it('rejects with REFERENCE_NOT_FOUND after the last retry', async () => {
    const pending = await process.execute(refundOf('ext-never', '30.00'));
    const worker = makeWorker();

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      await makeAllDue();
      expect(await worker.tick()).toBe(1);
    }

    const state = await statusOf(pending.transaction.id);
    expect(state.status).toBe('REJECTED');
    expect(state.failure_code).toBe(FailureCode.ReferenceNotFound);
    await makeAllDue();
    expect(await worker.tick()).toBe(0);
    expect(await balanceOf()).toBe('1000.00');
  });

  it('a batch limit bounds one poll', async () => {
    for (let i = 0; i < 5; i += 1) await process.execute(refundOf(`ext-late-${i}`, '1.00'));
    await makeAllDue();
    expect(await makeWorker({ batchSize: 2 }).tick()).toBe(2);
  });

  it('several workers over the same rows handle each one exactly once', async () => {
    const count = 12;
    const pending = [];
    for (let i = 0; i < count; i += 1) pending.push(await process.execute(refundOf(`ext-bet-${i}`, '5.00')));
    for (let i = 0; i < count; i += 1) {
      await process.execute(command(Kind.Bet, '5.00', { externalTransactionId: `ext-bet-${i}` }));
    }
    await makeAllDue();

    const handled = await Promise.all(Array.from({ length: 5 }, () => makeWorker().tick()));

    expect(handled.reduce((a, b) => a + b, 0)).toBe(count);
    for (const p of pending) {
      const state = await statusOf(p.transaction.id);
      expect(state.status).toBe('PROCESSED');
      expect(state.reference_attempts).toBe(1); // picked once
    }
    expect(await balanceOf()).toBe('1000.00');
    await assertLedgerMatchesBalance(orm, walletId);
  }, 30_000);

  it('SKIP LOCKED: an instance neither waits for nor takes a row another instance holds', async () => {
    const a = await process.execute(refundOf('ext-a', '1.00'));
    const b = await process.execute(refundOf('ext-b', '1.00'));
    await makeAllDue();

    /** Claims the next due row in its own SQL transaction and keeps it locked until released. */
    const hold = async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let claimed!: (id: string | undefined) => void;
      const result = new Promise<string | undefined>((r) => (claimed = r));
      const done = uow.run(async (repos) => {
        claimed(await repos.transactions.lockNextDuePendingReference(new Date()));
        await gate;
      });
      return { id: await result, release: () => { release(); return done; } };
    };

    const first = await hold();
    const second = await hold();
    const started = Date.now();
    const third = await uow.run((repos) => repos.transactions.lockNextDuePendingReference(new Date()));
    const waited = Date.now() - started;
    await Promise.all([first.release(), second.release()]);

    expect([first.id, second.id].sort()).toEqual([a.transaction.id, b.transaction.id].sort());
    expect(third).toBeUndefined();
    expect(waited).toBeLessThan(1_000); // returned at once instead of blocking on the held rows
  });

  it('a worker does not retry a row held by an in-flight retry of the same transaction', async () => {
    const pending = await process.execute(refundOf('ext-bet', '30.00'));
    await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' }));
    await makeAllDue();

    const results = await Promise.all([resolve.execute(pending.transaction.id), makeWorker().tick(), makeWorker().tick()]);

    expect(results[0].transaction).toBeDefined();
    expect((await statusOf(pending.transaction.id)).status).toBe('PROCESSED');
    expect(await balanceOf()).toBe('1000.00');
    await assertLedgerMatchesBalance(orm, walletId);
  });

  it('the running worker settles a late reference on its own and stops cleanly', async () => {
    const pending = await process.execute(refundOf('ext-bet', '30.00'));
    await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' }));
    await makeAllDue();
    const worker = makeWorker();

    worker.start();
    const deadline = Date.now() + 5_000;
    while ((await statusOf(pending.transaction.id)).status !== 'PROCESSED' && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    await worker.stop();

    expect((await statusOf(pending.transaction.id)).status).toBe('PROCESSED');
    await assertLedgerMatchesBalance(orm, walletId);
  });

  it('a poll that fails does not stop the loop', async () => {
    let calls = 0;
    const flaky = {
      executeNextDue: async () => {
        calls += 1;
        if (calls === 1) throw new Error('database unavailable');
        return undefined;
      },
    } as unknown as ResolvePendingReference; // test double: only executeNextDue is used by the worker
    const worker = new PendingReferenceWorker(flaky, { enabled: true, pollIntervalMs: 10, batchSize: 5 });

    worker.start();
    await Bun.sleep(200);
    await worker.stop();

    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
