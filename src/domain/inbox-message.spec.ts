import { describe, expect, it } from 'bun:test';
import { DomainError } from './domain-error';
import { InboxMessage } from './inbox-message';

const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:05Z');
const receive = () => InboxMessage.receive({ messageId: 'm1', consumerName: 'wagering', payloadHash: 'h', receivedAt: t0 });

describe('InboxMessage', () => {
  it('is received unprocessed', () => {
    const msg = receive();
    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();
  });

  it('markProcessed records the time', () => {
    const msg = receive();
    msg.markProcessed(t1);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(t1);
  });

  it('cannot be processed twice, and the first time is kept', () => {
    const msg = receive();
    msg.markProcessed(t1);
    expect(() => msg.markProcessed(new Date())).toThrow(DomainError);
    expect(msg.processedAt).toEqual(t1);
  });

  it.each(['messageId', 'consumerName', 'payloadHash'] as const)('rejects an empty %s', (field) => {
    expect(() =>
      InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: t0, [field]: ' ' }),
    ).toThrow(DomainError);
  });

  it('rehydrate restores a processed message as given', () => {
    const msg = InboxMessage.rehydrate({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: t0, processedAt: t1 });
    expect(msg.isProcessed()).toBe(true);
  });
});
