import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/transaction/failure-code';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/transaction/wager-transaction';
import type { UnitOfWork } from '../ports/unit-of-work';
import { ApplyOutcome, applyUnderLock } from './apply-transaction';
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
}

/**
 * One retry of a PENDING_REFERENCE reversal (decisions #39 and #40), under the same wallet lock and apply path as
 * a first delivery. It does not look at the due time: choosing which rows to retry is the worker's job.
 * Safe to call from several instances: the status is re-read under the wallet lock, so a transaction another
 * instance already settled is reported as `NotPending`.
 */
export class ResolvePendingReference {
  constructor(private readonly deps: ResolvePendingReferenceDeps) {}

  async execute(transactionId: string): Promise<ResolvePendingReferenceResult> {
    const { unitOfWork, now, newId } = this.deps;
    const policy = this.deps.referenceRetry ?? DEFAULT_REFERENCE_RETRY_POLICY;

    return unitOfWork.run(async (repos) => {
      // Unlocked read, only to learn which wallet to lock; the decision is taken on the re-read below.
      const peek = await repos.transactions.findById(transactionId);
      if (peek === undefined || peek.transaction.status !== WagerTransactionStatus.PendingReference) {
        return { outcome: ResolveOutcome.NotPending, transaction: peek?.transaction };
      }

      const wallet = (await repos.wallets.findByIdForUpdate(peek.transaction.walletId))!; // the foreign key keeps it
      const locked = (await repos.transactions.findById(transactionId))!; // exists: read above
      const transaction = locked.transaction;
      if (transaction.status !== WagerTransactionStatus.PendingReference) {
        return { outcome: ResolveOutcome.NotPending, transaction };
      }

      const at = now();
      const attempts = (await repos.transactions.referenceAttempts(transactionId)) + 1;
      const events: IntegrationEvent<unknown>[] = [];
      const context = { at, newId, correlationId: newId() };
      let outcome = await applyUnderLock(repos, transaction, wallet, context, events);

      if (outcome === ApplyOutcome.Waiting && attempts < policy.maxAttempts) {
        await repos.transactions.scheduleReferenceRetry(transactionId, attempts, referenceRetryAt(policy, attempts + 1, at));
        return { outcome: ResolveOutcome.StillWaiting, transaction };
      }

      if (outcome === ApplyOutcome.Waiting) {
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
        outcome = ApplyOutcome.Settled;
      }

      await repos.transactions.update(transaction, wallet.balance);
      await repos.transactions.scheduleReferenceRetry(transactionId, attempts, null);
      for (const event of events) await repos.outbox.insert(OutboxMessage.enqueue(event));
      return { outcome: ResolveOutcome.Settled, transaction };
    });
  }
}
