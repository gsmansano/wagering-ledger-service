import type { InboxMessage } from '../../domain/messaging/inbox-message';

export interface InboxRepository {
  /** Fails when the consumer already recorded this message id: the persistent dedup guarantee. */
  insert(message: InboxMessage): Promise<void>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /** Persists `processedAt` of an existing message. */
  update(message: InboxMessage): Promise<void>;
}
