import { describe, expect, it } from 'vitest';
import { ALPHANUMERIC, BASE36_LOWER, BASE36_UPPER, randomString } from './random';

describe('randomString', () => {
  it('returns a string of the requested length drawn from the alphabet', () => {
    for (const alphabet of [BASE36_LOWER, BASE36_UPPER, ALPHANUMERIC]) {
      const value = randomString(200, alphabet);
      expect(value).toHaveLength(200);
      for (const ch of value) expect(alphabet).toContain(ch);
    }
  });

  it('returns an empty string for length 0', () => {
    expect(randomString(0)).toBe('');
  });

  it('produces different values across calls', () => {
    expect(randomString(32, ALPHANUMERIC)).not.toBe(randomString(32, ALPHANUMERIC));
  });

  it('rejects unusable alphabets', () => {
    expect(() => randomString(4, 'a')).toThrow(RangeError);
    expect(() => randomString(4, 'a'.repeat(257))).toThrow(RangeError);
  });
});
