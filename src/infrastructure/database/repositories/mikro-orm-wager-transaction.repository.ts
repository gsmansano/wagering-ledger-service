import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql';
import type {
  PersistedWagerTransaction,
  WagerTransactionRepository,
} from '../../../application/ports/wager-transaction.repository';
import type { Money } from '../../../domain/shared/money';
import type { WagerTransaction } from '../../../domain/transaction/wager-transaction';
import { rowToPersistedTransaction, transactionToRow } from '../mappers/wager-transaction.mapper';
import { type WagerTransactionRow, WagerTransactionSchema } from '../rows/wager-transaction.row';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionToRow(transaction));
  }

  findById(id: string): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async update(transaction: WagerTransaction, balanceAfter?: Money): Promise<void> {
    const { status, referenceTransactionId, failureCode, balanceAfter: balance, processedAt } = transactionToRow(
      transaction,
      balanceAfter,
    );
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      { status, referenceTransactionId, failureCode, balanceAfter: balance, processedAt },
    );
  }

  private async findOne(where: FilterQuery<WagerTransactionRow>): Promise<PersistedWagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionSchema, where, { refresh: true });
    return row ? rowToPersistedTransaction(row) : undefined;
  }
}
