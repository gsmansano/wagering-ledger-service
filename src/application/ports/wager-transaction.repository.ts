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
  /** Persists status, resolved reference, failure code, processedAt and the observed balance. */
  update(transaction: WagerTransaction, balanceAfter?: Money): Promise<void>;
}
