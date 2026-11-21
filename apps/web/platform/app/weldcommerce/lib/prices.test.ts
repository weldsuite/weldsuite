import { describe, expect, it } from 'vitest';
import { entriesFromPrices, newPriceEntry, sameEntries, toPriceInputs, validateEntries, type PriceEntry } from './prices';

const entry = (over: Partial<PriceEntry> = {}): PriceEntry => ({
  key: 'k1',
  variantId: null,
  currency: 'USD',
  price: '12.5',
  compareAtPrice: '',
  ...over,
});

describe('price entries', () => {
  it('reads the stored prices into rows', () => {
    const rows = entriesFromPrices([
      { id: 'p1', productId: 'prod', variantId: 'v1', currency: 'USD', price: '12.00', compareAtPrice: null },
    ]);
    expect(rows).toEqual([{ key: 'p1', variantId: 'v1', currency: 'USD', price: '12.00', compareAtPrice: '' }]);
    expect(newPriceEntry('new-1', 'v1')).toMatchObject({ key: 'new-1', variantId: 'v1', currency: '', price: '' });
  });

  it('accepts a valid set', () => {
    expect(validateEntries([entry(), entry({ key: 'k2', variantId: 'v1', currency: 'EUR' })], 'EUR')).toEqual({});
  });

  it('flags a bad currency, a missing or bad price and a bad compare-at price', () => {
    const errors = validateEntries([entry({ currency: 'US', price: '', compareAtPrice: 'x' })], 'EUR');
    expect(Object.keys(errors.k1)).toEqual(['currency', 'price', 'compareAtPrice']);
  });

  it('refuses the same currency twice for one subject, but not for different ones', () => {
    const errors = validateEntries([entry(), entry({ key: 'k2' }), entry({ key: 'k3', variantId: 'v1' })], 'EUR');
    expect(errors.k2?.currency).toBeTruthy();
    expect(errors.k1).toBeUndefined();
    expect(errors.k3).toBeUndefined();
  });

  it('refuses the base currency on the product, but allows it as a variant override', () => {
    expect(validateEntries([entry({ currency: 'EUR' })], 'EUR').k1?.currency).toBeTruthy();
    expect(validateEntries([entry({ currency: 'EUR', variantId: 'v1' })], 'EUR')).toEqual({});
  });

  it('builds the whole-set body with two decimals and null for no compare-at price', () => {
    expect(toPriceInputs([entry({ currency: 'usd', price: '12,5', compareAtPrice: '15' })])).toEqual([
      { variantId: null, currency: 'USD', price: '12.50', compareAtPrice: '15.00' },
    ]);
    expect(toPriceInputs([entry()])[0].compareAtPrice).toBeNull();
  });

  it('tells equal sets apart from changed ones, whatever the keys', () => {
    expect(sameEntries([entry()], [entry({ key: 'other' })])).toBe(true);
    expect(sameEntries([entry()], [entry({ price: '13' })])).toBe(false);
    expect(sameEntries([entry()], [])).toBe(false);
  });
});
