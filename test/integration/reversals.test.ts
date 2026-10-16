import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../src/application/transaction/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { FailureCode } from '../../src/domain/transaction/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { initTestOrm, truncateAll } from '../support/database';
import { assertLedgerMatchesBalance } from '../support/ledger';

describe('REFUND and ROLLBACK (real PostgreSQL)', () => {
  let orm: MikroORM;
  let createWallet: CreateWallet;
  let process: ProcessWagerTransaction;
  let walletId: string;
  let sequence = 0;

  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const balanceOf = async (id = walletId) =>
    (await query<{ balance: string }>('select balance from wallets where id = ?', [id]))[0]!.balance;
  const entryCount = async (id = walletId) =>
    Number((await query<{ n: string }>('select count(*) as n from ledger_entries where wallet_id = ?', [id]))[0]!.n);
  const eventTypes = async () =>
    (await query<{ event_type: string }>('select event_type from outbox_messages order by occurred_at, event_type')).map(
      (r) => r.event_type,
    );

  /** A command in the default wallet; every call gets a fresh key and external id. */
  const command = (
    kind: Kind,
    amount: string,
    overrides: Partial<ProcessWagerTransactionCommand> = {},
  ): ProcessWagerTransactionCommand => {
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
      ...overrides,
    };
  };
  /** Runs a transaction and returns its command (for use as a reference) and result. */
  const run = async (kind: Kind, amount: string, overrides: Partial<ProcessWagerTransactionCommand> = {}) => {
    const cmd = command(kind, amount, overrides);
    return { cmd, result: await process.execute(cmd) };
  };
  const reverse = (kind: Kind.Refund | Kind.Rollback, target: ProcessWagerTransactionCommand, amount?: string, o = {}) =>
    run(kind, amount ?? target.money.amount, { referenceExternalTransactionId: target.externalTransactionId, ...o });

  const expectRejected = (outcome: Awaited<ReturnType<typeof run>>, code: FailureCode) => {
    expect(outcome.result.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(outcome.result.transaction.failureCode).toBe(code);
  };

  beforeAll(async () => {
    orm = await initTestOrm();
    const deps = { unitOfWork: new MikroOrmUnitOfWork(orm.em), now: () => new Date(), newId: () => Bun.randomUUIDv7() };
    createWallet = new CreateWallet(deps);
    process = new ProcessWagerTransaction(deps);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    walletId = (await createWallet.execute({ playerId: 'player-1', currency: 'BRL', initialAmount: '100.00' })).id;
    await query('truncate outbox_messages');
  });

  describe('accepted reversals', () => {
    it('REFUND credits back a processed BET, links it to the BET and queues two events', async () => {
      const { cmd, result: betResult } = await run(Kind.Bet, '30.00');
      await query('truncate outbox_messages');

      const refund = await reverse(Kind.Refund, cmd);

      expect(refund.result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(refund.result.transaction.referenceTransactionId).toBe(betResult.transaction.id);
      expect(refund.result.balanceAfter?.toJSON().amount).toBe('100.00');
      expect(await balanceOf()).toBe('100.00');
      expect(await eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('ROLLBACK of a BET credits, of a WIN debits and of a REFUND debits', async () => {
      const bet = await run(Kind.Bet, '30.00'); // 70
      await reverse(Kind.Rollback, bet.cmd); // 100
      expect(await balanceOf()).toBe('100.00');

      const win = await run(Kind.Win, '50.00'); // 150
      await reverse(Kind.Rollback, win.cmd); // 100
      expect(await balanceOf()).toBe('100.00');

      const bet2 = await run(Kind.Bet, '20.00'); // 80
      const refund = await reverse(Kind.Refund, bet2.cmd); // 100
      await reverse(Kind.Rollback, refund.cmd); // 80
      expect(await balanceOf()).toBe('80.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('a replayed reversal returns the original result and balance', async () => {
      const { cmd } = await run(Kind.Bet, '30.00');
      const refund = command(Kind.Refund, '30.00', { referenceExternalTransactionId: cmd.externalTransactionId });
      const first = await process.execute(refund);
      await run(Kind.Bet, '10.00');

      const replay = await process.execute(refund);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.balanceAfter?.toJSON().amount).toBe(first.balanceAfter?.toJSON().amount);
      await assertLedgerMatchesBalance(orm, walletId);
    });
  });

  describe('a transaction is reversed at most once, by any kind (decision #36)', () => {
    it.each([
      [Kind.Refund, Kind.Refund],
      [Kind.Refund, Kind.Rollback],
      [Kind.Rollback, Kind.Refund],
      [Kind.Rollback, Kind.Rollback],
    ] as const)('%s then %s of the same BET: the second is ALREADY_REVERSED', async (first, second) => {
      const { cmd } = await run(Kind.Bet, '30.00');
      await reverse(first, cmd);
      const entries = await entryCount();

      const outcome = await reverse(second, cmd);

      expectRejected(outcome, FailureCode.AlreadyReversed);
      expect(await entryCount()).toBe(entries);
      expect(await balanceOf()).toBe('100.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('a rejected reversal does not block a later valid one', async () => {
      const { cmd } = await run(Kind.Bet, '30.00');
      expectRejected(await reverse(Kind.Refund, cmd, '29.00'), FailureCode.AmountMismatch);
      const valid = await reverse(Kind.Refund, cmd);
      expect(valid.result.transaction.status).toBe(WagerTransactionStatus.Processed);
    });
  });

  describe('rejections are final, persisted and move no money', () => {
    const expectNoMovement = async (before: number) => {
      expect(await entryCount()).toBe(before);
      await assertLedgerMatchesBalance(orm, walletId);
    };

    it('REVERSAL_WOULD_OVERDRAW: rolling back a WIN already spent', async () => {
      const win = await run(Kind.Win, '50.00'); // 150
      await run(Kind.Bet, '140.00'); // 10
      await query('truncate outbox_messages');
      const entries = await entryCount();

      const outcome = await reverse(Kind.Rollback, win.cmd);

      expectRejected(outcome, FailureCode.ReversalWouldOverdraw);
      expect(outcome.result.balanceAfter?.toJSON().amount).toBe('10.00');
      expect(await balanceOf()).toBe('10.00');
      expect(await eventTypes()).toEqual(['WagerTransactionRejected']);
      await expectNoMovement(entries);
    });

    it('a bet without funds keeps INSUFFICIENT_FUNDS, distinct from the reversal code', async () => {
      expectRejected(await run(Kind.Bet, '500.00'), FailureCode.InsufficientFunds);
    });

    it('does not reverse twice after an overdraw rejection: the WIN stays reversible once funds return', async () => {
      const win = await run(Kind.Win, '50.00');
      await run(Kind.Bet, '140.00');
      expectRejected(await reverse(Kind.Rollback, win.cmd), FailureCode.ReversalWouldOverdraw);
      await run(Kind.Win, '100.00'); // 110
      const retry = await reverse(Kind.Rollback, win.cmd);
      expect(retry.result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(await balanceOf()).toBe('60.00');
    });

    it('INVALID_REFERENCE_KIND: REFUND of a WIN or LOSS, ROLLBACK of a LOSS or of a ROLLBACK', async () => {
      const win = await run(Kind.Win, '10.00');
      const loss = await run(Kind.Loss, '10.00');
      const bet = await run(Kind.Bet, '10.00');
      const rollback = await reverse(Kind.Rollback, bet.cmd);
      const entries = await entryCount();

      expectRejected(await reverse(Kind.Refund, win.cmd), FailureCode.InvalidReferenceKind);
      expectRejected(await reverse(Kind.Refund, loss.cmd), FailureCode.InvalidReferenceKind);
      expectRejected(await reverse(Kind.Rollback, loss.cmd), FailureCode.InvalidReferenceKind);
      expectRejected(await reverse(Kind.Rollback, rollback.cmd), FailureCode.InvalidReferenceKind);
      await expectNoMovement(entries);
    });

    it('REFERENCE_MISMATCH: another round', async () => {
      const bet = await run(Kind.Bet, '10.00');
      const entries = await entryCount();
      expectRejected(await reverse(Kind.Refund, bet.cmd, undefined, { roundId: 'round-2' }), FailureCode.ReferenceMismatch);
      await expectNoMovement(entries);
    });

    it('REFERENCE_MISMATCH: a transaction of another wallet and player', async () => {
      const other = (await createWallet.execute({ playerId: 'player-2', currency: 'BRL', initialAmount: '100.00' })).id;
      const otherBet = await run(Kind.Bet, '10.00', { playerId: 'player-2', walletId: other });
      const entries = await entryCount();

      expectRejected(await reverse(Kind.Refund, otherBet.cmd), FailureCode.ReferenceMismatch);

      await expectNoMovement(entries);
      expect(await balanceOf(other)).toBe('90.00');
    });

    it('REFERENCE_MISMATCH: a reversal cannot reference itself', async () => {
      const cmd = command(Kind.Refund, '10.00');
      const outcome = await process.execute({ ...cmd, referenceExternalTransactionId: cmd.externalTransactionId });
      expect(outcome.transaction.failureCode).toBe(FailureCode.ReferenceMismatch);
    });

    it('REFERENCE_NOT_PROCESSED: the reference was rejected', async () => {
      const bet = await run(Kind.Bet, '500.00'); // rejected, insufficient funds
      const entries = await entryCount();
      expectRejected(await reverse(Kind.Refund, bet.cmd), FailureCode.ReferenceNotProcessed);
      await expectNoMovement(entries);
    });

    it('AMOUNT_MISMATCH: partial reversal is out of scope', async () => {
      const bet = await run(Kind.Bet, '30.00');
      const entries = await entryCount();
      expectRejected(await reverse(Kind.Refund, bet.cmd, '10.00'), FailureCode.AmountMismatch);
      await expectNoMovement(entries);
    });

    it('a rejected reversal is replayed unchanged', async () => {
      const bet = await run(Kind.Bet, '30.00');
      const cmd = command(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.cmd.externalTransactionId });
      const first = await process.execute(cmd);
      const replay = await process.execute(cmd);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.failureCode).toBe(first.transaction.failureCode);
    });
  });

  describe('concurrency', () => {
    it('REFUND and ROLLBACK of the same BET in parallel: exactly one is applied', async () => {
      for (let round = 0; round < 10; round += 1) {
        const bet = await run(Kind.Bet, '10.00');
        const outcomes = await Promise.all([reverse(Kind.Refund, bet.cmd), reverse(Kind.Rollback, bet.cmd)]);
        const processed = outcomes.filter((o) => o.result.transaction.status === WagerTransactionStatus.Processed);
        expect(processed).toHaveLength(1);
        expect(outcomes.find((o) => o !== processed[0])!.result.transaction.failureCode).toBe(FailureCode.AlreadyReversed);
      }
      expect(await balanceOf()).toBe('100.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('20 different refunds of one BET credit it once', async () => {
      const bet = await run(Kind.Bet, '40.00');
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => reverse(Kind.Refund, bet.cmd)));
      expect(outcomes.filter((o) => o.result.transaction.status === WagerTransactionStatus.Processed)).toHaveLength(1);
      expect(await balanceOf()).toBe('100.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });
  });
});
