import { exponentialBackoffMs } from '../shared/backoff';
import { DomainError } from '../shared/domain-error';
import type { IntegrationEvent } from '../events/integration-event';

export interface OutboxRetryPolicy {
  baseMs: number;
  capMs: number;
  /** Failed publish attempts after which the message is parked. */
  maxAttempts: number;
}

/** 1s, 2s, 4s ... capped at 5 min between attempts; parked after 20 failures (about an hour of retrying). */
export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = {
  baseMs: 1_000,
  capMs: 5 * 60_000,
  maxAttempts: 20,
};

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
  failedAt: Date | undefined;
}

/**
 * An event waiting to be published. Ends either published or parked (`failedAt`); a parked message
 * is never deleted and can be requeued by an operator.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _failedAt: Date | undefined,
  ) {}

  /** One row per event: the row id is the event id, which consumers can deduplicate on. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      { ...event.toJSON() },
      event.occurredAt,
      0,
      undefined,
      undefined,
      undefined,
    );
  }

  /** Rebuilds a persisted message; it was valid when saved, so nothing is re-checked. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.failedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get failedAt(): Date | undefined {
    return this._failedAt;
  }

  /** Still waiting to be published: neither published nor parked. */
  isPending(): boolean {
    return this._publishedAt === undefined && this._failedAt === undefined;
  }

  isFailed(): boolean {
    return this._failedAt !== undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending('mark as published');
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Counts a failed attempt and schedules the next one with backoff; parks the message at the attempt limit. */
  scheduleRetry(now: Date, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY): void {
    this.assertPending('schedule a retry for');
    this._attempts += 1;
    if (this._attempts >= policy.maxAttempts) {
      this._failedAt = now;
      this._nextAttemptAt = undefined;
      return;
    }
    const delayMs = exponentialBackoffMs(this._attempts, policy.baseMs, policy.capMs);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      const state = this.isFailed() ? 'parked' : 'published';
      throw new DomainError(`Cannot ${action} outbox message ${this.id}: it is already ${state}`);
    }
  }
}
