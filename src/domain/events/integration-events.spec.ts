import { describe, expect, it } from 'bun:test';
import { DomainError } from '../shared/domain-error';
import { FailureCode } from '../transaction/failure-code';
import { Money } from '../shared/money';
import { Wallet } from '../wallet/wallet';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind as Kind } from '../transaction/wager-transaction';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference';
import { WagerTransactionProcessed } from './wager-transaction-processed';
import { WagerTransactionRejected } from './wager-transaction-rejected';
import { WalletBalanceChanged } from './wallet-balance-changed';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:05:00Z');
const ctx = { eventId: 'ev1', correlationId: 'corr1', causationId: 'cause1', occurredAt: t1 };

const tx = (kind: Kind = Kind.Bet, ref?: string) =>
  WagerTransaction.create({
    id: 'tx1', providerId: 'prov', externalTransactionId: 'ext1', idempotencyKey: 'k1', payloadHash: 'h1',
    walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1', kind, money: brl('25.00'),
    referenceExternalTransactionId: ref, createdAt: t0,
  });

describe('integration events', () => {
  it('WagerTransactionProcessed carries the transaction and is keyed by wallet', () => {
    const t = tx();
    t.markProcessed(undefined, t1);
    const event = WagerTransactionProcessed.from(t, ctx);
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('w1');
    expect(event.data).toEqual({
      transactionId: 'tx1', walletId: 'w1', playerId: 'p1', providerId: 'prov', externalTransactionId: 'ext1',
      roundId: 'r1', gameId: 'g1', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
      processedAt: t1.toISOString(),
    });
  });

  it('is also raised for a LOSS', () => {
    const t = tx(Kind.Loss);
    t.markProcessed(undefined, t1);
    expect(WagerTransactionProcessed.from(t, ctx).data.kind).toBe('LOSS');
  });

  it('WagerTransactionRejected carries the failure code', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, t1);
    const event = WagerTransactionRejected.from(t, ctx);
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(event.aggregateId).toBe('w1');
  });

  it('WagerTransactionPendingReference carries the awaited reference', () => {
    const t = tx(Kind.Refund, 'ext0');
    t.markPendingReference();
    const event = WagerTransactionPendingReference.from(t, ctx);
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data.referenceExternalTransactionId).toBe('ext0');
  });

  it('WalletBalanceChanged follows the specified shape', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: t0 });
    const entry = wallet.debit({ entryId: 'e1', transactionId: 'tx1', money: brl('25.00'), now: t1 });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.aggregateId).toBe('w1');
    expect(event.data).toEqual({
      walletId: 'w1', transactionId: 'tx1', direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('refuses a ledger entry from another wallet', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: t0 });
    const other = Wallet.open({ id: 'w2', playerId: 'p2', initialBalance: brl('100.00'), now: t0 });
    const entry = other.debit({ entryId: 'e1', transactionId: 'tx1', money: brl('1.00'), now: t1 });
    expect(() => WalletBalanceChanged.from(wallet, entry, ctx)).toThrow(DomainError);
  });

  it('refuses a transaction in the wrong status', () => {
    expect(() => WagerTransactionProcessed.from(tx(), ctx)).toThrow(DomainError);
    expect(() => WagerTransactionRejected.from(tx(), ctx)).toThrow(DomainError);
    expect(() => WagerTransactionPendingReference.from(tx(), ctx)).toThrow(DomainError);
  });

  describe('toJSON envelope', () => {
    it('serializes time as ISO-8601 and keeps type and version', () => {
      const t = tx();
      t.reject(FailureCode.InsufficientFunds, t1);
      const json = WagerTransactionRejected.from(t, ctx).toJSON();
      expect(json).toMatchObject({
        eventId: 'ev1', eventType: 'WagerTransactionRejected', aggregateId: 'w1',
        correlationId: 'corr1', causationId: 'cause1', occurredAt: '2026-01-01T00:05:00.000Z', version: 1,
      });
    });

    it('omits causationId when absent and survives a JSON round trip', () => {
      const t = tx();
      t.reject(FailureCode.InsufficientFunds, t1);
      const event = WagerTransactionRejected.from(t, { eventId: 'ev2', correlationId: 'c', occurredAt: t1 });
      const json = event.toJSON();
      expect('causationId' in json).toBe(false);
      expect(JSON.parse(JSON.stringify(event))).toEqual(JSON.parse(JSON.stringify(json)));
    });
  });
});
