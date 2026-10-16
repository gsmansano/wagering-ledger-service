import { describe, expect, it } from 'bun:test';
import { DomainError } from '../shared/domain-error';
import { InsufficientFundsError } from './insufficient-funds-error';
import { Money } from '../shared/money';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:05:00Z');

const openWallet = (balance = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(balance), now: t0 });
const move = (amount: string, entryId = 'e1') => ({
  entryId,
  transactionId: 't1',
  money: brl(amount),
  now: t1,
});

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with the initial balance and its currency', () => {
      const wallet = openWallet();
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.createdAt).toEqual(t0);
      expect(wallet.updatedAt).toEqual(t0);
    });

    it('rejects an empty playerId and a negative initial balance', () => {
      expect(() => Wallet.open({ id: 'w', playerId: ' ', initialBalance: brl('1.00'), now: t0 })).toThrow(DomainError);
      expect(() =>
        Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), now: t0 }),
      ).toThrow(DomainError);
    });
  });

  describe('debit', () => {
    it('lowers the balance, bumps the version and returns a matching entry', () => {
      const wallet = openWallet();
      const entry = wallet.debit(move('30.00'));
      expect(wallet.balance.equals(brl('70.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(t1);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.walletId).toBe('w1');
      expect(entry.transactionId).toBe('t1');
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    it('allows draining the balance to exactly zero', () => {
      const wallet = openWallet();
      wallet.debit(move('100.00'));
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('throws InsufficientFundsError and leaves the wallet untouched', () => {
      const wallet = openWallet();
      expect(() => wallet.debit(move('100.01'))).toThrow(InsufficientFundsError);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(t0);
    });

    it('is still a DomainError so callers can catch broadly', () => {
      expect(() => openWallet().debit(move('200.00'))).toThrow(DomainError);
    });
  });

  describe('credit', () => {
    it('raises the balance, bumps the version and returns a matching entry', () => {
      const wallet = openWallet();
      const entry = wallet.credit(move('25.50'));
      expect(wallet.balance.equals(brl('125.50'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });
  });

  describe('invalid movements', () => {
    it.each(['debit', 'credit'] as const)('%s rejects a currency mismatch without changing state', (op) => {
      const wallet = openWallet();
      const usd = { ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
      expect(() => wallet[op](usd)).toThrow(DomainError);
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it.each(['debit', 'credit'] as const)('%s rejects zero and negative amounts', (op) => {
      const wallet = openWallet();
      expect(() => wallet[op]({ ...move('1.00'), money: Money.zero('BRL') })).toThrow(DomainError);
      expect(() => wallet[op]({ ...move('1.00'), money: brl('1.00').negate() })).toThrow(DomainError);
      expect(wallet.version).toBe(1);
    });
  });

  it('version increments once per balance change', () => {
    const wallet = openWallet();
    wallet.credit(move('10.00', 'e1'));
    wallet.debit(move('5.00', 'e2'));
    expect(wallet.version).toBe(3);
  });

  it('rehydrate restores state as given, without validation', () => {
    const wallet = Wallet.rehydrate({
      id: 'w9',
      playerId: 'p9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: t0,
      updatedAt: t1,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.equals(brl('42.00'))).toBe(true);
    expect(wallet.updatedAt).toEqual(t1);
  });
});
