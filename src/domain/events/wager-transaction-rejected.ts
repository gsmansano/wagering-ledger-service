import type { FailureCode } from '../failure-code';
import { WagerTransactionStatus, type WagerTransaction } from '../wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';
import { transactionEventData, type TransactionEventData } from './transaction-event-data';

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
}

/** A transaction rejected by a business rule. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const data = transactionEventData(tx, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...data, failureCode: tx.failureCode! }, // set by reject, which REJECTED requires
    });
  }
}
