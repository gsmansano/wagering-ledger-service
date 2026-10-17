import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxRepository {
  /** Written in the same transaction as the change it announces, so it exists only if that change commits. */
  insert(message: OutboxMessage): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
  /**
   * Locks and returns the next message to publish, or undefined when none is eligible. Eligible means due and the
   * oldest unpublished message of its wallet: a parked or backed-off earlier message holds the later ones back
   * (decisions #58 and #59). Rows another instance holds are skipped, so publishers do not wait for each other.
   * The lock lasts until the surrounding transaction ends.
   */
  claimNext(now: Date): Promise<OutboxMessage | undefined>;
  /** Persists attempts, nextAttemptAt, publishedAt and failedAt of an existing message. */
  update(message: OutboxMessage): Promise<void>;
}
