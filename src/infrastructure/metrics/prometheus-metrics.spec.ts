import { describe, expect, it } from 'bun:test';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/transaction/wager-transaction';
import { type ScrapeSources, PrometheusMetrics } from './prometheus-metrics';

const healthy: ScrapeSources = {
  outbox: async () => ({ pending: 3, lagSeconds: 1.5, parked: 1 }),
  dlqDepth: async () => 2,
  readiness: async () => ({ ready: true, checks: { postgres: 'up', sqs: 'up' } }),
};

describe('PrometheusMetrics', () => {
  it('counts what the application reports, with labels', async () => {
    const metrics = new PrometheusMetrics(healthy);
    metrics.transactionStatus(WagerTransactionKind.Bet, WagerTransactionStatus.Processed);
    metrics.transactionStatus(WagerTransactionKind.Bet, WagerTransactionStatus.Processed);
    metrics.duplicateDetected('inbox');
    metrics.processingTime('settled', 0.03);
    metrics.outboxPublishFailed(true);

    const { body } = await metrics.render();

    expect(body).toContain('wagering_transactions_total{kind="BET",status="PROCESSED"} 2');
    expect(body).toContain('wagering_duplicates_total{source="inbox"} 1');
    expect(body).toContain('wagering_processing_seconds_count{result="settled"} 1');
    expect(body).toContain('wagering_outbox_publish_failures_total{outcome="parked"} 1');
  });

  it('reads the gauges from the sources at every scrape', async () => {
    const depth = [2, 7];
    const metrics = new PrometheusMetrics({ ...healthy, dlqDepth: async () => depth.shift()! });

    expect((await metrics.render()).body).toContain('wagering_dlq_messages 2');
    const { body } = await metrics.render();

    expect(body).toContain('wagering_dlq_messages 7');
    expect(body).toContain('wagering_outbox_pending_events 3');
    expect(body).toContain('wagering_outbox_lag_seconds 1.5');
    expect(body).toContain('wagering_outbox_parked_events 1');
    expect(body).toContain('wagering_dependency_up{dependency="postgres"} 1');
  });

  it('reports a dependency that is down as 0', async () => {
    const metrics = new PrometheusMetrics({ ...healthy, readiness: async () => ({ ready: false, checks: { postgres: 'up', sqs: 'down' } }) });

    expect((await metrics.render()).body).toContain('wagering_dependency_up{dependency="sqs"} 0');
  });

  it('reports NaN for a gauge whose source fails instead of zero, and still answers', async () => {
    const metrics = new PrometheusMetrics({ ...healthy, dlqDepth: () => Promise.reject(new Error('sqs down')) });

    const { body } = await metrics.render();

    expect(body).toMatch(/wagering_dlq_messages nan/i); // prom-client writes it as "Nan"; Prometheus parses it case-insensitively
    expect(body).toContain('wagering_outbox_pending_events 3');
  });
});
