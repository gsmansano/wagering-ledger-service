import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { decodeLedgerCursor, encodeLedgerCursor, parseLedgerLimit } from './ledger-cursor';

describe('ledger cursor', () => {
  it('round-trips a sequence and is URL-safe', () => {
    const cursor = encodeLedgerCursor(12345);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLedgerCursor(cursor)).toBe(12345);
  });

  it.each([
    ['not base64 json', 'garbage!!'],
    ['json without a sequence', Buffer.from('{"a":1}').toString('base64url')],
    ['json null', Buffer.from('null').toString('base64url')],
    ['a negative sequence', Buffer.from('{"sequence":-1}').toString('base64url')],
    ['zero', Buffer.from('{"sequence":0}').toString('base64url')],
    ['a fractional sequence', Buffer.from('{"sequence":1.5}').toString('base64url')],
    ['a string sequence', Buffer.from('{"sequence":"3"}').toString('base64url')],
    ['empty', ''],
  ])('rejects %s', (_name, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(BadRequestException);
  });
});

describe('parseLedgerLimit', () => {
  it('defaults to 50', () => expect(parseLedgerLimit(undefined)).toBe(50));
  it.each([['1', 1], ['50', 50], ['200', 200]])('accepts %s', (raw, expected) =>
    expect(parseLedgerLimit(raw)).toBe(expected),
  );
  it.each(['0', '201', '-1', '1.5', 'abc', '', '1e2', '999999999999'])('rejects %p', (raw) =>
    expect(() => parseLedgerLimit(raw)).toThrow(BadRequestException),
  );
});
