import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '../../../application/ports/wallet.repository';
import { WalletLockTimeoutError } from '../../../application/wallet/wallet-lock-timeout.error';
import { WalletVersionConflictError } from '../../../application/wallet/wallet-version-conflict.error';
import type { Wallet } from '../../../domain/wallet/wallet';
import { hasDatabaseCode } from '../transient-errors';
import { rowToWallet, walletToRow } from '../mappers/wallet.mapper';
import { WalletSchema } from '../rows/wallet.row';

const QUERY_CANCELED = '57014'; // raised when `statement_timeout` expires

// `refresh: true` on reads: inside a transaction a wallet may have been changed
// by this same unit of work, and the Identity Map must not serve the old row.
export class MikroOrmWalletRepository implements WalletRepository {
  /** `lockTimeoutMs` bounds the whole wait for the lock; 0 waits as long as it takes. */
  constructor(
    private readonly em: EntityManager,
    private readonly lockTimeoutMs = 0,
  ) {}

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
  //
  // The wait is bounded by `statement_timeout` (decision #65), set for this statement only and put back right after the
  // lock is taken, so nothing else in the transaction inherits it. It is `statement_timeout`, not `lock_timeout`, on
  // purpose: `lock_timeout` limits each single wait step, and in a queue behind a hot wallet every step is only the
  // previous holder's turn, so it never fires. `statement_timeout` limits the whole statement, queue included.
  // PostgreSQL then cancels it (57014) and the transaction rolls back; the caller reports a retryable 503.
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const previous = await this.limitLockWait();
    let locked: unknown[];
    try {
      locked = await this.em.execute('select id from wallets where id = ? for no key update', [id]);
    } catch (error) {
      if (hasDatabaseCode(error, QUERY_CANCELED)) throw new WalletLockTimeoutError(id, { cause: error });
      throw error;
    }
    if (previous !== undefined) await this.em.execute(`select set_config('statement_timeout', ?, true)`, [previous]);
    if (locked.length === 0) return undefined;
    // A separate statement after the lock, so it reads the latest committed row (READ COMMITTED).
    const row = await this.em.findOne(WalletSchema, { id }, { refresh: true });
    return row ? rowToWallet(row) : undefined;
  }

  /** Applies the timeout to the current transaction and returns the value to put back, or undefined when disabled. */
  private async limitLockWait(): Promise<string | undefined> {
    if (this.lockTimeoutMs <= 0) return undefined;
    const [row] = await this.em.execute<{ previous: string }[]>(
      `select current_setting('statement_timeout') as previous, set_config('statement_timeout', ?, true)`,
      [`${this.lockTimeoutMs}ms`],
    );
    return row!.previous; // a SELECT without FROM returns exactly one row
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletSchema, { playerId, currency }, { refresh: true });
    return row ? rowToWallet(row) : undefined;
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const { balance, version, updatedAt } = walletToRow(wallet);
    const updated = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance, version, updatedAt },
    );
    if (updated !== 1) throw new WalletVersionConflictError(wallet.id, expectedVersion);
  }
}
