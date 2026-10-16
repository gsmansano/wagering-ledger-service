import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerCursor, LedgerRepository } from '../../../application/ports/ledger.repository';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { entryToRow, rowToEntry } from '../mappers/ledger-entry.mapper';
import { LedgerEntrySchema } from '../rows/ledger-entry.row';
import { WalletSchema } from '../rows/wallet.row';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, entryToRow(entry));
  }

  async page(walletId: string, options: { after?: LedgerCursor; limit: number }): Promise<WalletLedgerEntry[]> {
    // Ledger rows carry no currency: it is the wallet's.
    const wallet = await this.em.findOne(WalletSchema, { id: walletId }, { refresh: true });
    if (!wallet) return [];

    const { after, limit } = options;
    // Keyset pagination on (createdAt, id): stable under inserts, unlike OFFSET.
    const rows = await this.em.find(
      LedgerEntrySchema,
      after
        ? {
            walletId,
            $or: [
              { createdAt: { $gt: after.createdAt } },
              { createdAt: after.createdAt, id: { $gt: after.id } },
            ],
          }
        : { walletId },
      { orderBy: { createdAt: 'asc', id: 'asc' }, limit, refresh: true },
    );
    return rows.map((row) => rowToEntry(row, wallet.currency));
  }
}
