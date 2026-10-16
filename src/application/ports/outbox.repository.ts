import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxRepository {
  /** Written in the same transaction as the change it announces, so it exists only if that change commits. */
  insert(message: OutboxMessage): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
  /** Persists attempts, nextAttemptAt, publishedAt and failedAt of an existing message. */
  update(message: OutboxMessage): Promise<void>;
}
