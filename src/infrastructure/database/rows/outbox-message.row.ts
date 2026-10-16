import { EntitySchema } from '@mikro-orm/core';

export interface OutboxMessageRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  failedAt: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  name: 'OutboxMessageRow',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: Date, columnType: 'timestamptz' },
    attempts: { type: 'number' },
    nextAttemptAt: { type: Date, columnType: 'timestamptz', nullable: true },
    publishedAt: { type: Date, columnType: 'timestamptz', nullable: true },
    failedAt: { type: Date, columnType: 'timestamptz', nullable: true },
  },
});
