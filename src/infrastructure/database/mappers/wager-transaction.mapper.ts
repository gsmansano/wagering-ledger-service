import { Money } from '../../../domain/shared/money';
import { WagerTransaction } from '../../../domain/transaction/wager-transaction';
import type { PersistedWagerTransaction } from '../../../application/ports/wager-transaction.repository';
import type { WagerTransactionRow } from '../rows/wager-transaction.row';

export function transactionToRow(transaction: WagerTransaction, balanceAfter?: Money): WagerTransactionRow {
  const { amount, currency } = transaction.money.toJSON();
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount,
    currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    balanceAfter: balanceAfter?.toJSON().amount ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

export function rowToPersistedTransaction(row: WagerTransactionRow): PersistedWagerTransaction {
  return {
    transaction: WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      createdAt: row.createdAt,
      status: row.status,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
      failureCode: row.failureCode ?? undefined,
      processedAt: row.processedAt ?? undefined,
    }),
    balanceAfter:
      row.balanceAfter === null ? undefined : Money.from({ amount: row.balanceAfter, currency: row.currency }),
  };
}
