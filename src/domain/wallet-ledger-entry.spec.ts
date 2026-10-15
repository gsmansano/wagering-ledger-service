import { describe, expect, it } from 'bun:test';
import { DomainError } from './domain-error';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const base = {
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('WalletLedgerEntry', () => {
  it('creates a balanced debit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('70.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a balanced credit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('130.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects arithmetic that does not add up', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(DomainError);
  });

  it('rejects a direction that contradicts the balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('70.00'),
      }),
    ).toThrow(DomainError);
  });

  it('rejects zero and negative amounts', () => {
    for (const money of [Money.zero('BRL'), brl('1.00').negate()]) {
      expect(() =>
        WalletLedgerEntry.create({
          ...base,
          direction: LedgerDirection.Credit,
          money,
          balanceBefore: brl('100.00'),
          balanceAfter: brl('100.00'),
        }),
      ).toThrow(DomainError);
    }
  });

  it('rejects negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('20.00').negate(),
      }),
    ).toThrow(DomainError);
  });

  it('rejects mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '1.00', currency: 'USD' }),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('101.00'),
      }),
    ).toThrow(DomainError);
  });

  it('rehydrate does not re-validate', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('80.00'),
    });
    expect(entry.isBalanced()).toBe(false);
  });
});
