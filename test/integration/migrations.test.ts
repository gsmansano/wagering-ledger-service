import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initTestOrm } from '../support/database';

describe('migrations (real PostgreSQL)', () => {
  let orm: MikroORM;
  const tables = ['wallets', 'wager_transactions', 'ledger_entries', 'inbox_messages', 'outbox_messages'];

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await orm.em
      .getConnection()
      .execute<{ exists: boolean }[]>(`select to_regclass(?) is not null as exists`, [name]);
    return rows[0]!.exists;
  };

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    // Leave the schema fully migrated for the other test files.
    await orm.migrator.up();
    await orm.close();
  });

  it('reverts every migration down to an empty schema and re-applies it', async () => {
    await orm.migrator.down({ to: 0 });
    expect(await orm.migrator.getExecuted()).toHaveLength(0);
    for (const table of tables) expect(await tableExists(table)).toBe(false);

    await orm.migrator.up();
    expect(await orm.migrator.getPending()).toHaveLength(0);
    for (const table of tables) expect(await tableExists(table)).toBe(true);
    expect(await tableExists('skeleton_probe')).toBe(false);
  });

  const constraintExists = async (name: string): Promise<boolean> => {
    const rows = await orm.em
      .getConnection()
      .execute<{ exists: boolean }[]>(`select exists (select 1 from pg_constraint where conname = ?) as exists`, [name]);
    return rows[0]!.exists;
  };
  const indexExists = async (name: string): Promise<boolean> => {
    const rows = await orm.em
      .getConnection()
      .execute<{ exists: boolean }[]>(`select exists (select 1 from pg_indexes where indexname = ?) as exists`, [name]);
    return rows[0]!.exists;
  };
  const columnExists = async (table: string, column: string): Promise<boolean> => {
    const rows = await orm.em
      .getConnection()
      .execute<{ exists: boolean }[]>(
        `select exists (select 1 from information_schema.columns where table_name = ? and column_name = ?) as exists`,
        [table, column],
      );
    return rows[0]!.exists;
  };

  it('reverts the ledger sequence one step at a time and numbers existing rows when re-applied', async () => {
    expect(await columnExists('ledger_entries', 'sequence')).toBe(true);
    expect(await indexExists('ledger_entries_wallet_page')).toBe(false);

    await orm.migrator.down();
    expect(await columnExists('ledger_entries', 'sequence')).toBe(false);
    expect(await indexExists('ledger_entries_wallet_page')).toBe(true);
    for (const table of tables) expect(await tableExists(table)).toBe(true);

    // Rows written without a sequence get one when the migration is applied again (the backfill).
    const db = orm.em.getConnection();
    const walletId = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const t = '2026-10-16T12:00:00Z';
    await db.execute(
      `insert into wallets values (?, 'migration-player', 'BRL', 90, 2, ?, ?)`,
      [walletId, t, t],
    );
    await db.execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at)
       values (?, 'p', 'e', 'k', repeat('a', 64), ?, 'migration-player', 'r', 'g', 'BET', 10, 'BRL', 'PROCESSED', ?, ?)`,
      [txId, walletId, t, t],
    );
    await db.execute(
      `insert into ledger_entries values (?, ?, ?, 'DEBIT', 10, 100, 90, ?)`,
      [crypto.randomUUID(), walletId, txId, t],
    );

    await orm.migrator.up();
    expect(await columnExists('ledger_entries', 'sequence')).toBe(true);
    const rows = await db.execute<{ sequence: number }[]>('select sequence from ledger_entries where wallet_id = ?', [walletId]);
    expect(rows.map((r) => r.sequence)).toEqual([1]);
    await db.execute('truncate wallets, wager_transactions, ledger_entries cascade');
  });

  it('reverts the idempotency key scope one step further back', async () => {
    expect(await constraintExists('wager_transactions_provider_idempotency_key_key')).toBe(true);

    await orm.migrator.down(); // ledger sequence
    await orm.migrator.down(); // idempotency key scope
    for (const table of tables) expect(await tableExists(table)).toBe(true);
    expect(await constraintExists('wager_transactions_provider_idempotency_key_key')).toBe(false);
    expect(await constraintExists('wager_transactions_idempotency_key_key')).toBe(true);

    await orm.migrator.up();
    expect(await constraintExists('wager_transactions_provider_idempotency_key_key')).toBe(true);
    expect(await constraintExists('wager_transactions_idempotency_key_key')).toBe(false);
  });
});
