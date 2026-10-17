import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Metrics, ProcessingResult } from '../../application/ports/metrics';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/transaction/wager-transaction';
import type { ReadinessReport } from '../readiness.service';

export interface OutboxStats {
  /** Events waiting to be published (neither published nor parked). */
  pending: number;
  /** Age in seconds of the oldest of them, held ones included (see `readOutboxStats`); 0 when there are none. */
  lagSeconds: number;
  /** Events given up on after the retry limit, each holding the later events of its wallet (decision #58). */
  parked: number;
}

/** What is read from the outside at scrape time, so every instance reports the same value (decision #64). */
export interface ScrapeSources {
  outbox(): Promise<OutboxStats>;
  /** Messages waiting in the wager dead-letter queue. */
  dlqDepth(): Promise<number>;
  readiness(): Promise<ReadinessReport>;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * The Prometheus side of the `Metrics` port. It owns its registry instead of using the global one, so several
 * applications in one test process never register the same name twice. Counters and the histogram are updated by
 * the application; the gauges are read from `ScrapeSources` each time `render` is called.
 */
export class PrometheusMetrics implements Metrics {
  private readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transactions that reached a status, by kind and status',
    labelNames: ['kind', 'status'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Deliveries that changed nothing because they were seen before',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'wagering_processing_seconds',
    help: 'Time to process one transaction, including the wait for the wallet lock',
    labelNames: ['result'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  private readonly pendingAttempts = new Counter({
    name: 'wagering_pending_reference_attempts_total',
    help: 'Attempts to resolve a reversal that was waiting for its reference',
    registers: [this.registry],
  });
  private readonly messageRetries = new Counter({
    name: 'wagering_message_retries_total',
    help: 'Queue messages left to be redelivered after a failure',
    registers: [this.registry],
  });
  private readonly deadLettered = new Counter({
    name: 'wagering_messages_dead_lettered_total',
    help: 'Queue messages sent to the dead-letter queue because they can never succeed',
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Failed attempts to publish an outbox event; parked is the last one',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  private readonly lockWait = new Histogram({
    name: 'wagering_wallet_lock_wait_seconds',
    help: 'Time spent waiting for a wallet lock; a timeout means the request was answered with a retryable 503',
    labelNames: ['outcome'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliations that found a balance different from the ledger',
    registers: [this.registry],
  });

  private readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending_events',
    help: 'Outbox events not yet published and not parked, including events held behind a parked one',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unparked outbox event not yet published, including events held behind a parked one',
    registers: [this.registry],
  });
  private readonly outboxParked = new Gauge({
    name: 'wagering_outbox_parked_events',
    help: 'Outbox events parked after the retry limit; each holds the events behind it for its wallet',
    registers: [this.registry],
  });
  private readonly dlqMessages = new Gauge({
    name: 'wagering_dlq_messages',
    help: 'Messages waiting in the wager dead-letter queue',
    registers: [this.registry],
  });
  private readonly dependencyUp = new Gauge({
    name: 'wagering_dependency_up',
    help: '1 when the dependency answers the readiness probe, 0 when it does not',
    labelNames: ['dependency'],
    registers: [this.registry],
  });

  private refreshedAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | undefined;

  /**
   * `gaugeTtlMs` is how long the gauges are reused: the endpoint is public, and every refresh reads PostgreSQL and
   * SQS, so scrapes inside the window (or at the same moment) share one read. 0 reads on every scrape.
   */
  constructor(
    private readonly sources: ScrapeSources,
    private readonly gaugeTtlMs = 0,
  ) {}

  transactionStatus(kind: WagerTransactionKind, status: WagerTransactionStatus): void {
    this.transactions.inc({ kind, status });
  }

  duplicateDetected(source: 'idempotency_key' | 'inbox'): void {
    this.duplicates.inc({ source });
  }

  processingTime(result: ProcessingResult, seconds: number): void {
    this.processing.observe({ result }, seconds);
  }

  pendingReferenceAttempted(): void {
    this.pendingAttempts.inc();
  }

  messageRetried(): void {
    this.messageRetries.inc();
  }

  messageDeadLettered(): void {
    this.deadLettered.inc();
  }

  outboxPublishFailed(parked: boolean): void {
    this.outboxFailures.inc({ outcome: parked ? 'parked' : 'retry' });
  }

  walletLockWaited(outcome: 'acquired' | 'timeout', seconds: number): void {
    this.lockWait.observe({ outcome }, seconds);
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  /** The text exposition format. A gauge whose source fails reads NaN: "no value", never a misleading zero. */
  async render(): Promise<{ contentType: string; body: string }> {
    await this.refreshGauges();
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  private refreshGauges(): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing; // a read is under way: share it
    if (Date.now() - this.refreshedAt < this.gaugeTtlMs) return Promise.resolve();
    this.refreshing = this.readSources().finally(() => {
      this.refreshedAt = Date.now();
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async readSources(): Promise<void> {
    // A gauge cannot be cleared (reset() sets 0), so a failed source sets NaN explicitly.
    await Promise.allSettled([
      this.sources.outbox().then(
        (stats) => {
          this.outboxPending.set(stats.pending);
          this.outboxLag.set(stats.lagSeconds);
          this.outboxParked.set(stats.parked);
        },
        () => {
          this.outboxPending.set(Number.NaN);
          this.outboxLag.set(Number.NaN);
          this.outboxParked.set(Number.NaN);
        },
      ),
      this.sources.dlqDepth().then(
        (depth) => this.dlqMessages.set(depth),
        () => this.dlqMessages.set(Number.NaN),
      ),
      this.sources.readiness().then(({ checks }) => {
        this.dependencyUp.set({ dependency: 'postgres' }, checks.postgres === 'up' ? 1 : 0);
        this.dependencyUp.set({ dependency: 'sqs' }, checks.sqs === 'up' ? 1 : 0);
      }),
    ]);
  }
}
