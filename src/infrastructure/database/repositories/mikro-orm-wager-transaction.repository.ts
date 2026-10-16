import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql';
import type {
  PersistedWagerTransaction,
  WagerTransactionRepository,
} from '../../../application/ports/wager-transaction.repository';
import type { Money } from '../../../domain/shared/money';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/transaction/wager-transaction';
import { rowToPersistedTransaction, transactionToRow } from '../mappers/wager-transaction.mapper';
import { type WagerTransactionRow, WagerTransactionSchema } from '../rows/wager-transaction.row';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionToRow(transaction));
  }

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .insert(transactionToRow(transaction))
      .onConflict()
      .ignore()
      .execute('run');
    return result.affectedRows === 1;
  }

  findById(id: string): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<PersistedWagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
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
