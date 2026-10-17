import { describe, expect, it } from 'bun:test';
import { DomainError } from '../shared/domain-error';
import { WalletBalanceChanged } from '../events/wallet-balance-changed';
import { Money } from '../shared/money';
import { DEFAULT_OUTBOX_RETRY_POLICY, OutboxMessage } from './outbox-message';
import { Wallet } from '../wallet/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');

function newMessage(): OutboxMessage {
  const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: t0 });
  const entry = wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('10.00'), now: t0 });
  const event = WalletBalanceChanged.from(wallet, entry, { eventId: 'ev1', correlationId: 'c1', occurredAt: t0 });
  return OutboxMessage.enqueue(event);
}

describe('OutboxMessage', () => {
  describe('enqueue', () => {
    it('uses the event id as row id and the serialized envelope as payload', () => {
      const msg = newMessage();
      expect(msg.id).toBe('ev1');
      expect(msg.aggregateId).toBe('w1');
      expect(msg.eventType).toBe('WalletBalanceChanged');
      expect(msg.payload).toMatchObject({ eventId: 'ev1', eventType: 'WalletBalanceChanged', version: 1 });
      expect(msg.occurredAt).toEqual(t0);
      expect(msg.attempts).toBe(0);
      expect(msg.isPending()).toBe(true);
    });

    it('is due immediately', () => {
      expect(newMessage().isDue(t0)).toBe(true);
    });
  });

  describe('scheduleRetry', () => {
    it('counts the attempt and schedules the next one with backoff', () => {
      const msg = newMessage();
      msg.scheduleRetry(t0);
      expect(msg.attempts).toBe(1);
      expect(msg.nextAttemptAt).toEqual(new Date(t0.getTime() + 1_000));
      msg.scheduleRetry(t0);
      expect(msg.nextAttemptAt).toEqual(new Date(t0.getTime() + 2_000));
    });

    it('is not due before nextAttemptAt and due from then on', () => {
      const msg = newMessage();
      msg.scheduleRetry(t0);
      expect(msg.isDue(new Date(t0.getTime() + 999))).toBe(false);
      expect(msg.isDue(new Date(t0.getTime() + 1_000))).toBe(true);
    });

    it('caps the delay', () => {
      const msg = newMessage();
      for (let i = 0; i < 12; i++) msg.scheduleRetry(t0);
      expect(msg.nextAttemptAt).toEqual(new Date(t0.getTime() + DEFAULT_OUTBOX_RETRY_POLICY.capMs));
    });

    it('parks the message at the 20th failed attempt, not before', () => {
      const msg = newMessage();
      for (let i = 0; i < 19; i++) msg.scheduleRetry(t0);
      expect(msg.isPending()).toBe(true);
      expect(msg.failedAt).toBeUndefined();

      const at = new Date('2026-01-01T01:00:00Z');
      msg.scheduleRetry(at);
      expect(msg.attempts).toBe(20);
      expect(msg.isFailed()).toBe(true);
      expect(msg.failedAt).toEqual(at);
      expect(msg.isPending()).toBe(false);
      expect(msg.nextAttemptAt).toBeUndefined();
    });

    it('a parked message is never due and cannot change any more', () => {
      const msg = newMessage();
      for (let i = 0; i < 20; i++) msg.scheduleRetry(t0);
      expect(msg.isDue(new Date('2099-01-01T00:00:00Z'))).toBe(false);
      expect(() => msg.scheduleRetry(t0)).toThrow(DomainError);
      expect(() => msg.markPublished(t0)).toThrow(DomainError);
      expect(msg.attempts).toBe(20);
    });

    it('honours a custom policy', () => {
      const msg = newMessage();
      const policy = { baseMs: 10, capMs: 100, maxAttempts: 2 };
      msg.scheduleRetry(t0, policy);
      expect(msg.nextAttemptAt).toEqual(new Date(t0.getTime() + 10));
      msg.scheduleRetry(t0, policy);
      expect(msg.isFailed()).toBe(true);
    });
  });

  describe('requeue', () => {
    it('brings a parked message back as pending, due now, with a fresh attempt count', () => {
      const msg = newMessage();
      for (let i = 0; i < 20; i++) msg.scheduleRetry(t0);
      msg.requeue();
      expect(msg.isPending()).toBe(true);
      expect(msg.failedAt).toBeUndefined();
      expect(msg.attempts).toBe(0);
      expect(msg.isDue(t0)).toBe(true);
    });

    it('is refused for a message that is pending or published', () => {
      const pending = newMessage();
      expect(() => pending.requeue()).toThrow(DomainError);
      const published = newMessage();
      published.markPublished(t0);
      expect(() => published.requeue()).toThrow(DomainError);
    });
  });

  describe('markPublished', () => {
    it('ends the lifecycle', () => {
      const msg = newMessage();
      const at = new Date('2026-01-01T00:00:03Z');
      msg.scheduleRetry(t0);
      msg.markPublished(at);
      expect(msg.publishedAt).toEqual(at);
      expect(msg.isPending()).toBe(false);
      expect(msg.isDue(at)).toBe(false);
      expect(msg.nextAttemptAt).toBeUndefined();
    });

    it('cannot be published twice or retried afterwards', () => {
      const msg = newMessage();
      msg.markPublished(t0);
      expect(() => msg.markPublished(t0)).toThrow(DomainError);
      expect(() => msg.scheduleRetry(t0)).toThrow(DomainError);
    });
  });

  it('rehydrate restores state as given', () => {
    const msg = OutboxMessage.rehydrate({
      id: 'x', aggregateId: 'w', eventType: 'T', payload: {}, occurredAt: t0,
      attempts: 7, nextAttemptAt: t0, publishedAt: undefined, failedAt: undefined,
    });
    expect(msg.attempts).toBe(7);
    expect(msg.isPending()).toBe(true);
  });
});
