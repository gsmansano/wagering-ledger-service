import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/wallet/create-wallet';
import { WalletAlreadyExistsError } from '../../src/application/wallet/wallet-already-exists.error';
import { DomainError } from '../../src/domain/shared/domain-error';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/repositories/mikro-orm-unit-of-work';
import { initTestOrm, truncateAll } from '../support/database';

const NOW = new Date('2026-10-16T12:00:00.000Z');

describe('CreateWallet (real PostgreSQL)', () => {
  let orm: MikroORM;
  let createWallet: CreateWallet;

  const query = <T>(sql: string, params: unknown[] = []) => orm.em.getConnection().execute<T[]>(sql, params);
  const count = async (table: string) => Number((await query<{ n: string }>(`select count(*) as n from ${table}`))[0]!.n);

  beforeAll(async () => {
    orm = await initTestOrm();
    createWallet = new CreateWallet({
      unitOfWork: new MikroOrmUnitOfWork(orm.em),
      now: () => NOW,
      newId: () => crypto.randomUUID(),
    });
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  it('opens a wallet with money: wallet, OPENING transaction, CREDIT entry and event together', async () => {
    const wallet = await createWallet.execute({ playerId: 'p1', currency: 'BRL', initialAmount: '1000.00' });

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);

    const [row] = await query<{ balance: string; version: number }>('select balance, version from wallets where id = ?', [wallet.id]);
    expect(row).toEqual({ balance: '1000.00', version: 1 });

    const [tx] = await query<Record<string, unknown>>('select * from wager_transactions');
    expect(tx).toMatchObject({
      wallet_id: wallet.id,
      kind: 'OPENING',
      status: 'PROCESSED',
      provider_id: 'SYSTEM',
      external_transaction_id: wallet.id,
      amount: '1000.00',
      balance_after: '1000.00',
    });

    const entries = await query<Record<string, unknown>>('select * from ledger_entries');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      wallet_id: wallet.id,
      transaction_id: tx!.id,
      direction: 'CREDIT',
      amount: '1000.00',
      balance_before: '0.00',
      balance_after: '1000.00',
    });

    const events = await query<{ event_type: string; aggregate_id: string; payload: { data: { walletVersion: number } } }>(
      'select event_type, aggregate_id, payload from outbox_messages',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'WalletBalanceChanged', aggregate_id: wallet.id });
    expect(events[0]!.payload.data.walletVersion).toBe(1);
  });

  it.each([[undefined], ['0'], ['0.00']])('opens an empty wallet without OPENING, ledger or event (initialAmount %p)', async (initialAmount) => {
    const wallet = await createWallet.execute({ playerId: 'p1', currency: 'BRL', initialAmount });

    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(await count('wallets')).toBe(1);
    expect(await count('wager_transactions')).toBe(0);
    expect(await count('ledger_entries')).toBe(0);
    expect(await count('outbox_messages')).toBe(0);
  });

  it('rejects a negative or malformed initial amount and persists nothing', async () => {
    for (const initialAmount of ['-5.00', '10.001', 'abc']) {
      await expect(createWallet.execute({ playerId: 'p1', currency: 'BRL', initialAmount })).rejects.toBeInstanceOf(DomainError);
    }
    await expect(createWallet.execute({ playerId: ' ', currency: 'BRL' })).rejects.toBeInstanceOf(DomainError);
    expect(await count('wallets')).toBe(0);
  });

  it('refuses a second wallet for the same player and currency and leaves the first untouched', async () => {
    const first = await createWallet.execute({ playerId: 'p1', currency: 'BRL', initialAmount: '50.00' });

    await expect(createWallet.execute({ playerId: 'p1', currency: 'BRL', initialAmount: '999.00' })).rejects.toBeInstanceOf(
      WalletAlreadyExistsError,
    );

    expect(await count('wallets')).toBe(1);
    expect(await count('ledger_entries')).toBe(1);
    expect(await count('outbox_messages')).toBe(1);
    const [row] = await query<{ id: string; balance: string }>('select id, balance from wallets');
    expect(row).toEqual({ id: first.id, balance: '50.00' });
  });

  it('allows the same player to hold wallets in different currencies', async () => {
    await createWallet.execute({ playerId: 'p1', currency: 'BRL', initialAmount: '10.00' });
    await createWallet.execute({ playerId: 'p1', currency: 'USD', initialAmount: '20.00' });
    expect(await count('wallets')).toBe(2);
    expect(await count('wager_transactions')).toBe(2);
  });

  it('creates exactly one wallet when the same player and currency race', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => createWallet.execute({ playerId: 'p1', currency: 'BRL', initialAmount: '100.00' })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => r.reason instanceof WalletAlreadyExistsError)).toBe(true);
    expect(await count('wallets')).toBe(1);
    expect(await count('wager_transactions')).toBe(1);
    expect(await count('ledger_entries')).toBe(1);
    expect(await count('outbox_messages')).toBe(1);
  });
});
