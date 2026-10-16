import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/shared/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/transaction/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { initTestOrm, truncateAll } from '../support/database';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The two building blocks of decisions #25 and #26, tested on their own before any use case relies on them.
describe('concurrency primitives (real PostgreSQL)', () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;

  const newWallet = (playerId = 'p1', balance = '100.00') =>
    Wallet.open({ id: crypto.randomUUID(), playerId, initialBalance: brl(balance), now: NOW });

  const newBet = (walletId: string, idempotencyKey: string, externalTransactionId = `ext-${idempotencyKey}`) =>
    WagerTransaction.create({
      id: crypto.randomUUID(),
      providerId: 'provider-1',
      externalTransactionId,
      idempotencyKey,
      payloadHash: 'a'.repeat(64),
      walletId,
      playerId: 'p1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl('10.00'),
      referenceExternalTransactionId: undefined,
      createdAt: NOW,
    });

  beforeAll(async () => {
    orm = await initTestOrm();
    uow = new MikroOrmUnitOfWork(orm.em);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  describe('wallets.findByIdForUpdate', () => {
    it('makes a second locker wait for the first to commit, then shows it the committed balance', async () => {
      const wallet = newWallet();
      await uow.run((r) => r.wallets.insert(wallet));

      const events: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let firstHasLock!: () => void;
      const firstLocked = new Promise<void>((resolve) => (firstHasLock = resolve));

      const first = uow.run(async (r) => {
        const locked = (await r.wallets.findByIdForUpdate(wallet.id))!;
        firstHasLock();
        await held;
        locked.debit({ entryId: crypto.randomUUID(), transactionId: crypto.randomUUID(), money: brl('80.00'), now: NOW });
        await r.wallets.update(locked);
        events.push('first commits');
      });
      await firstLocked;

      const second = uow.run(async (r) => {
        events.push('second asks for the lock');
        const locked = (await r.wallets.findByIdForUpdate(wallet.id))!;
        events.push('second got the lock');
        return locked.balance.toJSON().amount;
      });

      await sleep(300); // long enough for the second to be waiting on the row lock
      expect(events).toEqual(['second asks for the lock']);
      release();
      await first;

      expect(await second).toBe('20.00');
      expect(events).toEqual(['second asks for the lock', 'first commits', 'second got the lock']);
    });

    it('does not block a lock on a different wallet', async () => {
      const a = newWallet('p1');
      const b = newWallet('p2');
      await uow.run(async (r) => {
        await r.wallets.insert(a);
        await r.wallets.insert(b);
      });

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let firstHasLock!: () => void;
      const firstLocked = new Promise<void>((resolve) => (firstHasLock = resolve));
      const first = uow.run(async (r) => {
        await r.wallets.findByIdForUpdate(a.id);
        firstHasLock();
        await held;
      });
      await firstLocked;

      const other = await Promise.race([
        uow.run((r) => r.wallets.findByIdForUpdate(b.id)).then(() => 'locked'),
        sleep(2000).then(() => 'blocked'),
      ]);
      release();
      await first;
      expect(other).toBe('locked');
    });

    it('returns undefined for an unknown wallet', async () => {
      expect(await uow.run((r) => r.wallets.findByIdForUpdate(crypto.randomUUID()))).toBeUndefined();
    });
  });

  describe('insertIfAbsent', () => {
    it('wallets: false on a duplicate player and currency, and the transaction stays usable', async () => {
      const result = await uow.run(async (r) => {
        const inserted = await r.wallets.insertIfAbsent(newWallet('p1'));
        const duplicate = await r.wallets.insertIfAbsent(newWallet('p1'));
        // A plain unique violation would have aborted the transaction; this read proves it did not.
        const found = await r.wallets.findByPlayerAndCurrency('p1', 'BRL');
        return { inserted, duplicate, found: found !== undefined };
      });
      expect(result).toEqual({ inserted: true, duplicate: false, found: true });
    });

    it('transactions: false on a duplicate idempotency key or provider transaction id, and the transaction stays usable', async () => {
      const wallet = newWallet();
      const result = await uow.run(async (r) => {
        await r.wallets.insert(wallet);
        const first = await r.transactions.insertIfAbsent(newBet(wallet.id, 'key-1', 'ext-1'));
        const sameKey = await r.transactions.insertIfAbsent(newBet(wallet.id, 'key-1', 'ext-2'));
        const sameExternalId = await r.transactions.insertIfAbsent(newBet(wallet.id, 'key-3', 'ext-1'));
        const found = await r.transactions.findByIdempotencyKey('key-1');
        return { first, sameKey, sameExternalId, found: found?.transaction.externalTransactionId };
      });
      expect(result).toEqual({ first: true, sameKey: false, sameExternalId: false, found: 'ext-1' });
    });

    it('transactions: exactly one of 20 concurrent inserts of the same key wins, and the rest can read the winner', async () => {
      const wallet = newWallet();
      await uow.run((r) => r.wallets.insert(wallet));

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          uow.run(async (r) => {
            const inserted = await r.transactions.insertIfAbsent(newBet(wallet.id, 'same-key', 'same-ext'));
            const stored = await r.transactions.findByIdempotencyKey('same-key');
            return { inserted, storedId: stored?.transaction.id };
          }),
        ),
      );

      expect(outcomes.filter((o) => o.inserted)).toHaveLength(1);
      // Every loser waited for the winner's commit and then saw the same stored row.
      expect(new Set(outcomes.map((o) => o.storedId)).size).toBe(1);
    });
  });
});
