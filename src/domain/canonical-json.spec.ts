import { describe, expect, it } from 'bun:test';
import { canonicalJson } from './canonical-json';
import { DomainError } from './domain-error';

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: null } })).toBe('{"a":{"c":null,"d":true},"b":1}');
  });

  it('gives the same text regardless of key order', () => {
    expect(canonicalJson({ x: 1, y: [1, 2] })).toBe(canonicalJson({ y: [1, 2], x: 1 }));
  });

  it('keeps array order', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('omits undefined properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('escapes strings like JSON', () => {
    expect(canonicalJson({ 'a"b': 'x\ny' })).toBe('{"a\\"b":"x\\ny"}');
  });

  it('rejects values that have no stable text form', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(DomainError);
    expect(() => canonicalJson(Infinity)).toThrow(DomainError);
    expect(() => canonicalJson(() => 1)).toThrow(DomainError);
    expect(() => canonicalJson(undefined)).toThrow(DomainError);
  });
});
