import 'reflect-metadata';
import { ensureTestDatabase, initTestOrm, testDatabaseUrl } from './database';

// Runs once per `bun test` process, before any test file.
// Every test, including ones that boot the Nest app, uses the test database.
process.env.DATABASE_URL = testDatabaseUrl();
// Tests that boot the app must not have a background worker retrying rows behind their back; the worker's own
// tests build and drive it explicitly.
process.env.PENDING_REFERENCE_WORKER = 'off';
// Same for the outbox publisher: its tests build and drive it explicitly.
process.env.OUTBOX_WORKER = 'off';
// Same for the queue consumer: its tests build it against throwaway queues.
process.env.SQS_CONSUMER = 'off';
// Quiet by default; the logging tests ask for `info` on the instances they start.
process.env.LOG_LEVEL = 'warn';
// Tests read the gauges right after changing the data, so no caching.
process.env.METRICS_CACHE_MS = '0';
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
