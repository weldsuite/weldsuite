import { describe, expect, it } from 'vitest';
import { defaultTaxRateId, taxRateLabel, taxRatesFor } from './tax-rate-options';

const rate = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  rate: '21',
  taxCategoryCode: 'standard',
  isDefault: false,
  isActive: true,
  ...extra,
});

describe('taxRatesFor', () => {
  it('gives a sale the sales and both rates', () => {
    const rates = [rate('s', 'sales'), rate('p', 'purchase'), rate('b', 'both', { taxCategoryCode: 'reduced' })];
    expect(taxRatesFor(rates, 'sales').map((r) => r.id)).toEqual(['s', 'b']);
  });

  it('gives a purchase the purchase and both rates', () => {
    const rates = [rate('s', 'sales'), rate('p', 'purchase'), rate('b', 'both', { taxCategoryCode: 'reduced' })];
    expect(taxRatesFor(rates, 'purchase').map((r) => r.id)).toEqual(['p', 'b']);
  });

  it('hides a both rate for a purchase when a purchase rate of the same category and percentage exists', () => {
    const rates = [rate('both21', 'both'), rate('buy21', 'purchase'), rate('both9', 'both', { rate: '9' })];
    expect(taxRatesFor(rates, 'purchase').map((r) => r.id)).toEqual(['buy21', 'both9']);
    // A sale still sees the both rate.
    expect(taxRatesFor(rates, 'sales').map((r) => r.id)).toEqual(['both21', 'both9']);
  });

  it('keeps a both rate whose category differs from the purchase rate', () => {
    const rates = [rate('both21', 'both', { taxCategoryCode: 'reverse_charge' }), rate('buy21', 'purchase')];
    expect(taxRatesFor(rates, 'purchase').map((r) => r.id)).toEqual(['both21', 'buy21']);
  });
});

describe('defaultTaxRateId', () => {
  it('is the active default for a sale when it is a sales or both rate', () => {
    expect(defaultTaxRateId([rate('s', 'sales', { isDefault: true }), rate('p', 'purchase')], 'sales')).toBe('s');
    expect(defaultTaxRateId([rate('b', 'both', { isDefault: true })], 'sales')).toBe('b');
  });

  it('is none for a sale when the default is a purchase rate, or there is no default', () => {
    expect(defaultTaxRateId([rate('p', 'purchase', { isDefault: true })], 'sales')).toBeNull();
    expect(defaultTaxRateId([rate('s', 'sales')], 'sales')).toBeNull();
    expect(defaultTaxRateId(undefined, 'sales')).toBeNull();
  });

  it('ignores an inactive default', () => {
    expect(defaultTaxRateId([rate('s', 'sales', { isDefault: true, isActive: false })], 'sales')).toBeNull();
  });

  it('is the purchase twin of the default for a purchase', () => {
    const rates = [rate('sales21', 'sales', { isDefault: true }), rate('buy21', 'purchase'), rate('buy9', 'purchase', { rate: '9' })];
    expect(defaultTaxRateId(rates, 'purchase')).toBe('buy21');
  });

  it('is the default itself for a purchase when it has no twin and a bill may use it', () => {
    expect(defaultTaxRateId([rate('b', 'both', { isDefault: true })], 'purchase')).toBe('b');
  });

  it('is none for a purchase when the default is a sales rate without a purchase twin', () => {
    expect(defaultTaxRateId([rate('s', 'sales', { isDefault: true }), rate('buy9', 'purchase', { rate: '9' })], 'purchase')).toBeNull();
  });
});

describe('taxRateLabel', () => {
  it('adds the percentage to a name without one', () => {
    expect(taxRateLabel({ name: 'Standard', rate: '21.0000' })).toBe('Standard (21%)');
  });

  it('keeps a name that already has the percentage', () => {
    expect(taxRateLabel({ name: 'BTW Hoog 21%', rate: '21' })).toBe('BTW Hoog 21%');
  });

  it('falls back to the percentage for a rate without a name', () => {
    expect(taxRateLabel({ name: null, rate: '9' })).toBe('9%');
  });
});
