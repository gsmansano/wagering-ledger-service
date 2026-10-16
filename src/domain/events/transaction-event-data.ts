import { DomainError } from '../domain-error';
import type { MoneyProps } from '../money';
import type { WagerTransaction, WagerTransactionStatus } from '../wager-transaction';

/** Fields shared by the three transaction events. Money is MoneyProps, never a Money instance. */
export interface TransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

export function transactionEventData(tx: WagerTransaction, expected: WagerTransactionStatus): TransactionEventData {
  if (tx.status !== expected) {
    throw new DomainError(`Expected a ${expected} transaction, got ${tx.status}`);
  }
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}
