import { describe, expect, it } from 'vitest';
import { customerPriceMajor, parsePriceMajor, parseTldInput } from './domain-pricing-markup';

describe('parsePriceMajor', () => {
  it('normalizes a valid amount to two decimals', () => {
    expect(parsePriceMajor('15.5')).toEqual({ ok: true, value: '15.50' });
  });

  it('accepts comma decimals', () => {
    expect(parsePriceMajor('11,00')).toEqual({ ok: true, value: '11.00' });
  });

  it('rejects empty and negative values', () => {
    expect(parsePriceMajor('')).toEqual({ ok: false, code: 'invalid' });
    expect(parsePriceMajor('-1')).toEqual({ ok: false, code: 'invalid' });
  });

  it('rejects values above numeric(10, 2)', () => {
    expect(parsePriceMajor('100000000')).toEqual({ ok: false, code: 'out_of_range' });
  });
});

describe('parseTldInput', () => {
  it('strips a leading dot and lowercases', () => {
    expect(parseTldInput('.COM')).toEqual({ ok: true, tld: 'com' });
  });

  it('accepts multi-label TLDs', () => {
    expect(parseTldInput('co.uk')).toEqual({ ok: true, tld: 'co.uk' });
  });

  it('rejects empty and invalid labels', () => {
    expect(parseTldInput('')).toEqual({ ok: false, code: 'invalid' });
    expect(parseTldInput('com.')).toEqual({ ok: false, code: 'invalid' });
  });
});

describe('customerPriceMajor', () => {
  it('adds percent markup onto an authored renewal', () => {
    expect(customerPriceMajor('11.00', { markupAmount: null, markupPercent: '20' })).toBe('13.20');
  });
});
