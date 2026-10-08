import { describe, it, expect } from 'vitest';
import { WELD_TAX_CODES } from '@weldsuite/books-domain/jurisdictions/us/tax-codes';
import {
  createProductBodySchema,
  isAcceptedProductTaxClass,
  productTaxClassSchema,
  updateProductBodySchema,
} from './tax-schemas';

describe('isAcceptedProductTaxClass', () => {
  it.each(WELD_TAX_CODES)('accepts the WeldBooks code %s', (code) => {
    expect(isAcceptedProductTaxClass(code)).toBe(true);
  });

  it.each(['txcd_20030000', 'txcd_10103001', 'P0000000', 'SW054000', 'FR020100', 'PC040100', 'S0000000'])(
    'accepts the provider code %s',
    (code) => {
      expect(isAcceptedProductTaxClass(code)).toBe(true);
    },
  );

  it.each([
    'taxable',
    'standard',
    'reduced',
    'GENERAL',
    'txcd_123',
    'txcd_2003000a',
    'p0000000',
    'P000',
    'ABC123456',
    'P00000000',
    'SW05400X',
    'general ',
  ])('rejects %s', (code) => {
    expect(isAcceptedProductTaxClass(code)).toBe(false);
  });
});

describe('productTaxClassSchema', () => {
  it('keeps a missing value missing', () => {
    expect(productTaxClassSchema.parse(undefined)).toBeUndefined();
  });

  it('turns null and blank into null', () => {
    expect(productTaxClassSchema.parse(null)).toBeNull();
    expect(productTaxClassSchema.parse('')).toBeNull();
    expect(productTaxClassSchema.parse('   ')).toBeNull();
  });

  it('trims a code', () => {
    expect(productTaxClassSchema.parse('  saas ')).toBe('saas');
  });

  it('refuses an unknown code and an over-long one', () => {
    expect(productTaxClassSchema.safeParse('nonsense').success).toBe(false);
    expect(productTaxClassSchema.safeParse('x'.repeat(51)).success).toBe(false);
  });
});

describe('product body schemas', () => {
  it('create carries taxable and taxClass through and keeps the passthrough fields', () => {
    const parsed = createProductBodySchema.parse({
      name: 'Hosted app',
      taxable: false,
      taxClass: 'saas',
      slug: 'hosted-app',
      barcode: '123',
    });
    expect(parsed).toMatchObject({ taxable: false, taxClass: 'saas', barcode: '123' });
  });

  it('create omits the tax fields when the body has none', () => {
    const parsed = createProductBodySchema.parse({ name: 'Plain' });
    expect('taxClass' in parsed).toBe(false);
    expect('taxable' in parsed).toBe(false);
  });

  it('create rejects a non-boolean taxable', () => {
    expect(createProductBodySchema.safeParse({ name: 'x', taxable: 'yes' }).success).toBe(false);
    expect(createProductBodySchema.safeParse({ name: 'x', taxable: null }).success).toBe(false);
  });

  it('update accepts each tax field alone and rejects a bad code', () => {
    expect(updateProductBodySchema.parse({ taxClass: 'clothing' })).toEqual({ taxClass: 'clothing' });
    expect(updateProductBodySchema.parse({ taxable: true })).toEqual({ taxable: true });
    expect(updateProductBodySchema.parse({ taxClass: null })).toEqual({ taxClass: null });
    expect(updateProductBodySchema.safeParse({ taxClass: 'nope' }).success).toBe(false);
  });
});
