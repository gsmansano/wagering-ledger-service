import type { Money } from '../../domain/shared/money';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/transaction/wager-transaction';

/** The one representation of a transaction in every response (decision #45). */
export function toTransactionView(transaction: WagerTransaction, balanceAfter: Money | undefined) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...(transaction.failureCode !== undefined && { failureCode: transaction.failureCode }),
    ...(transaction.referenceExternalTransactionId !== undefined && {
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    }),
    ...(balanceAfter !== undefined && { balance: balanceAfter.toJSON() }),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt !== undefined && { processedAt: transaction.processedAt.toISOString() }),
  };
}

/**
 * Status of a submit response (decision #43). A PENDING or FAILED transaction is not reachable here: PENDING only
 * exists inside the SQL transaction, and FAILED is set by the queue consumer (M7); both would be a bug.
 */
export function submitStatusCode(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.Failed:
      throw new Error(`A ${status} transaction cannot be answered over HTTP`);
    default: {
      const unhandled: never = status;
      throw new Error(`Unclassified status: ${String(unhandled)}`);
    }
  }
}
