import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

/** Position in a wallet's statement; entries are ordered by (createdAt, id). */
export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export interface LedgerRepository {
  /** Append-only: there is no update or delete, and the database refuses both. */
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Entries strictly after `after` (or from the start), oldest first. */
  page(walletId: string, options: { after?: LedgerCursor; limit: number }): Promise<WalletLedgerEntry[]>;
}
