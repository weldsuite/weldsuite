import { describe, expect, it } from 'vitest';
import { asText, logSafe, stripTags, tagsToSpaces } from './index';

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

describe('stripTags', () => {
  it('removes from a `<` to the next `>`, as the /<[^>]*>/g regex it replaced did', () => {
    const cases: Array<[string, string]> = [
      ['<p>Hello <b>world</b></p>', 'Hello world'],
      ['a<b<c>d', 'ad'],
      ['<<b>img src=x>', 'img src=x>'],
      ['x > y', 'x > y'],
      ['a<>b', 'ab'],
      ['<a>b<c', 'b<c'],
      ['plain', 'plain'],
      ['', ''],
      ['<', '<'],
    ];
    for (const [input, expected] of cases) {
      expect(stripTags(input)).toBe(expected);
    }
  });

  it('leaves an unclosed `<` and everything after it alone, in linear time', () => {
    const input = `ok ${'<'.repeat(50_000)}`;
    expect(stripTags(input)).toBe(input);
  });
});

describe('tagsToSpaces', () => {
  it('replaces the spans the /<[^>]+>/g regex it replaced did, leaving a bare `<>` alone', () => {
    const cases: Array<[string, string]> = [
      ['<p>Hi <b>there</b></p>', ' Hi  there  '],
      ['a<>b', 'a<>b'],
      ['a<<>b', 'a b'],
      ['<><b>', '<> '],
      ['a<b<c>d', 'a d'],
      ['<a>b<c', ' b<c'],
      ['x > y', 'x > y'],
      ['', ''],
    ];
    for (const [input, expected] of cases) {
      expect(tagsToSpaces(input)).toBe(expected);
    }
  });

  it('keeps an unclosed `<` and the rest of the text', () => {
    const input = `hi ${'<'.repeat(50_000)}`;
    expect(tagsToSpaces(input)).toBe(input);
  });
});
