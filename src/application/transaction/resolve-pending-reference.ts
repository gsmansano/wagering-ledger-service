import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/transaction/failure-code';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/transaction/wager-transaction';
import { type Metrics, NO_METRICS } from '../ports/metrics';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';
import { ApplyOutcome, applyUnderLock } from './apply-transaction';
import { lockWallet } from './lock-wallet';
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  referenceRetryAt,
  type ReferenceRetryPolicy,
} from './reference-retry-policy';

export enum ResolveOutcome {
  /** Not found, or no longer PENDING_REFERENCE (another instance settled it first): nothing to do. */
  NotPending = 'NOT_PENDING',
  /** The reference is still missing or in flight; the next retry was scheduled. */
  StillWaiting = 'STILL_WAITING',
  /** The transaction reached PROCESSED or REJECTED (including the rejection after the last retry). */
  Settled = 'SETTLED',
}

export interface ResolvePendingReferenceResult {
  outcome: ResolveOutcome;
  transaction: WagerTransaction | undefined;
}

export interface ResolvePendingReferenceDeps {
  unitOfWork: UnitOfWork;
  now: () => Date;
  newId: () => string;
  referenceRetry?: ReferenceRetryPolicy;
  metrics?: Metrics;
}

/**
 * One retry of a PENDING_REFERENCE reversal (decisions #39 and #40), under the same wallet lock and apply path as
 * a first delivery. Lock order is always the transaction row, then the wallet, so concurrent instances cannot
 * deadlock on each other; the row lock also makes the status read afterwards authoritative: a transaction another
 * instance already settled is reported as `NotPending`.
 */
export class ResolvePendingReference {
  constructor(private readonly deps: ResolvePendingReferenceDeps) {}

  /** Retries one given transaction whether or not it is due (waits if another instance is retrying it). */
  async execute(transactionId: string): Promise<ResolvePendingReferenceResult> {
    const result = await this.deps.unitOfWork.run(async (repos) => {
      if (!(await repos.transactions.lockPendingReference(transactionId))) {
        return { outcome: ResolveOutcome.NotPending, transaction: (await repos.transactions.findById(transactionId))?.transaction };
      }
      return this.retry(repos, transactionId);
    });
    this.record(result);
    return result;
  }

  /**
   * Retries the pending transaction that has been due the longest and that no other instance is working on
   * (`SKIP LOCKED`). Undefined when nothing is due: the worker's cue to sleep.
   */
  async executeNextDue(): Promise<ResolvePendingReferenceResult | undefined> {
    const result = await this.deps.unitOfWork.run(async (repos) => {
      const id = await repos.transactions.lockNextDuePendingReference(this.deps.now());
      return id === undefined ? undefined : this.retry(repos, id);
    });
    if (result !== undefined) this.record(result);
    return result;
  }

  /** After the commit: an attempt that did something is a retry, and a settled transaction reached a status. */
  private record({ outcome, transaction }: ResolvePendingReferenceResult): void {
    const metrics = this.deps.metrics ?? NO_METRICS;
    if (outcome === ResolveOutcome.NotPending || transaction === undefined) return;
    metrics.pendingReferenceAttempted();
    if (outcome === ResolveOutcome.Settled) metrics.transactionStatus(transaction.kind, transaction.status);
  }

  /** The row of `transactionId` is locked and was PENDING_REFERENCE a moment ago. */
  private async retry(repos: Repositories, transactionId: string): Promise<ResolvePendingReferenceResult> {
    const { now, newId } = this.deps;
    const policy = this.deps.referenceRetry ?? DEFAULT_REFERENCE_RETRY_POLICY;

    const transaction = (await repos.transactions.findById(transactionId))!.transaction; // locked, so it exists
    if (transaction.status !== WagerTransactionStatus.PendingReference) {
      return { outcome: ResolveOutcome.NotPending, transaction };
    }
    const wallet = (await lockWallet(repos, transaction.walletId, this.deps.metrics))!; // the foreign key keeps it

    const at = now();
    const attempts = (await repos.transactions.referenceAttempts(transactionId)) + 1;
    const events: IntegrationEvent<unknown>[] = [];
    const context = { at, newId, correlationId: newId() };
    const outcome = await applyUnderLock(repos, transaction, wallet, context, events);

    if (outcome === ApplyOutcome.Waiting) {
      if (attempts < policy.maxAttempts) {
        await repos.transactions.scheduleReferenceRetry(transactionId, attempts, referenceRetryAt(policy, attempts + 1, at));
        return { outcome: ResolveOutcome.StillWaiting, transaction };
      }
      // Retry limit reached: the reference never became usable (decision #39).
      transaction.reject(FailureCode.ReferenceNotFound, at);
      events.push(
        WagerTransactionRejected.from(transaction, {
          eventId: newId(),
          correlationId: context.correlationId,
          causationId: transaction.id,
          occurredAt: at,
        }),
      );
    }

    await repos.transactions.update(transaction, wallet.balance);
    await repos.transactions.scheduleReferenceRetry(transactionId, attempts, null);
    for (const event of events) await repos.outbox.insert(OutboxMessage.enqueue(event));
    return { outcome: ResolveOutcome.Settled, transaction };
  }
}
