import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { IdempotencyConflictError } from '../../src/application/transaction/idempotency-conflict.error';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../src/application/transaction/process-wager-transaction';
import { UnsupportedKindError } from '../../src/application/transaction/unsupported-kind.error';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { WalletNotFoundError } from '../../src/application/wallet/wallet-not-found.error';
import { DomainError } from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/transaction/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { initTestOrm, truncateAll } from '../support/database';
import { assertLedgerMatchesBalance } from '../support/ledger';

describe('ProcessWagerTransaction (real PostgreSQL)', () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  let createWallet: CreateWallet;
  let process: ProcessWagerTransaction;

  const deps = (unitOfWork: UnitOfWork) => ({ unitOfWork, now: () => new Date(), newId: () => crypto.randomUUID() });
  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const count = async (table: string) => Number((await query<{ n: string }>(`select count(*) as n from ${table}`))[0]!.n);
  const eventTypes = async () =>
    (await query<{ event_type: string }>('select event_type from outbox_messages order by occurred_at, event_type')).map(
      (r) => r.event_type,
    );

  let walletId: string;
  let sequence = 0;
  const command = (overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand => {
    sequence += 1;
    return {
      idempotencyKey: `key-${sequence}`,
      providerId: 'provider-1',
      externalTransactionId: `ext-${sequence}`,
      playerId: 'player-1',
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
      ...overrides,
    };
  };
  const bet = (amount: string, overrides: Partial<ProcessWagerTransactionCommand> = {}) =>
    command({ money: { amount, currency: 'BRL' }, ...overrides });
  const balanceOf = async () => (await query<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;

  beforeAll(async () => {
    orm = await initTestOrm();
    uow = new MikroOrmUnitOfWork(orm.em);
    createWallet = new CreateWallet(deps(uow));
    process = new ProcessWagerTransaction(deps(uow));
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    const wallet = await createWallet.execute({ playerId: 'player-1', currency: 'BRL', initialAmount: '100.00' });
    walletId = wallet.id;
    await query('truncate outbox_messages'); // keep only the events of the transaction under test
  });

  describe('BET', () => {
    it('debits the wallet, writes one DEBIT entry, settles with the observed balance and queues two events', async () => {
      const result = await process.execute(bet('80.00'));

      expect(result.idempotentReplay).toBe(false);
      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balanceAfter?.toJSON().amount).toBe('20.00');
      expect(await balanceOf()).toBe('20.00');

      const [wallet] = await query<{ version: number }>('select version from wallets where id = ?', [walletId]);
      expect(wallet!.version).toBe(2);
      const entries = await query<Record<string, unknown>>(`select * from ledger_entries where direction = 'DEBIT'`);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        transaction_id: result.transaction.id,
        amount: '80.00',
        balance_before: '100.00',
        balance_after: '20.00',
      });
      const [stored] = await query<{ status: string; balance_after: string }>(
        'select status, balance_after from wager_transactions where id = ?',
        [result.transaction.id],
      );
      expect(stored).toEqual({ status: 'PROCESSED', balance_after: '20.00' });
      expect(await eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('allows a bet equal to the whole balance', async () => {
      const result = await process.execute(bet('100.00'));
      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(await balanceOf()).toBe('0.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('rejects a bet above the balance: persisted as REJECTED, no money moves, one rejection event', async () => {
      const result = await process.execute(bet('100.01'));

      expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(result.balanceAfter?.toJSON().amount).toBe('100.00');
      expect(await balanceOf()).toBe('100.00');
      const [wallet] = await query<{ version: number }>('select version from wallets where id = ?', [walletId]);
      expect(wallet!.version).toBe(1);
      expect(await eventTypes()).toEqual(['WagerTransactionRejected']);
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('rejects a currency different from the wallet currency', async () => {
      const result = await process.execute(command({ money: { amount: '10.00', currency: 'USD' } }));
      expect(result.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(await balanceOf()).toBe('100.00');
      expect(await count('ledger_entries')).toBe(1); // only the opening entry
      await assertLedgerMatchesBalance(orm, walletId);
    });
  });

  describe('WIN and LOSS', () => {
    it('WIN credits the wallet with one CREDIT entry', async () => {
      const result = await process.execute(bet('25.50', { kind: WagerTransactionKind.Win }));
      expect(result.balanceAfter?.toJSON().amount).toBe('125.50');
      expect(await balanceOf()).toBe('125.50');
      expect(await eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('WIN may carry a reference to its BET without blocking', async () => {
      const placed = await process.execute(bet('10.00'));
      const win = await process.execute(
        bet('30.00', {
          kind: WagerTransactionKind.Win,
          referenceExternalTransactionId: placed.transaction.externalTransactionId,
        }),
      );
      expect(win.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(await balanceOf()).toBe('120.00');
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('LOSS is processed without moving money: no entry, no version change, no balance event', async () => {
      const result = await process.execute(bet('0.00', { kind: WagerTransactionKind.Loss }));

      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balanceAfter?.toJSON().amount).toBe('100.00');
      expect(await count('ledger_entries')).toBe(1); // only the opening entry
      const [wallet] = await query<{ version: number }>('select version from wallets where id = ?', [walletId]);
      expect(wallet!.version).toBe(1);
      expect(await eventTypes()).toEqual(['WagerTransactionProcessed']);
      await assertLedgerMatchesBalance(orm, walletId);
    });
  });

  describe('idempotency', () => {
    it('replays the original result, including the balance observed then, without a second debit', async () => {
      const original = bet('30.00');
      const first = await process.execute(original);
      await process.execute(bet('20.00')); // balance moves on to 50.00

      const replay = await process.execute(original);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(first.transaction.id);
      expect(replay.balanceAfter?.toJSON().amount).toBe('70.00'); // not 50.00
      expect(await balanceOf()).toBe('50.00');
      expect(await count('ledger_entries')).toBe(3); // opening + two bets
      await assertLedgerMatchesBalance(orm, walletId);
    });

    it('replays a rejection as the same rejection, with no new events', async () => {
      const original = bet('500.00');
      const first = await process.execute(original);
      const eventsBefore = await eventTypes();

      const replay = await process.execute(original);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(first.transaction.id);
      expect(replay.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(await eventTypes()).toEqual(eventsBefore);
    });

    it('rejects the same key with a different payload as a conflict and changes nothing', async () => {
      const original = bet('30.00');
      await process.execute(original);

      await expect(process.execute({ ...original, money: { amount: '31.00', currency: 'BRL' } })).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
      expect(await balanceOf()).toBe('70.00');
      expect(await count('wager_transactions')).toBe(2); // opening + the first bet
    });

    it('treats the same provider transaction under a new key as a replay when the payload matches', async () => {
      const original = bet('30.00');
      const first = await process.execute(original);

      const replay = await process.execute({ ...original, idempotencyKey: 'another-key' });

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(first.transaction.id);
      expect(await balanceOf()).toBe('70.00');
    });

    it('treats the same provider transaction under a new key as a conflict when the payload differs', async () => {
      const original = bet('30.00');
      await process.execute(original);

      await expect(
        process.execute({ ...original, idempotencyKey: 'another-key', money: { amount: '99.00', currency: 'BRL' } }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await balanceOf()).toBe('70.00');
    });

    it('hashes "25.5" and "25.50" alike, so the amount spelling does not cause a conflict', async () => {
      const original = bet('25.5');
      await process.execute(original);
      const replay = await process.execute({ ...original, money: { amount: '25.50', currency: 'BRL' } });
      expect(replay.idempotentReplay).toBe(true);
    });
  });

  describe('invalid requests persist nothing', () => {
    const expectNothingStored = async () => {
      expect(await count('wager_transactions')).toBe(1); // the opening
      expect(await count('outbox_messages')).toBe(0);
      expect(await balanceOf()).toBe('100.00');
    };

    it('OPENING cannot be submitted from outside', async () => {
      await expect(process.execute(bet('10.00', { kind: WagerTransactionKind.Opening }))).rejects.toBeInstanceOf(DomainError);
      await expectNothingStored();
    });

    it('a BET carrying a reference is an invalid payload', async () => {
      await expect(process.execute(bet('10.00', { referenceExternalTransactionId: 'ext-x' }))).rejects.toBeInstanceOf(DomainError);
      await expectNothingStored();
    });

    it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('%s is not supported until M5', async (kind) => {
      await expect(
        process.execute(bet('10.00', { kind, referenceExternalTransactionId: 'ext-x' })),
      ).rejects.toBeInstanceOf(UnsupportedKindError);
      await expectNothingStored();
    });

    it('an unknown wallet is WalletNotFoundError', async () => {
      await expect(process.execute(bet('10.00', { walletId: crypto.randomUUID() }))).rejects.toBeInstanceOf(WalletNotFoundError);
      await expectNothingStored();
    });

    it('a player that does not own the wallet is an invalid payload', async () => {
      await expect(process.execute(bet('10.00', { playerId: 'someone-else' }))).rejects.toBeInstanceOf(DomainError);
      await expectNothingStored();
    });

    it.each(['10.001', '-5.00', 'abc', '0.00'])('amount %p is invalid for a BET', async (amount) => {
      await expect(process.execute(bet(amount))).rejects.toBeInstanceOf(DomainError);
      await expectNothingStored();
    });
  });

  describe('concurrent spam on one wallet', () => {
    it('serializes duplicates and distinct requests: no overdraft, no repeated debit, balance equals what was accepted', async () => {
      // Balance 100.00. Ten distinct 30.00 bets, each delivered 5 times at once (50 parallel calls), plus 10 WINs of 5.00.
      const bets = Array.from({ length: 10 }, () => bet('30.00'));
      const wins = Array.from({ length: 10 }, () => bet('5.00', { kind: WagerTransactionKind.Win }));
      const requests = [...bets, ...wins];
      const calls = requests.flatMap((request) => Array.from({ length: 5 }, () => process.execute(request)));

      const results = await Promise.all(calls);

      // Every delivery of the same request got the same transaction, and exactly one of them was not a replay.
      const byKey = new Map<string, typeof results>();
      for (const [index, result] of results.entries()) {
        const key = requests[Math.floor(index / 5)]!.idempotencyKey;
        byKey.set(key, [...(byKey.get(key) ?? []), result]);
      }
      for (const deliveries of byKey.values()) {
        expect(new Set(deliveries.map((d) => d.transaction.id)).size).toBe(1);
        expect(deliveries.filter((d) => !d.idempotentReplay)).toHaveLength(1);
        expect(new Set(deliveries.map((d) => d.transaction.status)).size).toBe(1);
      }

      // The final balance is exactly what the accepted requests add up to, and never went below zero.
      const settled = [...byKey.values()].map((deliveries) => deliveries[0]!);
      const net = settled.reduce((sum, r) => {
        if (r.transaction.status !== WagerTransactionStatus.Processed) return sum;
        const cents = Math.round(Number(r.transaction.money.toJSON().amount) * 100);
        return sum + (r.transaction.kind === WagerTransactionKind.Bet ? -cents : cents);
      }, 10_000);
      expect(net).toBeGreaterThanOrEqual(0);
      expect(await balanceOf()).toBe((net / 100).toFixed(2));

      // 100.00 can fund at most 3 bets up front, so some of the 10 bets must have been rejected for lack of funds
      // unless wins arrived first; either way every rejection is INSUFFICIENT_FUNDS and the ledger agrees.
      for (const r of settled) {
        if (r.transaction.status === WagerTransactionStatus.Rejected) {
          expect(r.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
        }
      }
      expect(await count('wager_transactions')).toBe(1 + requests.length);
      await assertLedgerMatchesBalance(orm, walletId);
    });
  });

  describe('atomicity', () => {
    it('rolls back the transaction row, the ledger entry and the balance when the outbox write fails', async () => {
      const failingOutbox: UnitOfWork = {
        run: (work) =>
          uow.run((repos: Repositories) =>
            work({
              ...repos,
              outbox: {
                ...repos.outbox,
                insert: () => Promise.reject(new Error('outbox unavailable')),
              },
            }),
          ),
      };
      const broken = new ProcessWagerTransaction(deps(failingOutbox));
      const request = bet('80.00');

      await expect(broken.execute(request)).rejects.toThrow('outbox unavailable');

      expect(await balanceOf()).toBe('100.00');
      expect(await count('wager_transactions')).toBe(1); // only the opening
      expect(await count('ledger_entries')).toBe(1);
      await assertLedgerMatchesBalance(orm, walletId);

      // Nothing was left behind, so the same request now succeeds as a first delivery, not as a replay.
      const retry = await process.execute(request);
      expect(retry.idempotentReplay).toBe(false);
    });
  });
});
