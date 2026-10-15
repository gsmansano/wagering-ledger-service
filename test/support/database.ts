import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';

export const TEST_DATABASE = 'wagering_test';

export function testDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering');
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
}

// Creates the test database if it does not exist yet. Connects to the default
// `postgres` database because CREATE DATABASE cannot target itself.
export async function ensureTestDatabase(): Promise<void> {
  const adminUrl = new URL(testDatabaseUrl());
  adminUrl.pathname = '/postgres';
  const sql = new Bun.SQL(adminUrl.toString());
  try {
    const rows = await sql`select 1 from pg_database where datname = ${TEST_DATABASE}`;
    if (rows.length === 0) await sql.unsafe(`create database ${TEST_DATABASE}`);
  } finally {
    await sql.close();
  }
}

export function initTestOrm(): Promise<MikroORM> {
  return MikroORM.init(createOrmConfig(testDatabaseUrl()));
}

// Empties every application table between tests. The migrations bookkeeping
// table is kept, otherwise the schema would look unmigrated.
export async function truncateAll(orm: MikroORM): Promise<void> {
  const tables = await orm.em.getConnection().execute<{ tablename: string }[]>(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> 'mikro_orm_migrations'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await orm.em.getConnection().execute(`truncate ${list} restart identity cascade`);
}
