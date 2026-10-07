import { describe, expect, it } from 'vitest';
import { asText, logSafe } from './index';

describe('asText', () => {
  it('matches String() for primitives, dates and nullish values', () => {
    const date = new Date(0);
    for (const value of ['a', 1, 0, true, false, 10n, null, undefined, date]) {
      expect(asText(value)).toBe(String(value));
    }
  });

  it('matches String() for flat and nested arrays', () => {
    expect(asText([1, 'b', null, undefined, [2, 3]])).toBe(String([1, 'b', null, undefined, [2, 3]]));
  });

  it('serialises plain objects as JSON instead of "[object Object]"', () => {
    expect(asText({ a: 1, b: ['x'] })).toBe('{"a":1,"b":["x"]}');
    expect(asText([{ a: 1 }])).toBe('{"a":1}');
  });

  it('serialises nested bigints as text instead of throwing', () => {
    expect(asText({ id: 10n, list: [1n] })).toBe('{"id":"10","list":["1"]}');
  });

  it('falls back to String() for circular objects', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(asText(circular)).toBe('[object Object]');
  });

  it('stringifies symbols and functions without throwing', () => {
    expect(asText(Symbol('s'))).toBe('Symbol(s)');
    expect(asText(function named() {})).toContain('named');
  });
});

describe('logSafe', () => {
  it('replaces line breaks and Unicode line separators with a space', () => {
    expect(logSafe('a\r\nb\nc\u2028d\u2029e')).toBe('a b c d e');
  });

  it('stringifies non-string values first', () => {
    expect(logSafe({ id: 'x\ny' })).toBe('{"id":"x\\ny"}');
    expect(logSafe(42)).toBe('42');
  });
});
