import { describe, it, expect } from 'vitest';
import { coerceScalar } from './import-value';

describe('coerceScalar', () => {
  it('returns the string unchanged for string / default type', () => {
    expect(coerceScalar('hello')).toBe('hello');
    expect(coerceScalar('hello', 'string')).toBe('hello');
    expect(coerceScalar('https://x.example', 'string')).toBe('https://x.example');
  });

  describe('number', () => {
    it('parses plain and thousands-separated numbers', () => {
      expect(coerceScalar('42', 'number')).toBe(42);
      expect(coerceScalar('3.14', 'number')).toBe(3.14);
      expect(coerceScalar('1,234', 'number')).toBe(1234);
    });

    it('returns undefined for unparseable numbers (so the caller skips it)', () => {
      expect(coerceScalar('not-a-number', 'number')).toBeUndefined();
      expect(coerceScalar('12abc', 'number')).toBeUndefined();
    });
  });

  describe('boolean', () => {
    it.each(['true', 'TRUE', 'yes', 'Y', '1', 'x', 'X', '✓'])(
      'parses %s as true',
      (v) => {
        expect(coerceScalar(v, 'boolean')).toBe(true);
      },
    );

    it.each(['false', 'no', 'n', '0', 'maybe', 'off'])(
      'parses %s as false',
      (v) => {
        expect(coerceScalar(v, 'boolean')).toBe(false);
      },
    );

    it('tolerates surrounding whitespace', () => {
      expect(coerceScalar('  yes  ', 'boolean')).toBe(true);
    });
  });
});
