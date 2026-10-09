import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DEAL_CURRENCY,
  dealCurrencySymbol,
  formatDealDate,
  formatDealMoney,
  getCurrencyOptions,
  resolveDealCurrency,
} from './deal-format';

describe('deal-format', () => {
  it('falls back to the default currency for a missing or malformed code', () => {
    expect(resolveDealCurrency(undefined)).toBe(DEFAULT_DEAL_CURRENCY);
    expect(resolveDealCurrency('')).toBe(DEFAULT_DEAL_CURRENCY);
    expect(resolveDealCurrency('eu')).toBe(DEFAULT_DEAL_CURRENCY);
    expect(resolveDealCurrency('usd')).toBe('USD');
  });

  it("formats money in the deal's own currency, not a hardcoded dollar", () => {
    expect(formatDealMoney(1500, 'EUR')).toContain('€');
    expect(formatDealMoney(1500, 'EUR')).not.toContain('$');
    expect(formatDealMoney(1500, 'USD')).toContain('$');
    expect(formatDealMoney(1500, undefined)).toContain('€');
  });

  it('does not throw for an unknown currency code', () => {
    expect(() => formatDealMoney(10, 'ZZZ')).not.toThrow();
  });

  it('exposes the currency symbol for input adornments', () => {
    expect(dealCurrencySymbol('EUR')).toBe('€');
    expect(dealCurrencySymbol(null)).toBe('€');
  });

  it('formats close dates one way and tolerates bad input', () => {
    expect(formatDealDate('2026-10-20T12:00:00Z')).toBe('Oct 20, 2026');
    expect(formatDealDate(undefined)).toBeNull();
  });

  it('offers ISO 4217 options labelled with the code', () => {
    const options = getCurrencyOptions();
    expect(options.find((o) => o.value === 'EUR')?.label).toMatch(/^EUR/);
    expect(options.some((o) => o.value === 'XYZ')).toBe(false);
  });
});
