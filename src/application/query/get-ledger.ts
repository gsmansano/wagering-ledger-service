import type { LedgerRecord } from '../ports/ledger.repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import { WalletNotFoundError } from '../wallet/wallet-not-found.error';

export interface LedgerPage {
  entries: LedgerRecord[];
  /** Sequence of the last entry returned when more follow; undefined on the last page. */
  nextAfterSequence: number | undefined;
}

/** One page of a wallet's ledger in the order the entries were applied (keyset on the sequence, decision #46). */
export class GetLedger {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string, options: { afterSequence?: number; limit: number }): Promise<LedgerPage> {
    return this.unitOfWork.run(async (repos) => {
      if ((await repos.wallets.findById(walletId)) === undefined) throw new WalletNotFoundError(walletId);
      // One extra row tells whether another page exists, without a count query.
      const rows = await repos.ledger.page(walletId, { ...options, limit: options.limit + 1 });
      const entries = rows.slice(0, options.limit);
      const hasMore = rows.length > options.limit;
      return { entries, nextAfterSequence: hasMore ? entries[entries.length - 1]!.sequence : undefined };
    });
  }
}
