import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '../../../application/ports/wallet.repository';
import type { Wallet } from '../../../domain/wallet/wallet';
import { rowToWallet, walletToRow } from '../mappers/wallet.mapper';
import { WalletSchema } from '../rows/wallet.row';

// `refresh: true` on reads: inside a transaction a wallet may have been changed
// by this same unit of work, and the Identity Map must not serve the old row.
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletToRow(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletSchema, { id }, { refresh: true });
    return row ? rowToWallet(row) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletSchema, { playerId, currency }, { refresh: true });
    return row ? rowToWallet(row) : undefined;
  }

  async update(wallet: Wallet): Promise<void> {
    const { balance, version, updatedAt } = walletToRow(wallet);
    await this.em.nativeUpdate(WalletSchema, { id: wallet.id }, { balance, version, updatedAt });
  }
}
