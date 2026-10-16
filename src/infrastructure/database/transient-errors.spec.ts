import { describe, expect, it } from 'bun:test';
import { isTransientDatabaseError } from './transient-errors';

const withCode = (code: string, message = 'boom') => Object.assign(new Error(message), { code });

describe('isTransientDatabaseError', () => {
  it.each(['40001', '40P01', '53300', '55P03', '57P01', '57P03', '08006', '08001', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])(
    'recognizes code %s',
    (code) => expect(isTransientDatabaseError(withCode(code))).toBe(true),
  );

  it('recognizes connection failures without a code', () => {
    expect(isTransientDatabaseError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientDatabaseError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('looks through the cause chain', () => {
    expect(isTransientDatabaseError(new Error('wrapped', { cause: withCode('40P01') }))).toBe(true);
  });

  it.each(['23505', '23514', '22P02', '42P01', 'EACCES'])('does not treat %s as transient', (code) => {
    expect(isTransientDatabaseError(withCode(code))).toBe(false);
  });

  it('does not treat unknown or non-Error values as transient', () => {
    expect(isTransientDatabaseError(new Error('something else'))).toBe(false);
    expect(isTransientDatabaseError('40P01')).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isTransientDatabaseError(a)).toBe(false);
  });
});
