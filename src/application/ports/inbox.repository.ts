import type { InboxMessage } from '../../domain/messaging/inbox-message';

export interface InboxRepository {
  /** Fails when the consumer already recorded this message id: the persistent dedup guarantee. */
  insert(message: InboxMessage): Promise<void>;
  /**
   * Inserts unless the consumer already recorded this message id, and says which happened. Unlike `insert`, a
   * duplicate does not abort the PostgreSQL transaction, so the caller can keep working in it (decision #51).
   */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /** Persists `processedAt` of an existing message. */
  update(message: InboxMessage): Promise<void>;
}
