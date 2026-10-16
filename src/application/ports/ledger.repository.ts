import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

/** An entry with its position in the wallet's ledger (1, 2, 3 ...): the order the entries were applied in. */
export interface LedgerRecord {
  entry: WalletLedgerEntry;
  sequence: number;
}

/** A wallet's stored balance next to the balance rebuilt from its ledger, as decimal strings (decision #47). */
export interface LedgerReconciliation {
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  /** stored - calculated; "0.00" when consistent. May be negative. */
  difference: string;
  /** Decided by PostgreSQL as numeric equality, not by comparing strings. */
  consistent: boolean;
  checkedEntries: number;
}

export interface LedgerRepository {
  /**
   * Append-only: there is no update or delete, and the database refuses both. Assigns the next sequence of the
   * wallet, so it must be called while holding the wallet lock (a missed lock fails on the unique constraint).
   */
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Entries with a sequence greater than `afterSequence` (or from the start), in application order. */
  page(walletId: string, options: { afterSequence?: number; limit: number }): Promise<LedgerRecord[]>;
  /**
   * Compares the wallet's balance with the signed sum of its ledger in ONE statement, so both sides come from the
   * same snapshot and a concurrent write cannot fake a divergence. Takes no lock. Undefined for an unknown wallet.
   */
  reconcile(walletId: string): Promise<LedgerReconciliation | undefined>;
}
