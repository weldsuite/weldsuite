import { describe, expect, it } from 'vitest';
import { WELD_TAX_CODES } from '@/lib/weldbooks/tax-codes';
import {
  TAX_CODE_CUSTOM,
  TAX_CODE_DEFAULT,
  hasInvalidCustomCode,
  initialTaxState,
  isProviderTaxCode,
  normalizeProviderTaxCode,
  productTaxPayload,
  storedProductTax,
  taxClassOf,
  type ProductTaxState,
} from './product-tax';

const NEW_PRODUCT = storedProductTax(undefined);

function state(overrides: Partial<ProductTaxState> = {}): ProductTaxState {
  return { ...initialTaxState(NEW_PRODUCT), ...overrides };
}

describe('storedProductTax', () => {
  it('treats a new product and a null taxable as taxable with no code', () => {
    expect(storedProductTax(undefined)).toEqual({ taxable: true, taxClass: null });
    expect(storedProductTax({ taxable: null, taxClass: null })).toEqual({ taxable: true, taxClass: null });
  });

  it('keeps taxable = false and a trimmed code, and reads a blank code as none', () => {
    expect(storedProductTax({ taxable: false, taxClass: ' saas ' })).toEqual({ taxable: false, taxClass: 'saas' });
    expect(storedProductTax({ taxClass: '   ' })).toEqual({ taxable: true, taxClass: null });
  });
});

describe('initialTaxState', () => {
  it.each(WELD_TAX_CODES)('selects the WeldBooks code %s', (code) => {
    expect(initialTaxState({ taxable: true, taxClass: code })).toEqual({
      taxable: true,
      choice: code,
      custom: '',
      touched: false,
    });
  });

  it('shows a provider code as a custom code', () => {
    expect(initialTaxState({ taxable: true, taxClass: 'txcd_20030000' })).toMatchObject({
      choice: TAX_CODE_CUSTOM,
      custom: 'txcd_20030000',
    });
    expect(initialTaxState({ taxable: false, taxClass: 'SW054000' })).toMatchObject({
      taxable: false,
      choice: TAX_CODE_CUSTOM,
      custom: 'SW054000',
    });
  });

  it('shows no code and a legacy word as the default', () => {
    expect(initialTaxState({ taxable: true, taxClass: null }).choice).toBe(TAX_CODE_DEFAULT);
    expect(initialTaxState({ taxable: true, taxClass: 'standard' }).choice).toBe(TAX_CODE_DEFAULT);
  });
});

describe('provider codes', () => {
  it('normalises case: txcd_ lower, Avalara upper', () => {
    expect(normalizeProviderTaxCode('  TXCD_20030000 ')).toBe('txcd_20030000');
    expect(normalizeProviderTaxCode('sw054000')).toBe('SW054000');
  });

  it.each(['txcd_20030000', 'P0000000', 'SW054000', 'FR020100', 'S0000000'])('accepts %s', (code) => {
    expect(isProviderTaxCode(code)).toBe(true);
  });

  it.each(['', 'saas', 'txcd_123', 'txcd_2003000a', 'p0000000', 'ABC123456', 'P00000000', 'P12345'])(
    'rejects %j',
    (code) => {
      expect(isProviderTaxCode(code)).toBe(false);
    },
  );
});

describe('taxClassOf and hasInvalidCustomCode', () => {
  it('maps the choices to a stored value', () => {
    expect(taxClassOf(state())).toBeNull();
    expect(taxClassOf(state({ choice: 'clothing' }))).toBe('clothing');
    expect(taxClassOf(state({ choice: TAX_CODE_CUSTOM, custom: ' sw054000 ' }))).toBe('SW054000');
  });

  it('flags only a custom choice with a bad code', () => {
    expect(hasInvalidCustomCode(state({ choice: TAX_CODE_CUSTOM, custom: '' }))).toBe(true);
    expect(hasInvalidCustomCode(state({ choice: TAX_CODE_CUSTOM, custom: 'nonsense' }))).toBe(true);
    expect(hasInvalidCustomCode(state({ choice: TAX_CODE_CUSTOM, custom: 'txcd_20030000' }))).toBe(false);
    expect(hasInvalidCustomCode(state({ choice: 'saas', custom: 'nonsense' }))).toBe(false);
  });
});

describe('productTaxPayload', () => {
  it('sends nothing for a new product left at the defaults', () => {
    expect(productTaxPayload(NEW_PRODUCT, state())).toEqual({});
  });

  it('sends what a new product sets', () => {
    expect(productTaxPayload(NEW_PRODUCT, state({ taxable: false }))).toEqual({ taxable: false });
    expect(productTaxPayload(NEW_PRODUCT, state({ choice: 'saas', touched: true }))).toEqual({ taxClass: 'saas' });
    expect(
      productTaxPayload(NEW_PRODUCT, state({ choice: TAX_CODE_CUSTOM, custom: 'sw054000', touched: true })),
    ).toEqual({ taxClass: 'SW054000' });
  });

  it('sends nothing for an edit that changed neither field', () => {
    const stored = storedProductTax({ taxable: false, taxClass: 'clothing' });
    expect(productTaxPayload(stored, initialTaxState(stored))).toEqual({});
  });

  it('sends only the field that changed', () => {
    const stored = storedProductTax({ taxable: true, taxClass: 'clothing' });
    const initial = initialTaxState(stored);
    expect(productTaxPayload(stored, { ...initial, taxable: false })).toEqual({ taxable: false });
    expect(productTaxPayload(stored, { ...initial, choice: 'food_grocery', touched: true })).toEqual({
      taxClass: 'food_grocery',
    });
  });

  it('sends nothing when the code was touched and put back', () => {
    const stored = storedProductTax({ taxable: true, taxClass: 'clothing' });
    expect(productTaxPayload(stored, { ...initialTaxState(stored), choice: 'clothing', touched: true })).toEqual({});
  });

  it('clears the code with null when the default is chosen', () => {
    const stored = storedProductTax({ taxable: true, taxClass: 'saas' });
    expect(productTaxPayload(stored, { ...initialTaxState(stored), choice: TAX_CODE_DEFAULT, touched: true })).toEqual({
      taxClass: null,
    });
  });

  it('leaves an untouched legacy word in place, and clears it once the default is chosen on purpose', () => {
    const stored = storedProductTax({ taxable: true, taxClass: 'standard' });
    const initial = initialTaxState(stored);
    expect(productTaxPayload(stored, initial)).toEqual({});
    expect(productTaxPayload(stored, { ...initial, touched: true })).toEqual({ taxClass: null });
  });

  it('never sends an invalid custom code', () => {
    expect(
      productTaxPayload(NEW_PRODUCT, state({ taxable: false, choice: TAX_CODE_CUSTOM, custom: 'nonsense', touched: true })),
    ).toEqual({ taxable: false });
  });
});
