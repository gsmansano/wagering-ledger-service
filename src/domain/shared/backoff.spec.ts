import { describe, expect, it } from 'bun:test';
import { exponentialBackoffMs } from './backoff';
import { DomainError } from './domain-error';

describe('exponentialBackoffMs', () => {
  it('doubles from the base', () => {
    expect([1, 2, 3, 4, 5].map((n) => exponentialBackoffMs(n, 1_000, 300_000))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it('never exceeds the cap, even for huge attempt counts', () => {
    expect(exponentialBackoffMs(10, 1_000, 300_000)).toBe(300_000);
    expect(exponentialBackoffMs(5_000, 1_000, 300_000)).toBe(300_000);
  });

  it('rejects invalid input', () => {
    expect(() => exponentialBackoffMs(0, 1_000, 5_000)).toThrow(DomainError);
    expect(() => exponentialBackoffMs(1.5, 1_000, 5_000)).toThrow(DomainError);
    expect(() => exponentialBackoffMs(1, 0, 5_000)).toThrow(DomainError);
    expect(() => exponentialBackoffMs(1, 5_000, 1_000)).toThrow(DomainError);
  });
});
