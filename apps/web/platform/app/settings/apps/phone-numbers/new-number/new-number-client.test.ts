import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n')>()),
  getLocale: () => 'en',
}));

import { defaultSearchCountry, formatMoney } from './new-number-client';

describe('defaultSearchCountry', () => {
  it("uses the workspace's country when numbers can be bought there", () => {
    expect(defaultSearchCountry('NL')).toBe('NL');
    expect(defaultSearchCountry(' be ')).toBe('BE');
  });

  it('falls back to the United States otherwise', () => {
    expect(defaultSearchCountry(undefined)).toBe('US');
    expect(defaultSearchCountry(null)).toBe('US');
    expect(defaultSearchCountry('IN')).toBe('US');
  });
});

describe('formatMoney', () => {
  it('formats a currency amount instead of prefixing the code', () => {
    expect(formatMoney('USD', 1.2)).toBe('$1.20');
    expect(formatMoney('EUR', 3)).toBe('€3.00');
  });

  it('keeps the code for something that is not an ISO currency', () => {
    expect(formatMoney('XXXX', 1.2)).toBe('XXXX 1.20');
  });
});
