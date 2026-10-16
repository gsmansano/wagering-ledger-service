import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerReconciliation, LedgerRecord, LedgerRepository } from '../../../application/ports/ledger.repository';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { entryToRow, rowToEntry } from '../mappers/ledger-entry.mapper';
import { LedgerEntrySchema } from '../rows/ledger-entry.row';
import { WalletSchema } from '../rows/wallet.row';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  // Two statements are safe because the caller holds the wallet lock, so nobody else appends to this wallet in
  // between; (wallet_id, sequence) is unique, so a caller that forgot the lock fails instead of duplicating.
  async append(entry: WalletLedgerEntry): Promise<void> {
    const [row] = await this.em.execute<{ next: number }[]>(
      'select coalesce(max(sequence), 0) + 1 as next from ledger_entries where wallet_id = ?',
      [entry.walletId],
    );
    await this.em.insert(LedgerEntrySchema, entryToRow(entry, Number(row!.next)));
  }

  async page(walletId: string, options: { afterSequence?: number; limit: number }): Promise<LedgerRecord[]> {
    // Ledger rows carry no currency: it is the wallet's.
    const wallet = await this.em.findOne(WalletSchema, { id: walletId }, { refresh: true });
    if (!wallet) return [];

    // Keyset pagination on the per-wallet sequence: stable under inserts, unlike OFFSET, and exact, unlike timestamps.
    const { afterSequence, limit } = options;
    const rows = await this.em.find(
      LedgerEntrySchema,
      afterSequence === undefined ? { walletId } : { walletId, sequence: { $gt: afterSequence } },
      { orderBy: { sequence: 'asc' }, limit, refresh: true },
    );
    return rows.map((row) => ({ entry: rowToEntry(row, wallet.currency), sequence: row.sequence }));
  }

  async reconcile(walletId: string): Promise<LedgerReconciliation | undefined> {
    // numeric arithmetic stays in PostgreSQL and comes back as strings: money never passes through a JS number.
    const [row] = await this.em.execute<
      { currency: string; stored: string; calculated: string; difference: string; consistent: boolean; entries: string }[]
    >(
      `select w.currency,
              w.balance as stored,
              coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0.00)::numeric(19,2) as calculated,
              (w.balance - coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0.00))::numeric(19,2) as difference,
              w.balance = coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0.00) as consistent,
              count(e.id) as entries
         from wallets w
         left join ledger_entries e on e.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (row === undefined) return undefined;
    return {
      currency: row.currency,
      storedBalance: row.stored,
      calculatedBalance: row.calculated,
      difference: row.difference,
      consistent: row.consistent,
      checkedEntries: Number(row.entries),
    };
  }
}
