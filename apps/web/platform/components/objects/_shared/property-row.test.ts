import { describe, expect, it } from 'vitest';
import { isPhoneNumber } from './property-row';

describe('isPhoneNumber', () => {
  it('accepts digits with the usual separators', () => {
    expect(isPhoneNumber('+31 20 123 4567')).toBe(true);
    expect(isPhoneNumber('(020) 123-45.67')).toBe(true);
    expect(isPhoneNumber('020/1234567')).toBe(true);
    expect(isPhoneNumber('  112  ')).toBe(true);
  });

  it('accepts an extension, with or without spaces around it', () => {
    expect(isPhoneNumber('+31 20 123 4567 x 12')).toBe(true);
    expect(isPhoneNumber('+31 20 123 4567x12')).toBe(true);
    expect(isPhoneNumber('020 1234567 ext. 123456')).toBe(true);
    expect(isPhoneNumber('020 1234567 EXT 9')).toBe(true);
  });

  it('rejects text, too few digits and malformed extensions', () => {
    expect(isPhoneNumber('abc-not-phone')).toBe(false);
    expect(isPhoneNumber('12')).toBe(false);
    expect(isPhoneNumber('020 1234567 ext')).toBe(false);
    expect(isPhoneNumber('020 1234567 x 1234567')).toBe(false);
    expect(isPhoneNumber('x 123')).toBe(false);
  });

  it('stays fast on a long run of separators that does not match', () => {
    const started = performance.now();
    expect(isPhoneNumber(`1${' '.repeat(50_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
