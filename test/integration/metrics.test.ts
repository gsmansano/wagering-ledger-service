import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { ReadinessService } from '../../src/infrastructure/readiness.service';
import { initTestOrm, truncateAll } from '../support/database';

// GET /metrics after real traffic through the application: PostgreSQL and the SQS emulator are real.
describe('metrics endpoint (real PostgreSQL + SQS emulator)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    orm = await initTestOrm();
    await truncateAll(orm);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    await truncateAll(orm);
    await orm.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const scrape = async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    return res.text();
  };
  /** The value of one sample, e.g. `wagering_transactions_total{kind="BET",status="PROCESSED"}`; 0 when absent. */
  const sample = (text: string, name: string): number => {
    const line = text.split('\n').find((l) => l.startsWith(`${name} `));
    return line === undefined ? 0 : Number(line.slice(name.length + 1));
  };

  const wager = (walletId: string, playerId: string, amount: string, externalTransactionId: string = crypto.randomUUID(), kind = 'BET', extra = {}) => ({
    providerId: 'provider-metrics',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'r',
    gameId: 'g',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  });

  it('counts statuses, duplicates, pending reversals and divergences, and reports outbox and dependency gauges', async () => {
    const before = await scrape();
    const playerId = `metrics-${crypto.randomUUID()}`;
    const created = await post('/wallets', { playerId, initialBalance: { currency: 'BRL', amount: '100.00' } });
    const walletId = ((await created.json()) as { id: string }).id;

    await post('/wagering/transactions', wager(walletId, playerId, '30.00', 'tx-1'), { 'idempotency-key': 'k-1' });
    await post('/wagering/transactions', wager(walletId, playerId, '30.00', 'tx-1'), { 'idempotency-key': 'k-1' }); // replay
    await post('/wagering/transactions', wager(walletId, playerId, '500.00'), { 'idempotency-key': crypto.randomUUID() }); // rejected
    const pending = await post(
      '/wagering/transactions',
      wager(walletId, playerId, '30.00', 'refund-1', 'REFUND', { referenceExternalTransactionId: 'tx-not-here' }),
      { 'idempotency-key': 'k-refund' },
    );
    expect(pending.status).toBe(202);
    await orm.em.getConnection().execute('update wallets set balance = balance + 5.00 where id = ?', [walletId]);
    await post(`/wallets/${walletId}/reconciliation`, {});

    const after = await scrape();
    const delta = (name: string) => sample(after, name) - sample(before, name);

    expect(delta('wagering_transactions_total{kind="BET",status="PROCESSED"}')).toBe(1);
    expect(delta('wagering_transactions_total{kind="BET",status="REJECTED"}')).toBe(1);
    expect(delta('wagering_transactions_total{kind="REFUND",status="PENDING_REFERENCE"}')).toBe(1);
    expect(delta('wagering_duplicates_total{source="idempotency_key"}')).toBe(1);
    expect(delta('wagering_processing_seconds_count{result="settled"}')).toBe(3);
    expect(delta('wagering_processing_seconds_count{result="replay"}')).toBe(1);
    expect(delta('wagering_reconciliation_divergences_total')).toBe(1);

    // The workers are off in tests, so the events of this run are still waiting in the outbox.
    expect(sample(after, 'wagering_outbox_pending_events')).toBeGreaterThan(0);
    expect(sample(after, 'wagering_outbox_lag_seconds')).toBeGreaterThan(0);
    expect(sample(after, 'wagering_outbox_parked_events')).toBe(0);
    expect(after).toContain('wagering_dlq_messages ');
    expect(sample(after, 'wagering_dependency_up{dependency="postgres"}')).toBe(1);
    expect(sample(after, 'wagering_dependency_up{dependency="sqs"}')).toBe(1);
  }, 30_000);

  it('reports parked events as a gauge', async () => {
    await orm.em.getConnection().execute(`update outbox_messages set failed_at = now() where id = (select id from outbox_messages order by sequence limit 1)`);

    const text = await scrape();

    expect(sample(text, 'wagering_outbox_parked_events')).toBe(1);
    // The events behind the parked one are held, not parked: they still count as pending and in the lag (review F-4).
    expect(sample(text, 'wagering_outbox_pending_events')).toBeGreaterThan(0);
    expect(sample(text, 'wagering_outbox_lag_seconds')).toBeGreaterThan(0);
  });

  it('carries no wallet, player or provider identifiers in any label', async () => {
    const text = await scrape();

    expect(text).not.toContain('provider-metrics');
    expect(text).not.toContain('metrics-');
  });
});

describe('metrics endpoint with a dependency down', () => {
  it('reports the dependency as 0 and still answers', async () => {
    const down = { check: async () => ({ ready: false, checks: { postgres: 'up', sqs: 'down' } }) };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ReadinessService)
      .useValue(down)
      .compile();
    const app = moduleRef.createNestApplication();
    await app.listen(0);
    try {
      const text = await (await fetch(`${await app.getUrl()}/metrics`)).text();

      expect(text).toContain('wagering_dependency_up{dependency="sqs"} 0');
      expect(text).toContain('wagering_dependency_up{dependency="postgres"} 1');
    } finally {
      await app.close();
    }
  });
});

