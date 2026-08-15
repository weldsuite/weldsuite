import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { customerPriceMajor, parsePriceMajor, parseTldInput } from './domain-pricing-markup';

describe('parsePriceMajor', () => {
  it('normalizes a valid amount to two decimals', () => {
    assert.deepEqual(parsePriceMajor('15.5'), { ok: true, value: '15.50' });
  });

  it('accepts comma decimals', () => {
    assert.deepEqual(parsePriceMajor('11,00'), { ok: true, value: '11.00' });
  });

  it('rejects empty and negative values', () => {
    assert.deepEqual(parsePriceMajor(''), { ok: false, code: 'invalid' });
    assert.deepEqual(parsePriceMajor('-1'), { ok: false, code: 'invalid' });
  });

  it('rejects values above numeric(10, 2)', () => {
    assert.deepEqual(parsePriceMajor('100000000'), { ok: false, code: 'out_of_range' });
  });
});

describe('parseTldInput', () => {
  it('strips a leading dot and lowercases', () => {
    assert.deepEqual(parseTldInput('.COM'), { ok: true, tld: 'com' });
  });

  it('accepts multi-label TLDs', () => {
    assert.deepEqual(parseTldInput('co.uk'), { ok: true, tld: 'co.uk' });
  });

  it('rejects empty and invalid labels', () => {
    assert.deepEqual(parseTldInput(''), { ok: false, code: 'invalid' });
    assert.deepEqual(parseTldInput('com.'), { ok: false, code: 'invalid' });
  });
});

describe('customerPriceMajor', () => {
  it('adds percent markup onto an authored renewal', () => {
    assert.equal(
      customerPriceMajor('11.00', { markupAmount: null, markupPercent: '20' }),
      '13.20',
    );
  });
});
