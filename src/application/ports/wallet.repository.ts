import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  /** Fails on a duplicate id or a second wallet for the same player and currency. */
  insert(wallet: Wallet): Promise<void>;
  /** Inserts unless a unique constraint is hit; false means the wallet (or its player and currency) already exists. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * Locks the wallet row (`FOR NO KEY UPDATE`, see the adapter) and reads it. Must be called inside a unit of work: the row stays locked
   * until it commits or rolls back, and other transactions locking the same wallet wait.
   */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  /** Persists the balance, version and updatedAt of an existing wallet. */
  update(wallet: Wallet): Promise<void>;
}
