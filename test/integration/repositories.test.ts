import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletVersionConflictError } from '../../src/application/wallet/wallet-version-conflict.error';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { Money } from '../../src/domain/shared/money';
import { FailureCode } from '../../src/domain/transaction/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/transaction/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { initTestOrm, truncateAll } from '../support/database';

const T0 = new Date('2026-10-16T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const id = () => crypto.randomUUID();

describe('repositories (real PostgreSQL)', () => {
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;

  const newWallet = (balance = '100.00', playerId = 'player-1') =>
    Wallet.open({ id: id(), playerId, initialBalance: brl(balance), now: T0 });

  const newBet = (walletId: string, amount = '80.00', overrides: Partial<{ idempotencyKey: string; externalTransactionId: string }> = {}) => {
    const txId = id();
    return WagerTransaction.create({
      id: txId,
      providerId: 'provider-1',
      externalTransactionId: overrides.externalTransactionId ?? `ext-${txId}`,
      idempotencyKey: overrides.idempotencyKey ?? `key-${txId}`,
      payloadHash: 'b'.repeat(64),
      walletId,
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl(amount),
      referenceExternalTransactionId: undefined,
      createdAt: T0,
    });
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
  });

  describe('wallets', () => {
    it('round-trips a wallet', async () => {
      const wallet = newWallet('123.45');
      await uow.run((r) => r.wallets.insert(wallet));

      const found = await uow.run((r) => r.wallets.findById(wallet.id));
      expect(found).toBeDefined();
      expect(found!.id).toBe(wallet.id);
      expect(found!.playerId).toBe('player-1');
      expect(found!.currency).toBe('BRL');
      expect(found!.balance.equals(brl('123.45'))).toBe(true);
      expect(found!.version).toBe(1);
      expect(found!.createdAt).toEqual(T0);
    });

    it('finds a wallet by player and currency, and returns undefined when absent', async () => {
      const wallet = newWallet();
      await uow.run((r) => r.wallets.insert(wallet));

      expect((await uow.run((r) => r.wallets.findByPlayerAndCurrency('player-1', 'BRL')))?.id).toBe(wallet.id);
      expect(await uow.run((r) => r.wallets.findByPlayerAndCurrency('player-1', 'USD'))).toBeUndefined();
      expect(await uow.run((r) => r.wallets.findById(id()))).toBeUndefined();
    });

    it('persists a balance change, version and updatedAt', async () => {
      const wallet = newWallet();
      await uow.run((r) => r.wallets.insert(wallet));
      wallet.debit({ entryId: id(), transactionId: id(), money: brl('30.00'), now: at(5) });
      await uow.run((r) => r.wallets.update(wallet, 1));

      const found = (await uow.run((r) => r.wallets.findById(wallet.id)))!;
      expect(found.balance.equals(brl('70.00'))).toBe(true);
      expect(found.version).toBe(2);
      expect(found.updatedAt).toEqual(at(5));
    });

    it('refuses to write a wallet whose stored version is not the one that was read, and changes nothing', async () => {
      const wallet = newWallet();
      await uow.run((r) => r.wallets.insert(wallet));
      wallet.debit({ entryId: id(), transactionId: id(), money: brl('30.00'), now: at(5) });

      await expect(uow.run((r) => r.wallets.update(wallet, 7))).rejects.toBeInstanceOf(WalletVersionConflictError);

      const found = (await uow.run((r) => r.wallets.findById(wallet.id)))!;
      expect(found.balance.equals(brl('100.00'))).toBe(true);
      expect(found.version).toBe(1);
    });

    it('surfaces the database refusing a second wallet for the same player and currency', async () => {
      await uow.run((r) => r.wallets.insert(newWallet()));
      await expect(uow.run((r) => r.wallets.insert(newWallet()))).rejects.toThrow(/wallets_player_currency_key/);
    });
  });

  describe('wager transactions', () => {
    let wallet: Wallet;

    beforeEach(async () => {
      wallet = newWallet();
      await uow.run((r) => r.wallets.insert(wallet));
    });

    it('round-trips a pending transaction without a balance', async () => {
      const bet = newBet(wallet.id);
      await uow.run((r) => r.transactions.insert(bet));

      const found = (await uow.run((r) => r.transactions.findById(bet.id)))!;
      expect(found.balanceAfter).toBeUndefined();
      const t = found.transaction;
      expect(t.status).toBe(bet.status);
      expect(t.kind).toBe(WagerTransactionKind.Bet);
      expect(t.money.equals(brl('80.00'))).toBe(true);
      expect(t.idempotencyKey).toBe(bet.idempotencyKey);
      expect(t.payloadHash).toBe('b'.repeat(64));
      expect(t.referenceExternalTransactionId).toBeUndefined();
      expect(t.processedAt).toBeUndefined();
    });

    it('finds by idempotency key and by provider and external id', async () => {
      const bet = newBet(wallet.id);
      await uow.run((r) => r.transactions.insert(bet));

      const byKey = await uow.run((r) => r.transactions.findByIdempotencyKey(bet.providerId, bet.idempotencyKey));
      const byExternal = await uow.run((r) =>
        r.transactions.findByProviderAndExternalId('provider-1', bet.externalTransactionId),
      );
      expect(byKey?.transaction.id).toBe(bet.id);
      expect(byExternal?.transaction.id).toBe(bet.id);
      expect(await uow.run((r) => r.transactions.findByIdempotencyKey('provider-1', 'nope'))).toBeUndefined();
    });

    it('persists a processed outcome with the observed balance', async () => {
      const bet = newBet(wallet.id);
      await uow.run((r) => r.transactions.insert(bet));
      bet.markProcessed(undefined, at(1));
      await uow.run((r) => r.transactions.update(bet, brl('20.00')));

      const found = (await uow.run((r) => r.transactions.findById(bet.id)))!;
      expect(found.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(found.transaction.processedAt).toEqual(at(1));
      expect(found.balanceAfter?.equals(brl('20.00'))).toBe(true);
    });

    it('persists a rejection with its failure code', async () => {
      const bet = newBet(wallet.id, '500.00');
      await uow.run((r) => r.transactions.insert(bet));
      bet.reject(FailureCode.InsufficientFunds, at(2));
      await uow.run((r) => r.transactions.update(bet, brl('100.00')));

      const found = (await uow.run((r) => r.transactions.findById(bet.id)))!;
      expect(found.transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(found.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(found.balanceAfter?.equals(brl('100.00'))).toBe(true);
    });

    it('surfaces the database refusing a repeated idempotency key', async () => {
      await uow.run((r) => r.transactions.insert(newBet(wallet.id, '10.00', { idempotencyKey: 'same' })));
      await expect(
        uow.run((r) => r.transactions.insert(newBet(wallet.id, '10.00', { idempotencyKey: 'same' }))),
      ).rejects.toThrow(/wager_transactions_provider_idempotency_key_key/);
    });
  });

  describe('ledger', () => {
    let wallet: Wallet;

    // Debits `count` times from the wallet and stores each transaction and entry.
    const seedEntries = async (count: number) => {
      const entries: WalletLedgerEntry[] = [];
      for (let i = 0; i < count; i++) {
        const bet = newBet(wallet.id, '10.00');
        const versionRead = wallet.version;
        const entry = wallet.debit({ entryId: id(), transactionId: bet.id, money: brl('10.00'), now: at(i) });
        bet.markProcessed(undefined, at(i));
        await uow.run(async (r) => {
          await r.transactions.insert(bet);
          await r.ledger.append(entry);
          await r.wallets.update(wallet, versionRead);
        });
        entries.push(entry);
      }
      return entries;
    };

    beforeEach(async () => {
      wallet = newWallet('100.00');
      await uow.run((r) => r.wallets.insert(wallet));
    });

    it('appends entries and returns them oldest first with typed money', async () => {
      const [first, second] = await seedEntries(2);
      const page = await uow.run((r) => r.ledger.page(wallet.id, { limit: 10 }));

      expect(page.map((e) => e.id)).toEqual([first!.id, second!.id]);
      expect(page[0]!.direction).toBe(LedgerDirection.Debit);
      expect(page[0]!.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(page[0]!.balanceAfter.equals(brl('90.00'))).toBe(true);
      expect(page[1]!.balanceAfter.equals(brl('80.00'))).toBe(true);
    });

    it('pages with a keyset cursor without gaps or repeats', async () => {
      const seeded = await seedEntries(5);
      const seen: string[] = [];
      let cursor: { createdAt: Date; id: string } | undefined;
      for (;;) {
        const page = await uow.run((r) => r.ledger.page(wallet.id, { after: cursor, limit: 2 }));
        if (page.length === 0) break;
        seen.push(...page.map((e) => e.id));
        const last = page.at(-1)!;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      expect(seen).toEqual(seeded.map((e) => e.id));
    });

    it('breaks ties on createdAt by id', async () => {
      const entries: WalletLedgerEntry[] = [];
      for (let i = 0; i < 3; i++) {
        const bet = newBet(wallet.id, '10.00');
        // Same instant for all three entries.
        entries.push(wallet.debit({ entryId: id(), transactionId: bet.id, money: brl('10.00'), now: T0 }));
        await uow.run(async (r) => {
          await r.transactions.insert(bet);
          await r.ledger.append(entries[i]!);
        });
      }
      const expected = entries.map((e) => e.id).sort();
      const page = await uow.run((r) => r.ledger.page(wallet.id, { limit: 10 }));
      expect(page.map((e) => e.id)).toEqual(expected);

      const afterFirst = await uow.run((r) =>
        r.ledger.page(wallet.id, { after: { createdAt: T0, id: expected[0]! }, limit: 10 }),
      );
      expect(afterFirst.map((e) => e.id)).toEqual(expected.slice(1));
    });

    it('returns an empty page for an unknown wallet', async () => {
      expect(await uow.run((r) => r.ledger.page(id(), { limit: 10 }))).toEqual([]);
    });
  });

  describe('unit of work', () => {
    it('commits every write together', async () => {
      const wallet = newWallet();
      const bet = newBet(wallet.id, '30.00');
      await uow.run(async (r) => {
        await r.wallets.insert(wallet);
        await r.transactions.insert(bet);
        await r.ledger.append(wallet.debit({ entryId: id(), transactionId: bet.id, money: brl('30.00'), now: at(1) }));
        await r.wallets.update(wallet, 1);
      });

      expect((await uow.run((r) => r.wallets.findById(wallet.id)))?.balance.equals(brl('70.00'))).toBe(true);
      expect(await uow.run((r) => r.ledger.page(wallet.id, { limit: 10 }))).toHaveLength(1);
    });

    it('rolls back every write when the work throws', async () => {
      const wallet = newWallet();
      await expect(
        uow.run(async (r) => {
          await r.wallets.insert(wallet);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await uow.run((r) => r.wallets.findById(wallet.id))).toBeUndefined();
    });

    it('rolls back earlier writes when a later one is refused by the database', async () => {
      const wallet = newWallet();
      await uow.run((r) => r.wallets.insert(wallet));
      const first = newBet(wallet.id, '10.00', { idempotencyKey: 'dup' });
      const second = newBet(wallet.id, '10.00', { idempotencyKey: 'dup' });

      await expect(
        uow.run(async (r) => {
          await r.transactions.insert(first);
          await r.transactions.insert(second);
        }),
      ).rejects.toThrow(/wager_transactions_provider_idempotency_key_key/);

      expect(await uow.run((r) => r.transactions.findById(first.id))).toBeUndefined();
    });
  });
  describe('inbox', () => {
    const receive = (messageId = 'msg-1', consumerName = 'wager-consumer') =>
      InboxMessage.receive({ messageId, consumerName, payloadHash: 'c'.repeat(64), receivedAt: T0 });

    it('round-trips a message and records when it was processed', async () => {
      const message = receive();
      await uow.run((r) => r.inbox.insert(message));

      const stored = (await uow.run((r) => r.inbox.find('wager-consumer', 'msg-1')))!;
      expect(stored.payloadHash).toBe('c'.repeat(64));
      expect(stored.receivedAt).toEqual(T0);
      expect(stored.isProcessed()).toBe(false);

      message.markProcessed(at(3));
      await uow.run((r) => r.inbox.update(message));
      const processed = (await uow.run((r) => r.inbox.find('wager-consumer', 'msg-1')))!;
      expect(processed.processedAt).toEqual(at(3));
    });

    it('returns undefined for an unknown message', async () => {
      expect(await uow.run((r) => r.inbox.find('wager-consumer', 'nope'))).toBeUndefined();
    });

    it('refuses the same message twice for one consumer, but not for another', async () => {
      await uow.run((r) => r.inbox.insert(receive()));
      await expect(uow.run((r) => r.inbox.insert(receive()))).rejects.toThrow(/inbox_messages_pkey/);
      await uow.run((r) => r.inbox.insert(receive('msg-1', 'other-consumer')));
    });

    it('is rolled back together with the business write', async () => {
      const wallet = newWallet();
      await expect(
        uow.run(async (r) => {
          await r.wallets.insert(wallet);
          await r.inbox.insert(receive());
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await uow.run((r) => r.inbox.find('wager-consumer', 'msg-1'))).toBeUndefined();
      expect(await uow.run((r) => r.wallets.findById(wallet.id))).toBeUndefined();
    });
  });

  describe('outbox', () => {
    // A real event, so the stored payload is what the publisher will send.
    const enqueue = (): OutboxMessage => {
      const wallet = newWallet();
      const entry = wallet.debit({ entryId: id(), transactionId: id(), money: brl('25.00'), now: at(1) });
      const event = WalletBalanceChanged.from(wallet, entry, {
        eventId: id(),
        correlationId: id(),
        occurredAt: at(1),
      });
      return OutboxMessage.enqueue(event);
    };

    it('round-trips a pending message with its JSON payload intact', async () => {
      const message = enqueue();
      await uow.run((r) => r.outbox.insert(message));

      const stored = (await uow.run((r) => r.outbox.findById(message.id)))!;
      expect(stored.eventType).toBe('WalletBalanceChanged');
      expect(stored.aggregateId).toBe(message.aggregateId);
      expect(stored.occurredAt).toEqual(at(1));
      expect(stored.payload).toEqual(message.payload);
      // Money stays a decimal string inside the JSON, never a number.
      expect(JSON.stringify(stored.payload)).toContain('"amount":"25.00"');
      expect(stored.isPending()).toBe(true);
      expect(stored.attempts).toBe(0);
    });

    it('persists a retry, then publication', async () => {
      const message = enqueue();
      await uow.run((r) => r.outbox.insert(message));

      message.scheduleRetry(at(10));
      await uow.run((r) => r.outbox.update(message));
      const retried = (await uow.run((r) => r.outbox.findById(message.id)))!;
      expect(retried.attempts).toBe(1);
      expect(retried.nextAttemptAt).toEqual(message.nextAttemptAt);
      expect(retried.isDue(at(10))).toBe(false);

      message.markPublished(at(20));
      await uow.run((r) => r.outbox.update(message));
      const published = (await uow.run((r) => r.outbox.findById(message.id)))!;
      expect(published.publishedAt).toEqual(at(20));
      expect(published.isPending()).toBe(false);
      expect(published.nextAttemptAt).toBeUndefined();
    });

    it('persists a parked message after too many failed attempts', async () => {
      const message = enqueue();
      await uow.run((r) => r.outbox.insert(message));
      for (let i = 0; i < 20; i++) message.scheduleRetry(at(100 + i));
      await uow.run((r) => r.outbox.update(message));

      const parked = (await uow.run((r) => r.outbox.findById(message.id)))!;
      expect(parked.isFailed()).toBe(true);
      expect(parked.attempts).toBe(20);
      expect(parked.isPending()).toBe(false);
    });

    it('exists only if the change it announces commits', async () => {
      const message = enqueue();
      await expect(
        uow.run(async (r) => {
          await r.outbox.insert(message);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await uow.run((r) => r.outbox.findById(message.id))).toBeUndefined();
    });
  });
});
