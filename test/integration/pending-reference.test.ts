import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../src/application/transaction/process-wager-transaction';
import type { ReferenceRetryPolicy } from '../../src/application/transaction/reference-retry-policy';
import {
  ResolveOutcome,
  ResolvePendingReference,
} from '../../src/application/transaction/resolve-pending-reference';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { FailureCode } from '../../src/domain/transaction/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { CountingMetrics } from '../support/counting-metrics';
import { initTestOrm, truncateAll } from '../support/database';
import { assertLedgerMatchesBalance } from '../support/ledger';

describe('PENDING_REFERENCE (real PostgreSQL)', () => {
  let orm: MikroORM;
  let createWallet: CreateWallet;
  let process: ProcessWagerTransaction;
  let resolve: ResolvePendingReference;
  let walletId: string;
  let sequence = 0;
  const policy: ReferenceRetryPolicy = { maxAttempts: 3, baseMs: 1_000, capMs: 300_000 };

  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const balanceOf = async () =>
    (await query<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;
  const entryCount = async () =>
    Number((await query<{ n: string }>('select count(*) as n from ledger_entries where wallet_id = ?', [walletId]))[0]!.n);
  const eventTypes = async () =>
    (await query<{ event_type: string }>('select event_type from outbox_messages order by occurred_at, event_type')).map(
      (r) => r.event_type,
    );
  const retryState = async (id: string) =>
    (
      await query<{ reference_attempts: number; reference_next_attempt_at: Date | string | null }>(
        'select reference_attempts, reference_next_attempt_at from wager_transactions where id = ?',
        [id],
      )
    )[0]!;

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
  const reversalOf = (kind: Kind.Refund | Kind.Rollback, externalId: string, amount: string, o = {}) =>
    command(kind, amount, { referenceExternalTransactionId: externalId, ...o });

  const metrics = new CountingMetrics();

  beforeAll(async () => {
    orm = await initTestOrm();
    const deps = {
      unitOfWork: new MikroOrmUnitOfWork(orm.em),
      now: () => new Date(),
      newId: () => Bun.randomUUIDv7(),
      referenceRetry: policy,
      metrics,
    };
    createWallet = new CreateWallet(deps);
    process = new ProcessWagerTransaction(deps);
    resolve = new ResolvePendingReference(deps);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    walletId = (await createWallet.execute({ playerId: 'player-1', currency: 'BRL', initialAmount: '100.00' })).id;
    await query('truncate outbox_messages');
  });

  describe('a reversal that arrives before its reference', () => {
    it('is stored as PENDING_REFERENCE: no money moves, one event, first retry due in about 1s', async () => {
      const before = Date.now();
      const { transaction, balanceAfter, idempotentReplay } = await process.execute(
        reversalOf(Kind.Refund, 'ext-bet', '30.00'),
      );

      expect(transaction.status).toBe(Status.PendingReference);
      expect(balanceAfter).toBeUndefined();
      expect(idempotentReplay).toBe(false);
      expect(await balanceOf()).toBe('100.00');
      expect(await entryCount()).toBe(1); // the opening only
      expect(await eventTypes()).toEqual(['WagerTransactionPendingReference']);

      const state = await retryState(transaction.id);
      expect(state.reference_attempts).toBe(0);
      const dueIn = new Date(state.reference_next_attempt_at!).getTime() - before;
      expect(dueIn).toBeGreaterThanOrEqual(900);
      expect(dueIn).toBeLessThan(3_000);
    });

    it('a replay of the pending reversal returns it still pending', async () => {
      const refund = reversalOf(Kind.Refund, 'ext-bet', '30.00');
      await process.execute(refund);
      const replay = await process.execute(refund);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.status).toBe(Status.PendingReference);
      expect(await eventTypes()).toEqual(['WagerTransactionPendingReference']); // not emitted twice
    });

    it('is applied by the next retry once the reference has been processed', async () => {
      const refund = await process.execute(reversalOf(Kind.Refund, 'ext-bet', '30.00'));
      await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' })); // 70
      await query('truncate outbox_messages');
      Object.assign(metrics, new CountingMetrics());

      const resolved = await resolve.execute(refund.transaction.id);

      expect(resolved.outcome).toBe(ResolveOutcome.Settled);
      expect(metrics.pendingAttempts).toBe(1);
      expect(metrics.statuses).toEqual(['REFUND:PROCESSED']);
      expect(resolved.transaction!.status).toBe(Status.Processed);
      expect(await balanceOf()).toBe('100.00');
      expect(await eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      const stored = await query<{ status: string; balance_after: string; reference_transaction_id: string }>(
        'select status, balance_after, reference_transaction_id from wager_transactions where id = ?',
        [refund.transaction.id],
      );
      expect(stored[0]!.status).toBe('PROCESSED');
      expect(stored[0]!.balance_after).toBe('100.00');
      expect(stored[0]!.reference_transaction_id).not.toBeNull();
      expect((await retryState(refund.transaction.id)).reference_next_attempt_at).toBeNull();
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('a replay after settlement returns the final result and balance', async () => {
      const cmd = reversalOf(Kind.Refund, 'ext-bet', '30.00');
      const pending = await process.execute(cmd);
      await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' }));
      await resolve.execute(pending.transaction.id);

      const replay = await process.execute(cmd);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.status).toBe(Status.Processed);
      expect(replay.balanceAfter?.toJSON().amount).toBe('100.00');
    });
  });

  describe('retries', () => {
    it('while the reference is still missing, a retry only counts and reschedules (2s after the first)', async () => {
      const pending = await process.execute(reversalOf(Kind.Refund, 'ext-bet', '30.00'));
      await query('truncate outbox_messages');
      Object.assign(metrics, new CountingMetrics());
      const before = Date.now();

      const resolved = await resolve.execute(pending.transaction.id);

      expect(resolved.outcome).toBe(ResolveOutcome.StillWaiting);
      expect(metrics.pendingAttempts).toBe(1);
      expect(metrics.statuses).toEqual([]); // still pending: no new status
      expect(resolved.transaction!.status).toBe(Status.PendingReference);
      const state = await retryState(pending.transaction.id);
      expect(state.reference_attempts).toBe(1);
      const dueIn = new Date(state.reference_next_attempt_at!).getTime() - before;
      expect(dueIn).toBeGreaterThanOrEqual(1_900);
      expect(dueIn).toBeLessThan(4_000);
      expect(await eventTypes()).toEqual([]);
    });

    it('after the last retry the reversal is REJECTED with REFERENCE_NOT_FOUND and the rejection is published', async () => {
      const cmd = reversalOf(Kind.Refund, 'ext-never', '30.00');
      const pending = await process.execute(cmd);
      await query('truncate outbox_messages');

      expect((await resolve.execute(pending.transaction.id)).outcome).toBe(ResolveOutcome.StillWaiting);
      expect((await resolve.execute(pending.transaction.id)).outcome).toBe(ResolveOutcome.StillWaiting);
      const last = await resolve.execute(pending.transaction.id);

      expect(last.outcome).toBe(ResolveOutcome.Settled);
      expect(last.transaction!.status).toBe(Status.Rejected);
      expect(last.transaction!.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(await eventTypes()).toEqual(['WagerTransactionRejected']);
      expect(await balanceOf()).toBe('100.00');
      expect(await entryCount()).toBe(1);
      expect((await resolve.execute(pending.transaction.id)).outcome).toBe(ResolveOutcome.NotPending);

      const replay = await process.execute(cmd);
      expect(replay.transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('a reference that arrives with the wrong kind rejects the reversal at once', async () => {
      const pending = await process.execute(reversalOf(Kind.Refund, 'ext-win', '30.00'));
      await process.execute(command(Kind.Win, '30.00', { externalTransactionId: 'ext-win' }));

      const resolved = await resolve.execute(pending.transaction.id);

      expect(resolved.outcome).toBe(ResolveOutcome.Settled);
      expect(resolved.transaction!.failureCode).toBe(FailureCode.InvalidReferenceKind);
    });

    it('a late ROLLBACK of a WIN that was spent meanwhile is rejected as REVERSAL_WOULD_OVERDRAW', async () => {
      const pending = await process.execute(reversalOf(Kind.Rollback, 'ext-win', '50.00'));
      await process.execute(command(Kind.Win, '50.00', { externalTransactionId: 'ext-win' })); // 150
      await process.execute(command(Kind.Bet, '140.00')); // 10

      const resolved = await resolve.execute(pending.transaction.id);

      expect(resolved.transaction!.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
      expect(await balanceOf()).toBe('10.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('an unknown or already settled transaction is NOT_PENDING', async () => {
      Object.assign(metrics, new CountingMetrics());
      expect((await resolve.execute(crypto.randomUUID())).outcome).toBe(ResolveOutcome.NotPending);
      const bet = await process.execute(command(Kind.Bet, '10.00'));
      expect((await resolve.execute(bet.transaction.id)).outcome).toBe(ResolveOutcome.NotPending);
      expect(metrics.pendingAttempts).toBe(0); // nothing was attempted
    });
  });

  describe('chains and competition', () => {
    it('a ROLLBACK of a REFUND that is itself pending waits, then resolves in order', async () => {
      const rollback = await process.execute(reversalOf(Kind.Rollback, 'ext-refund', '30.00'));
      const refund = await process.execute(
        reversalOf(Kind.Refund, 'ext-bet', '30.00', { externalTransactionId: 'ext-refund' }),
      );
      expect(rollback.transaction.status).toBe(Status.PendingReference);
      expect(refund.transaction.status).toBe(Status.PendingReference);

      // The REFUND is still in flight, so the ROLLBACK keeps waiting.
      expect((await resolve.execute(rollback.transaction.id)).outcome).toBe(ResolveOutcome.StillWaiting);

      await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' })); // 70
      expect((await resolve.execute(refund.transaction.id)).transaction!.status).toBe(Status.Processed); // 100
      expect((await resolve.execute(rollback.transaction.id)).transaction!.status).toBe(Status.Processed); // 70
      expect(await balanceOf()).toBe('70.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('two pending reversals of one BET: the first retried wins, the second is ALREADY_REVERSED', async () => {
      const refund = await process.execute(reversalOf(Kind.Refund, 'ext-bet', '30.00'));
      const rollback = await process.execute(reversalOf(Kind.Rollback, 'ext-bet', '30.00'));
      await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' }));

      expect((await resolve.execute(refund.transaction.id)).transaction!.status).toBe(Status.Processed);
      const second = await resolve.execute(rollback.transaction.id);

      expect(second.transaction!.failureCode).toBe(FailureCode.AlreadyReversed);
      expect(await balanceOf()).toBe('100.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('10 instances retrying the same pending reversal apply it once', async () => {
      const pending = await process.execute(reversalOf(Kind.Refund, 'ext-bet', '30.00'));
      await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' }));

      const results = await Promise.all(Array.from({ length: 10 }, () => resolve.execute(pending.transaction.id)));

      expect(results.filter((r) => r.outcome === ResolveOutcome.Settled)).toHaveLength(1);
      expect(results.filter((r) => r.outcome === ResolveOutcome.NotPending)).toHaveLength(9);
      expect(await balanceOf()).toBe('100.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('a retry racing with new bets on the same wallet keeps the ledger consistent', async () => {
      const pending = await process.execute(reversalOf(Kind.Refund, 'ext-bet', '30.00'));
      await process.execute(command(Kind.Bet, '30.00', { externalTransactionId: 'ext-bet' }));

      await Promise.all([
        resolve.execute(pending.transaction.id),
        ...Array.from({ length: 10 }, () => process.execute(command(Kind.Bet, '5.00'))),
      ]);

      expect(await balanceOf()).toBe('50.00'); // 100 - 30 + 30 - 10 * 5
      await assertLedgerMatchesBalance(orm, walletId);
    });
  });
});
