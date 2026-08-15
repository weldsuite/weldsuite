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

  it('falls back to EUR when currency is missing', () => {
    const formatted = formatWeldbooksMoney(10, null, 'nl-NL');
    expect(formatted).toMatch(/€/);
  });

  it('ignores invalid currency codes instead of throwing', () => {
    expect(() => formatWeldbooksMoney(10, 'NOPE', 'nl-NL')).not.toThrow();
    expect(formatWeldbooksMoney(10, 'NOPE', 'nl-NL')).toMatch(/€/);
  });

  it('treats null/undefined amounts as zero', () => {
    const formatted = formatWeldbooksMoney(null, 'INR', 'en-IN');
    expect(formatted).toMatch(/₹|INR/);
  });
});
