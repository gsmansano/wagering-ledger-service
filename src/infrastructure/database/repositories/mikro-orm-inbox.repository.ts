import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../../application/ports/inbox.repository';
import type { InboxMessage } from '../../../domain/messaging/inbox-message';
import { inboxToRow, rowToInbox } from '../mappers/inbox-message.mapper';
import { InboxMessageSchema } from '../rows/inbox-message.row';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageSchema, inboxToRow(message));
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxMessageSchema, { consumerName, messageId }, { refresh: true });
    return row ? rowToInbox(row) : undefined;
  }

  async update(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}
