import { WagerTransactionStatus, type WagerTransaction } from '../wager-transaction';
import { IntegrationEvent, type EventContext } from './integration-event';
import { transactionEventData, type TransactionEventData } from './transaction-event-data';

export interface WagerTransactionProcessedData extends TransactionEventData {
  processedAt: string; // ISO-8601
}

/** Any applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const data = transactionEventData(tx, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...data, processedAt: tx.processedAt!.toISOString() }, // set by markProcessed, which PROCESSED requires
    });
  }
}
