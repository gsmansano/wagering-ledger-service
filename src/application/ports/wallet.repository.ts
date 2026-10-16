import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  /** Fails on a duplicate id or a second wallet for the same player and currency. */
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  /** Persists the balance, version and updatedAt of an existing wallet. */
  update(wallet: Wallet): Promise<void>;
}
