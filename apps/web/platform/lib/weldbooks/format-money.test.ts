import { describe, expect, it } from 'vitest';
import { formatWeldbooksMoney } from './format-money';

describe('formatWeldbooksMoney', () => {
  it('formats INR with the Indian rupee symbol', () => {
    const formatted = formatWeldbooksMoney(1234.5, 'INR', 'en-IN');
    expect(formatted).toMatch(/₹|INR/);
    expect(formatted).not.toMatch(/€/);
  });

  it('formats EUR with a euro sign', () => {
    const formatted = formatWeldbooksMoney(10, 'EUR', 'nl-NL');
    expect(formatted).toMatch(/€/);
  });

  it('formats USD in en-US', () => {
    expect(formatWeldbooksMoney(1234.5, 'USD', 'en-US')).toBe('$1,234.50');
  });

  it('shows a plain amount instead of assuming EUR when the currency is missing', () => {
    const formatted = formatWeldbooksMoney(10, null, 'en-US');
    expect(formatted).not.toMatch(/€|\$/);
    expect(formatted).toBe('10.00');
  });

  it('ignores invalid currency codes instead of throwing', () => {
    expect(() => formatWeldbooksMoney(10, 'NOPE', 'nl-NL')).not.toThrow();
    expect(formatWeldbooksMoney(10, 'NOPE', 'nl-NL')).not.toMatch(/€/);
    expect(formatWeldbooksMoney(10, 'FOO', 'nl-NL')).toBe('10,00');
  });

  it('falls back to the browser locale when the persisted locale is malformed', () => {
    expect(() => formatWeldbooksMoney(10, 'EUR', 'en_US')).not.toThrow();
    expect(formatWeldbooksMoney(10, 'EUR', 'en_US')).toMatch(/€/);
  });

  it('treats null/undefined amounts as zero', () => {
    const formatted = formatWeldbooksMoney(null, 'INR', 'en-IN');
    expect(formatted).toMatch(/₹|INR/);
  });
});
