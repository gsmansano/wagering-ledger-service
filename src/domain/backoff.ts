import { DomainError } from './domain-error';

/**
 * Capped exponential backoff, without jitter so the domain stays deterministic:
 * delay = min(baseMs * 2^(attempt - 1), capMs). `attempt` counts from 1.
 */
export function exponentialBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new DomainError(`Backoff attempt must be a positive integer, got ${attempt}`);
  }
  if (baseMs <= 0 || capMs < baseMs) {
    throw new DomainError(`Invalid backoff bounds: base ${baseMs}ms, cap ${capMs}ms`);
  }
  // 2 ** large becomes Infinity, which Math.min correctly clamps to the cap.
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}
