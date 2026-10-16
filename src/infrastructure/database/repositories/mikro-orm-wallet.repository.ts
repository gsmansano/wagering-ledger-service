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

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(WalletSchema)
      .insert(walletToRow(wallet))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletSchema, { id }, { refresh: true });
    return row ? rowToWallet(row) : undefined;
  }

  // FOR NO KEY UPDATE, not FOR UPDATE: it still makes writers of the same wallet queue, but it does not conflict
  // with the FOR KEY SHARE lock that inserting a row referencing the wallet (a transaction, a ledger entry) takes.
  // With FOR UPDATE, two requests that had both inserted their transaction row would each wait for the other's
  // share lock and PostgreSQL would abort one with a deadlock. We never change the wallet's key, so this is enough.
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const locked = await this.em.execute('select id from wallets where id = ? for no key update', [id]);
    if (locked.length === 0) return undefined;
    // A separate statement after the lock, so it reads the latest committed row (READ COMMITTED).
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
