import { EntitySchema } from '@mikro-orm/core';

export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

// Composite primary key (consumer_name, message_id): the database is what
// guarantees a consumer records a message once.
export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  name: 'InboxMessageRow',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { type: Date, columnType: 'timestamptz' },
    processedAt: { type: Date, columnType: 'timestamptz', nullable: true },
  },
});
