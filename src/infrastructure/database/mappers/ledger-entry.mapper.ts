import { Money } from '../../../domain/shared/money';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import type { LedgerEntryRow } from '../rows/ledger-entry.row';

export function entryToRow(entry: WalletLedgerEntry): LedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

// The currency is not stored on the ledger row: it is the wallet's currency,
// which the caller passes in so the entry can be rebuilt with typed money.
export function rowToEntry(row: LedgerEntryRow, currency: string): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction,
    money: Money.from({ amount: row.amount, currency }),
    balanceBefore: Money.from({ amount: row.balanceBefore, currency }),
    balanceAfter: Money.from({ amount: row.balanceAfter, currency }),
    createdAt: row.createdAt,
  });
}
