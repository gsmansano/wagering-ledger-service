import { Logger } from '@nestjs/common';
import type { ResolvePendingReference } from '../../application/transaction/resolve-pending-reference';
import { errorFields } from '../logging/log-fields';

export interface PendingReferenceWorkerOptions {
  /** When false the Nest lifecycle does not start polling (tests and one-off runs); `start()` still works. */
  enabled: boolean;
  /** Pause between polls when nothing is due. */
  pollIntervalMs: number;
  /** Retries handled per poll before sleeping again, so one poll cannot run unbounded. */
  batchSize: number;
}

/**
 * Polls for PENDING_REFERENCE reversals that are due and retries them one by one (decisions #39 and #40). It
 * holds no state: due times live in the table and `SKIP LOCKED` keeps instances apart, so any number of
 * instances can run it. Nest calls the lifecycle hooks below on the provider instance.
 */
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly resolvePending: ResolvePendingReference,
    private readonly options: PendingReferenceWorkerOptions,
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

  /** Stops polling and waits for the retry in flight, so shutdown never abandons a half-done transaction. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One poll: retries due transactions until none is left or the batch is used up. Returns how many it handled. */
  async tick(): Promise<number> {
    let handled = 0;
    while (handled < this.options.batchSize) {
      const result = await this.resolvePending.executeNextDue();
      if (result === undefined) break;
      handled += 1;
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
      // A failed poll must not kill the loop: the rows stay pending and the next poll retries them.
      this.logger.error({ event: 'pending_reference_poll_failed', ...errorFields(error) }, 'Pending-reference poll failed');
    } finally {
      if (!this.stopped) this.schedule();
    }
  }
}
