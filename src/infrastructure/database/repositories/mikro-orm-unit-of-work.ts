import type { EntityManager } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../../application/ports/unit-of-work';
import { MikroOrmInboxRepository } from './mikro-orm-inbox.repository';
import { MikroOrmLedgerRepository } from './mikro-orm-ledger.repository';
import { MikroOrmOutboxRepository } from './mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from './mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository';

export class MikroOrmUnitOfWork implements UnitOfWork {
  /** `walletLockTimeoutMs` bounds the wait for a wallet lock (decision #65); 0 waits without limit. */
  constructor(
    private readonly em: EntityManager,
    private readonly walletLockTimeoutMs = 0,
  ) {}

  // `transactional` forks the EntityManager, so every run gets its own Identity
  // Map and its own connection; concurrent runs never share state.
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.em.transactional((tx) =>
      work({
        wallets: new MikroOrmWalletRepository(tx, this.walletLockTimeoutMs),
        transactions: new MikroOrmWagerTransactionRepository(tx),
        ledger: new MikroOrmLedgerRepository(tx),
        inbox: new MikroOrmInboxRepository(tx),
        outbox: new MikroOrmOutboxRepository(tx),
      }),
    );
  }
}
