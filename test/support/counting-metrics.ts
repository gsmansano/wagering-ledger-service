import type { Metrics, ProcessingResult } from '../../src/application/ports/metrics';

/** A `Metrics` that remembers what it was told, for tests that check a use case or worker reports the right thing. */
export class CountingMetrics implements Metrics {
  statuses: string[] = [];
  duplicates: string[] = [];
  processing: ProcessingResult[] = [];
  pendingAttempts = 0;
  messageRetries = 0;
  deadLettered = 0;
  outboxFailures: ('retry' | 'parked')[] = [];
  divergences = 0;
  lockWaits: ('acquired' | 'timeout')[] = [];

  transactionStatus(kind: string, status: string): void {
    this.statuses.push(`${kind}:${status}`);
  }
  duplicateDetected(source: string): void {
    this.duplicates.push(source);
  }
  processingTime(result: ProcessingResult): void {
    this.processing.push(result);
  }
  pendingReferenceAttempted(): void {
    this.pendingAttempts += 1;
  }
  messageRetried(): void {
    this.messageRetries += 1;
  }
  messageDeadLettered(): void {
    this.deadLettered += 1;
  }
  outboxPublishFailed(parked: boolean): void {
    this.outboxFailures.push(parked ? 'parked' : 'retry');
  }
  walletLockWaited(outcome: 'acquired' | 'timeout'): void {
    this.lockWaits.push(outcome);
  }
  reconciliationDivergence(): void {
    this.divergences += 1;
  }
}
