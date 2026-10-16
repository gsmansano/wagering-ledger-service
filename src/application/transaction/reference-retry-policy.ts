import { exponentialBackoffMs } from '../../domain/shared/backoff';

/** How long a reversal waits for a reference that has not arrived or settled (decision #39). */
export interface ReferenceRetryPolicy {
  /** Retries after the first delivery; the last unsuccessful one rejects with REFERENCE_NOT_FOUND. */
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

/** Retries after 1s, 2s, 4s ... capped at 5 min, rejecting at the 10th: about 13 minutes of waiting. */
export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = {
  maxAttempts: 10,
  baseMs: 1_000,
  capMs: 300_000,
};

/** When retry number `attempt` (1, 2, ...) is due, counted from `from`. */
export function referenceRetryAt(policy: ReferenceRetryPolicy, attempt: number, from: Date): Date {
  return new Date(from.getTime() + exponentialBackoffMs(attempt, policy.baseMs, policy.capMs));
}
