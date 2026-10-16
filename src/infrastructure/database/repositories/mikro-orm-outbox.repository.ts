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

  async update(message: OutboxMessage): Promise<void> {
    const { attempts, nextAttemptAt, publishedAt, failedAt } = outboxToRow(message);
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      { attempts, nextAttemptAt, publishedAt, failedAt },
    );
  }
}
