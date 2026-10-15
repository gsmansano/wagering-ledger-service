import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { initTestOrm } from '../support/database';

describe('migrations (real PostgreSQL)', () => {
  let orm: MikroORM;

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
    expect(await tableExists('skeleton_probe')).toBe(false);

    await orm.migrator.up();
    expect(await orm.migrator.getPending()).toHaveLength(0);
    expect(await tableExists('skeleton_probe')).toBe(true);
  });
});
