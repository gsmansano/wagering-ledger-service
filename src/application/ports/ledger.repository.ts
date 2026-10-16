import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

/** An entry with its position in the wallet's ledger (1, 2, 3 ...): the order the entries were applied in. */
export interface LedgerRecord {
  entry: WalletLedgerEntry;
  sequence: number;
}

export interface LedgerRepository {
  /**
   * Append-only: there is no update or delete, and the database refuses both. Assigns the next sequence of the
   * wallet, so it must be called while holding the wallet lock (a missed lock fails on the unique constraint).
   */
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Entries with a sequence greater than `afterSequence` (or from the start), in application order. */
  page(walletId: string, options: { afterSequence?: number; limit: number }): Promise<LedgerRecord[]>;
}
