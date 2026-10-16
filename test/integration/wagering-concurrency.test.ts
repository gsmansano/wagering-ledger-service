import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../src/application/transaction/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { FailureCode } from '../../src/domain/transaction/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/transaction/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { initTestOrm, truncateAll } from '../support/database';
import { assertLedgerMatchesBalance } from '../support/ledger';

// The mandatory concurrency scenarios of the specification (§8, §13): real parallelism, every call on its own
// connection, real PostgreSQL. The final invariant of every test is balance == balance rebuilt from the ledger.
describe('wagering concurrency (real PostgreSQL)', () => {
  let orm: MikroORM;
  let createWallet: CreateWallet;
  let processTransaction: ProcessWagerTransaction;

  const deps = (unitOfWork: UnitOfWork) => ({ unitOfWork, now: () => new Date(), newId: () => crypto.randomUUID() });
  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const balanceOf = async (walletId: string) =>
    (await query<{ balance: string }>('select balance from wallets where id = ?', [walletId]))[0]!.balance;
  const entriesOf = (walletId: string, direction: 'DEBIT' | 'CREDIT') =>
    query<{ amount: string }>('select amount from ledger_entries where wallet_id = ? and direction = ?', [walletId, direction]);

  const openWallet = (playerId: string, amount = '100.00') =>
    createWallet.execute({ playerId, currency: 'BRL', initialAmount: amount });

  let sequence = 0;
  const bet = (walletId: string, playerId: string, amount: string): ProcessWagerTransactionCommand => {
    sequence += 1;
    return {
      idempotencyKey: `key-${sequence}`,
      providerId: 'provider-1',
      externalTransactionId: `ext-${sequence}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount, currency: 'BRL' },
    };
  };

  beforeAll(async () => {
    orm = await initTestOrm();
    const uow = new MikroOrmUnitOfWork(orm.em);
    createWallet = new CreateWallet(deps(uow));
    processTransaction = new ProcessWagerTransaction(deps(uow));
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  it('the same BET sent 50 times in parallel debits once; 49 deliveries are replays of the same result', async () => {
    const wallet = await openWallet('p1');
    const request = bet(wallet.id, 'p1', '30.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => processTransaction.execute(request)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.balanceAfter?.toJSON().amount))).toEqual(new Set(['70.00']));
    expect(await balanceOf(wallet.id)).toBe('70.00');
    expect(await entriesOf(wallet.id, 'DEBIT')).toHaveLength(1);
    await assertLedgerMatchesBalance(orm, wallet.id);
  });

  it('two 80.00 bets racing for a 100.00 balance: one PROCESSED, one REJECTED, balance 20.00, one debit', async () => {
    const wallet = await openWallet('p1');
    const first = bet(wallet.id, 'p1', '80.00');
    const second = bet(wallet.id, 'p1', '80.00');

    const results = await Promise.all([processTransaction.execute(first), processTransaction.execute(second)]);

    const processed = results.filter((r) => r.transaction.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.transaction.status === WagerTransactionStatus.Rejected);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(await entriesOf(wallet.id, 'DEBIT')).toHaveLength(1);

    // A retry of either request changes nothing: no second debit, and the outcome stays the same.
    const retried = await Promise.all([processTransaction.execute(first), processTransaction.execute(second)]);
    expect(retried.every((r) => r.idempotentReplay)).toBe(true);
    expect(retried.map((r) => r.transaction.status)).toEqual(results.map((r) => r.transaction.status));
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(await entriesOf(wallet.id, 'DEBIT')).toHaveLength(1);
    await assertLedgerMatchesBalance(orm, wallet.id);
  });

  it('the 100.00 vs 2 x 80.00 race holds on 20 wallets at once', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => openWallet(`racer-${i}`)));

    const outcomes = await Promise.all(
      wallets.map((wallet, i) =>
        Promise.all([
          processTransaction.execute(bet(wallet.id, `racer-${i}`, '80.00')),
          processTransaction.execute(bet(wallet.id, `racer-${i}`, '80.00')),
        ]),
      ),
    );

    for (const [i, wallet] of wallets.entries()) {
      const statuses = outcomes[i]!.map((r) => r.transaction.status).sort();
      expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
      expect(await balanceOf(wallet.id)).toBe('20.00');
      expect(await entriesOf(wallet.id, 'DEBIT')).toHaveLength(1);
      await assertLedgerMatchesBalance(orm, wallet.id);
    }
  });

  it('different wallets are processed in parallel without interfering: 20 wallets x 5 bets of 10.00', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => openWallet(`parallel-${i}`)));

    const results = await Promise.all(
      wallets.flatMap((wallet, i) =>
        Array.from({ length: 5 }, () => processTransaction.execute(bet(wallet.id, `parallel-${i}`, '10.00'))),
      ),
    );

    expect(results.every((r) => r.transaction.status === WagerTransactionStatus.Processed)).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('50.00');
      expect(await entriesOf(wallet.id, 'DEBIT')).toHaveLength(5);
      await assertLedgerMatchesBalance(orm, wallet.id);
    }
  });

  it('many distinct bets on one wallet queue up: the balance is spent exactly and never goes negative', async () => {
    const wallet = await openWallet('p1', '100.00');

    const results = await Promise.all(Array.from({ length: 30 }, () => processTransaction.execute(bet(wallet.id, 'p1', '10.00'))));

    const processed = results.filter((r) => r.transaction.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.transaction.status === WagerTransactionStatus.Rejected);
    expect(processed).toHaveLength(10);
    expect(rejected).toHaveLength(20);
    expect(rejected.every((r) => r.transaction.failureCode === FailureCode.InsufficientFunds)).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    await assertLedgerMatchesBalance(orm, wallet.id);
  });
});
