import { currencySymbol, formatMoney, resolveCurrency, sumInCurrency, toNumber, usableCurrency } from '@/lib/money';

describe('toNumber', () => {
  it('parses decimal strings and ignores junk', () => {
    expect(toNumber('1234.50')).toBe(1234.5);
    expect(toNumber(7)).toBe(7);
    expect(toNumber('')).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('abc')).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
  });
});

describe('currency codes', () => {
  it('accepts three letters and upper-cases them', () => {
    expect(usableCurrency('usd')).toBe('USD');
    expect(usableCurrency('US')).toBeNull();
    expect(usableCurrency(null)).toBeNull();
  });

  it('defaults to EUR like the server does', () => {
    expect(resolveCurrency(undefined)).toBe('EUR');
    expect(resolveCurrency('gbp')).toBe('GBP');
  });
});

describe('formatMoney', () => {
  it('uses the given currency instead of a hard-coded dollar', () => {
    expect(formatMoney(1250, 'EUR', 'en-GB')).toContain('€');
    expect(formatMoney(1250, 'EUR', 'en-GB')).not.toContain('$');
    expect(formatMoney(1250, 'USD', 'en-US')).toContain('$');
    expect(formatMoney(1250, 'GBP', 'en-GB')).toContain('£');
  });

  it('follows the locale for separators', () => {
    expect(formatMoney(1234.5, 'EUR', 'nl-NL')).toMatch(/1\.234,5/);
    expect(formatMoney(1234.5, 'EUR', 'en-GB')).toMatch(/1,234\.5/);
  });

  it('abbreviates large amounts only when asked and keeps small ones exact', () => {
    expect(formatMoney(1_500_000, 'USD', 'en-US', { compact: true })).toMatch(/1\.5M/);
    expect(formatMoney(950, 'USD', 'en-US', { compact: true })).toBe('$950');
    expect(formatMoney(1_500_000, 'USD', 'en-US')).toContain('1,500,000');
  });

  it('never throws on a bad currency', () => {
    expect(() => formatMoney('12.5', 'not-a-code', 'en-GB')).not.toThrow();
    expect(formatMoney('12.5', undefined, 'en-GB')).toBe('12.5');
  });
});

describe('currencySymbol', () => {
  it('returns the symbol, or the code when there is none', () => {
    expect(currencySymbol('EUR', 'en-GB')).toBe('€');
    expect(currencySymbol('USD', 'en-US')).toBe('$');
    expect(currencySymbol(undefined, 'en-GB')).toBe('€');
  });
});

describe('sumInCurrency', () => {
  it('adds only the rows in the workspace currency and counts the rest', () => {
    const result = sumInCurrency(
      [
        { amount: '1000.00', currency: 'EUR' },
        { amount: '250.50', currency: 'EUR' },
        { amount: '999', currency: 'USD' },
        { amount: '5', currency: 'GBP' },
      ],
      'EUR',
    );
    expect(result).toEqual({ total: 1250.5, included: 2, excluded: 2 });
  });

  it('treats a row without a currency as the workspace currency', () => {
    expect(sumInCurrency([{ amount: '10', currency: null }, { amount: 5 }], 'USD')).toEqual({
      total: 15,
      included: 2,
      excluded: 0,
    });
  });

  it('is zero for no rows', () => {
    expect(sumInCurrency([], 'EUR')).toEqual({ total: 0, included: 0, excluded: 0 });
  });
});
