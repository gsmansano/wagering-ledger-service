import { Logger } from '@nestjs/common';
import { PublishOutcome, type PublishOutbox } from '../../application/outbox/publish-outbox';
import { errorFields } from '../logging/log-fields';

export interface OutboxWorkerOptions {
  /** When false the Nest lifecycle does not start polling (tests and one-off runs); `start()` still works. */
  enabled: boolean;
  /** Pause between polls when nothing is eligible. */
  pollIntervalMs: number;
  /** Messages handled per poll before sleeping again, so one poll cannot run unbounded. */
  batchSize: number;
}

/**
 * Polls the outbox and publishes what is eligible, one message per SQL transaction (decisions #56 to #59). It holds
 * no state: due times and order live in the table and `SKIP LOCKED` keeps instances apart, so any number of
 * instances can run it. Nest calls the lifecycle hooks below on the provider instance.
 */
export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly publishOutbox: PublishOutbox,
    private readonly options: OutboxWorkerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.enabled) this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  /** Stops polling and waits for the publish in flight, so shutdown never abandons a half-done transaction. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One poll: publishes until nothing is eligible or the batch is used up. Returns how many it handled. */
  async tick(): Promise<number> {
    let handled = 0;
    while (handled < this.options.batchSize) {
      const result = await this.publishOutbox.publishNext();
      if (result === undefined) break;
      handled += 1;
      // Ids and counts only, never the payload: events carry player and money data.
      const { id, eventType, aggregateId, attempts } = result.message;
      const fields = { eventId: id, eventType, walletId: aggregateId, attempt: attempts, ...errorFields(result.error) };
      if (result.outcome === PublishOutcome.Retried) {
        this.logger.warn({ event: 'outbox_publish_retry', ...fields }, 'Publishing an event failed, will retry');
      } else if (result.outcome === PublishOutcome.Parked) {
        this.logger.error(
          { event: 'outbox_event_parked', ...fields },
          'Event parked; later events of its wallet are held until it is requeued',
        );
      }
    }
    return handled;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.running = this.poll();
    }, this.options.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      // A failed poll must not kill the loop: the rows stay unpublished and the next poll retries them.
      this.logger.error({ event: 'outbox_poll_failed', ...errorFields(error) }, 'Outbox poll failed');
    } finally {
      if (!this.stopped) this.schedule();
    }
  }
}
