import { describe, expect, it } from 'bun:test';
import { errorFields, LOGGABLE_FIELDS, loggable } from './log-fields';

describe('loggable', () => {
  it('keeps identifiers, kind, status and failure code', () => {
    const fields = { walletId: 'w', transactionId: 't', kind: 'BET', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' };
    expect(loggable(fields)).toEqual(fields);
  });

  it('drops money, player data and anything not listed', () => {
    const fields = { walletId: 'w', amount: '25.00', balance: '10.00', difference: '5.00', playerId: 'p', body: '{}', errorMessage: 'row (25.00)' };
    expect(loggable(fields)).toEqual({ walletId: 'w' });
  });

  it('lists no money or player field', () => {
    for (const forbidden of ['amount', 'balance', 'money', 'difference', 'playerId', 'body', 'errorMessage']) {
      expect(LOGGABLE_FIELDS.has(forbidden)).toBe(false);
    }
  });
});

describe('errorFields', () => {
  it('keeps the stack frames and leaves the message line out of the stack', () => {
    const error = new Error('Failing row contains (25.00)');
    const fields = errorFields(error);
    expect(fields.errorName).toBe('Error');
    expect(fields.errorMessage).toBe('Failing row contains (25.00)');
    expect(fields.errorStack).toContain('at ');
    expect(fields.errorStack).not.toContain('25.00');
  });

  it('describes a thrown value that is not an Error', () => {
    expect(errorFields('boom')).toEqual({ errorName: 'string', errorMessage: 'boom' });
  });
});
