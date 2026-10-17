import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/transaction/wager-transaction';

/** How a call to the transaction use case ended, as a metric label. */
export type ProcessingResult = 'settled' | 'replay' | 'duplicate_message' | 'error';

/**
 * What the application reports about itself (spec §12). Named events rather than a generic counter, so a call
 * site cannot misspell a metric or pick the wrong label. Methods are called after the SQL transaction commits.
 */
export interface Metrics {
  /** A transaction reached a status: a first delivery settled, or a pending reversal was resolved. */
  transactionStatus(kind: WagerTransactionKind, status: WagerTransactionStatus): void;
  /** A delivery that changed nothing: the same idempotency key replayed, or an inbox message seen before. */
  duplicateDetected(source: 'idempotency_key' | 'inbox'): void;
  /** Seconds from the start of `ProcessWagerTransaction.execute` to its end, including the wallet-lock wait. */
  processingTime(result: ProcessingResult, seconds: number): void;
  /** One attempt to resolve a reversal that was waiting for its reference. */
  pendingReferenceAttempted(): void;
  /** A queue message was left to be redelivered. */
  messageRetried(): void;
  /** A queue message was sent to the DLQ because it can never succeed. */
  messageDeadLettered(): void;
  /** Publishing an outbox event failed; `parked` is true when this was the last attempt. */
  outboxPublishFailed(parked: boolean): void;
  /** The wait for a wallet lock ended: it was acquired, or the lock timeout gave up. Zero-wait locks count too. */
  walletLockWaited(outcome: 'acquired' | 'timeout', seconds: number): void;
  /** A reconciliation found a wallet whose balance differs from its ledger. */
  reconciliationDivergence(): void;
}

/** For code built without a registry (unit tests); the application wires the Prometheus implementation. */
export const NO_METRICS: Metrics = {
  transactionStatus: () => {},
  duplicateDetected: () => {},
  processingTime: () => {},
  pendingReferenceAttempted: () => {},
  messageRetried: () => {},
  messageDeadLettered: () => {},
  outboxPublishFailed: () => {},
  walletLockWaited: () => {},
  reconciliationDivergence: () => {},
};
