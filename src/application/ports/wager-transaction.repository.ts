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
  findById(id: string): Promise<PersistedWagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<PersistedWagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<PersistedWagerTransaction | undefined>;
  /** Persists status, resolved reference, failure code, processedAt and the observed balance. */
  update(transaction: WagerTransaction, balanceAfter?: Money): Promise<void>;
}
