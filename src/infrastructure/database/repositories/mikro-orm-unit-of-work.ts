import type { EntityManager } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../../application/ports/unit-of-work';
import { MikroOrmLedgerRepository } from './mikro-orm-ledger.repository';
import { MikroOrmWagerTransactionRepository } from './mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository';

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  // `transactional` forks the EntityManager, so every run gets its own Identity
  // Map and its own connection; concurrent runs never share state.
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.em.transactional((tx) =>
      work({
        wallets: new MikroOrmWalletRepository(tx),
        transactions: new MikroOrmWagerTransactionRepository(tx),
        ledger: new MikroOrmLedgerRepository(tx),
      }),
    );
  }
}
