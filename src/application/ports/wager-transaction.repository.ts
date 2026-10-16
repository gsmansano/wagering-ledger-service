import type { Money } from '../../domain/shared/money';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction';

/** A stored transaction with the wallet balance observed when it was settled (undefined while open). */
export interface PersistedWagerTransaction {
  transaction: WagerTransaction;
  balanceAfter: Money | undefined;
}

export interface WagerTransactionRepository {
  /** Fails on a duplicate id, idempotency key or (provider, external transaction id). */
  insert(transaction: WagerTransaction): Promise<void>;
  /**
   * Inserts unless a unique rule is hit: the id, (provider, idempotency key) or (provider, external transaction
   * id). False means a conflict; the caller looks up who owns the key. PostgreSQL accepts a single conflict target
   * per statement, so none is named and the caller must handle a conflict that no lookup explains.
   * Unlike `insert`, a conflict does not abort the surrounding SQL transaction.
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  findById(id: string): Promise<PersistedWagerTransaction | undefined>;
  /** The key is unique per provider, so it is looked up together with the provider id. */
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<PersistedWagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<PersistedWagerTransaction | undefined>;
  /** True when a PROCESSED REFUND or ROLLBACK already reverses this transaction (decision #36). */
  hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  /**
   * Locks the row of a PENDING_REFERENCE transaction until the end of the SQL transaction, waiting if another
   * holds it. False when it is not (or no longer) PENDING_REFERENCE.
   */
  lockPendingReference(transactionId: string): Promise<boolean>;
  /**
   * Locks, skipping rows other instances hold (`FOR UPDATE SKIP LOCKED`), the PENDING_REFERENCE transaction whose
   * retry has been due the longest, and returns its id; undefined when none is due. Several instances can poll
   * the same table without picking the same row.
   */
  lockNextDuePendingReference(now: Date): Promise<string | undefined>;
  /** Retries already made for a PENDING_REFERENCE transaction (decision #39); 0 for any other. */
  referenceAttempts(transactionId: string): Promise<number>;
  /** Records the retries made and when the next one is due (null once the transaction is settled). */
  scheduleReferenceRetry(transactionId: string, attempts: number, nextAttemptAt: Date | null): Promise<void>;
  /** Persists status, resolved reference, failure code, processedAt and the observed balance. */
  update(transaction: WagerTransaction, balanceAfter?: Money): Promise<void>;
}
