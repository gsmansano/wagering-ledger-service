import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../../application/ports/outbox.repository';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { outboxToRow, rowToOutbox } from '../mappers/outbox-message.mapper';
import { OutboxMessageSchema } from '../rows/outbox-message.row';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageSchema, outboxToRow(message));
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const row = await this.em.findOne(OutboxMessageSchema, { id }, { refresh: true });
    return row ? rowToOutbox(row) : undefined;
  }

  // `sequence` is not part of the row schema (a persistence concern, as for the ledger), so plain SQL. Parked rows
  // count as unpublished in the NOT EXISTS, which is what makes a parked event block its wallet. A row another
  // publisher holds is still unpublished until that transaction commits, so it holds back its wallet's later rows too.
  async claimNext(now: Date): Promise<OutboxMessage | undefined> {
    const rows = await this.em.execute<{ id: string }[]>(
      `select o.id from outbox_messages o
        where o.published_at is null and o.failed_at is null
          and (o.next_attempt_at is null or o.next_attempt_at <= ?)
          and not exists (
            select 1 from outbox_messages earlier
             where earlier.aggregate_id = o.aggregate_id
               and earlier.sequence < o.sequence
               and earlier.published_at is null)
        order by o.sequence
        limit 1
        for update of o skip locked`,
      [now],
    );
    const id = rows[0]?.id;
    return id === undefined ? undefined : this.findById(id);
  }

  async update(message: OutboxMessage): Promise<void> {
    const { attempts, nextAttemptAt, publishedAt, failedAt } = outboxToRow(message);
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      { attempts, nextAttemptAt, publishedAt, failedAt },
    );
  }
}
