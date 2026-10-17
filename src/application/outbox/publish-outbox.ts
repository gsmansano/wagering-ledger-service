import { DEFAULT_OUTBOX_RETRY_POLICY, type OutboxMessage, type OutboxRetryPolicy } from '../../domain/messaging/outbox-message';
import type { EventPublisher } from '../ports/event-publisher';
import type { UnitOfWork } from '../ports/unit-of-work';

export enum PublishOutcome {
  Published = 'PUBLISHED',
  /** The broker refused it; the next attempt is scheduled with backoff. */
  Retried = 'RETRIED',
  /** The attempt limit was reached: the message is parked and holds back its wallet's later events (#58). */
  Parked = 'PARKED',
}

export interface PublishOutboxResult {
  outcome: PublishOutcome;
  message: OutboxMessage;
  /** Why the broker refused it; present for `Retried` and `Parked`, for the caller to log. */
  error?: unknown;
}

export interface PublishOutboxDeps {
  unitOfWork: UnitOfWork;
  publisher: EventPublisher;
  now: () => Date;
  retry?: OutboxRetryPolicy;
}

/**
 * Publishes outbox events after the transaction that wrote them has committed (decisions #56 to #59). One message
 * per SQL transaction: the row is claimed with `SKIP LOCKED`, sent, and marked in the same transaction. A crash
 * before the commit releases the row untouched and another instance publishes it, possibly a second time if the
 * broker had already accepted it: delivery is at-least-once and consumers deduplicate by the event id.
 */
export class PublishOutbox {
  constructor(private readonly deps: PublishOutboxDeps) {}

  /** Publishes the next eligible message. Undefined when there is none: the worker's cue to sleep. */
  publishNext(): Promise<PublishOutboxResult | undefined> {
    const { unitOfWork, publisher, now } = this.deps;
    const policy = this.deps.retry ?? DEFAULT_OUTBOX_RETRY_POLICY;
    return unitOfWork.run(async (repos) => {
      const message = await repos.outbox.claimNext(now());
      if (message === undefined) return undefined;
      try {
        await publisher.publish(message);
      } catch (error) {
        // Caught on purpose: the failed attempt must be committed, or the row would retry at once, forever, and
        // never reach the attempt limit.
        message.scheduleRetry(now(), policy);
        await repos.outbox.update(message);
        return { outcome: message.isFailed() ? PublishOutcome.Parked : PublishOutcome.Retried, message, error };
      }
      message.markPublished(now());
      await repos.outbox.update(message);
      return { outcome: PublishOutcome.Published, message };
    });
  }
}
