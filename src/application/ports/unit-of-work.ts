import type { InboxRepository } from './inbox.repository';
import type { LedgerRepository } from './ledger.repository';
import type { OutboxRepository } from './outbox.repository';
import type { WagerTransactionRepository } from './wager-transaction.repository';
import type { WalletRepository } from './wallet.repository';

/** Repositories bound to one SQL transaction. */
export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Runs `work` in one SQL transaction: commits if it resolves, rolls back if it throws. */
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

/** Nest injection token for the `UnitOfWork` port. */
export const UNIT_OF_WORK = Symbol('UnitOfWork');
