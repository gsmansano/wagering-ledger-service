import 'reflect-metadata';
import { ensureTestDatabase, initTestOrm, testDatabaseUrl } from './database';

// Runs once per `bun test` process, before any test file.
// Every test, including ones that boot the Nest app, uses the test database.
process.env.DATABASE_URL = testDatabaseUrl();
// Tests that boot the app must not have a background worker retrying rows behind their back; the worker's own
// tests build and drive it explicitly.
process.env.PENDING_REFERENCE_WORKER = 'off';
// The SQS emulator accepts any credentials, but the AWS SDK refuses to sign without some.
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

await ensureTestDatabase();
const orm = await initTestOrm();
try {
  await orm.migrator.up();
} finally {
  await orm.close();
}
