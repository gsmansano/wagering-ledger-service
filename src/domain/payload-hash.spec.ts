import { describe, expect, it } from 'bun:test';
import { DomainError } from './domain-error';
import { payloadHash, type WagerPayload } from './payload-hash';
import { WagerTransactionKind } from './wager-transaction';

const payload: WagerPayload = {
  providerId: 'prov',
  externalTransactionId: 'ext1',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'r1',
  gameId: 'g1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payloadHash', () => {
  it('is a lowercase hex SHA-256', () => {
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same payload, whatever the property order', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerPayload;
    expect(payloadHash(reordered)).toBe(payloadHash(payload));
  });

  it('treats "25.5" and "25.50" as the same payload', () => {
    const a = payloadHash({ ...payload, money: { amount: '25.5', currency: 'BRL' } });
    const b = payloadHash({ ...payload, money: { amount: '25.50', currency: 'BRL' } });
    expect(a).toBe(b);
  });

  it.each([
    ['providerId', { providerId: 'other' }],
    ['externalTransactionId', { externalTransactionId: 'ext2' }],
    ['playerId', { playerId: 'p2' }],
    ['walletId', { walletId: 'w2' }],
    ['roundId', { roundId: 'r2' }],
    ['gameId', { gameId: 'g2' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['reference', { referenceExternalTransactionId: 'ext0' }],
  ] as [string, Partial<WagerPayload>][])('changes when %s changes', (_name, change) => {
    expect(payloadHash({ ...payload, ...change })).not.toBe(payloadHash(payload));
  });

  it('ignores properties outside the business fields', () => {
    const noisy = { ...payload, messageId: 'sqs-1', correlationId: 'c1' } as WagerPayload;
    expect(payloadHash(noisy)).toBe(payloadHash(payload));
  });

  it('an absent reference differs from a present one but not from an explicit undefined', () => {
    expect(payloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(payloadHash(payload));
  });

  it('rejects an invalid amount', () => {
    expect(() => payloadHash({ ...payload, money: { amount: '1e3', currency: 'BRL' } })).toThrow(DomainError);
  });
});
