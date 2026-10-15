import { describe, expect, it } from 'bun:test';
import { DomainError } from './domain-error';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('from', () => {
    it('normalizes the scale to 2 places', () => {
      expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
      expect(brl('25').toJSON().amount).toBe('25.00');
      expect(brl('25.5').equals(brl('25.50'))).toBe(true);
    });

    it.each(['', ' ', 'NaN', 'Infinity', '1e3', '1E3', '-1.00', '+1.00', '1.234', '.5', '5.', '1,00', '0x10'])(
      'rejects amount %p',
      (amount) => {
        expect(() => brl(amount)).toThrow(DomainError);
      },
    );

    it('rejects a non-string amount', () => {
      // Deliberate cast: contracts arrive as untyped JSON, so the runtime check must hold.
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(DomainError);
    });

    it.each(['', 'br', 'brl', 'BRLL', 'B1L'])('rejects currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(DomainError);
    });
  });

  describe('arithmetic', () => {
    it('is exact where floats are not', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    it('returns new instances and leaves operands untouched', () => {
      const a = brl('10.00');
      const result = a.add(brl('5.00'));
      expect(result).not.toBe(a);
      expect(a.toJSON().amount).toBe('10.00');
      expect(result.toJSON().amount).toBe('15.00');
    });

    it('subtract can go below zero and negate flips the sign', () => {
      const diff = brl('1.00').subtract(brl('3.50'));
      expect(diff.isNegative()).toBe(true);
      expect(diff.toJSON().amount).toBe('-2.50');
      expect(diff.negate().toJSON().amount).toBe('2.50');
    });

    it('throws on currency mismatch for add, subtract and isLessThan', () => {
      const usd = Money.from({ amount: '1.00', currency: 'USD' });
      expect(() => brl('1.00').add(usd)).toThrow(DomainError);
      expect(() => brl('1.00').subtract(usd)).toThrow(DomainError);
      expect(() => brl('1.00').isLessThan(usd)).toThrow(DomainError);
    });
  });

  describe('predicates', () => {
    it('classifies zero, positive and negative', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(Money.zero('BRL').isPositive()).toBe(false);
      expect(Money.zero('BRL').isNegative()).toBe(false);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('negating zero stays zero', () => {
      expect(Money.zero('BRL').negate().isNegative()).toBe(false);
      expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    });

    it('compares amounts', () => {
      expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
      expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    });

    it('treats different currencies as not equal', () => {
      expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    });
  });

  it('serializes to JSON and string', () => {
    expect(JSON.stringify({ m: brl('7') })).toBe('{"m":{"amount":"7.00","currency":"BRL"}}');
    expect(brl('7').toString()).toBe('7.00 BRL');
  });
});
