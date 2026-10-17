import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface EventPublisher {
  /**
   * Hands the event to the broker, resolving only once the broker has accepted it. Delivery is at-least-once: the
   * caller may publish the same message again after a crash, so the event id must travel with it for deduplication.
   */
  publish(message: OutboxMessage): Promise<void>;
}
