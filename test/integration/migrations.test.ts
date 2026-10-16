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

  it('reverts only the core schema one step at a time', async () => {
    await orm.migrator.down();
    for (const table of tables) expect(await tableExists(table)).toBe(false);
    expect(await tableExists('skeleton_probe')).toBe(true);
    await orm.migrator.up();
    for (const table of tables) expect(await tableExists(table)).toBe(true);
  });
});
