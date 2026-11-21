import { describe, expect, it } from 'vitest';
import { createProductSupplierSchema, updateProductSupplierSchema } from './product-suppliers';

describe('createProductSupplierSchema', () => {
  const base = { productId: 'prod_1', supplierId: 'sup_1' };

  it('accepts the two required ids alone', () => {
    expect(createProductSupplierSchema.parse(base)).toEqual(base);
  });

  it('accepts the full set of terms, with nullable ones null', () => {
    const input = {
      ...base,
      variantId: null,
      supplierSku: 'S-1',
      supplierProductName: null,
      unitCost: 4.25,
      currency: 'EUR',
      leadTimeDays: 10,
      minOrderQty: 6,
      orderMultiple: 6,
      isPreferred: true,
    };
    expect(createProductSupplierSchema.parse(input)).toEqual(input);
  });

  it.each([
    ['a missing product', { supplierId: 'sup_1' }],
    ['an empty supplier id', { ...base, supplierId: '' }],
    ['a negative unit cost', { ...base, unitCost: -1 }],
    ['a currency that is not 3 letters', { ...base, currency: 'EU' }],
    ['a lead time over 365 days', { ...base, leadTimeDays: 366 }],
    ['a negative lead time', { ...base, leadTimeDays: -1 }],
    ['a minimum order quantity of 0', { ...base, minOrderQty: 0 }],
    ['an order multiple of 0', { ...base, orderMultiple: 0 }],
    ['a fractional order multiple', { ...base, orderMultiple: 1.5 }],
    ['a supplier SKU over 100 characters', { ...base, supplierSku: 'x'.repeat(101) }],
  ])('rejects %s', (_name, input) => {
    expect(createProductSupplierSchema.safeParse(input).success).toBe(false);
  });
});

describe('updateProductSupplierSchema', () => {
  it('accepts a partial update and an empty one', () => {
    expect(updateProductSupplierSchema.parse({ leadTimeDays: 7 })).toEqual({ leadTimeDays: 7 });
    expect(updateProductSupplierSchema.parse({})).toEqual({});
  });

  it('keeps the term limits', () => {
    expect(updateProductSupplierSchema.safeParse({ leadTimeDays: 400 }).success).toBe(false);
    expect(updateProductSupplierSchema.safeParse({ orderMultiple: 0 }).success).toBe(false);
  });

  it('drops the product, variant and supplier, which never change', () => {
    expect(updateProductSupplierSchema.parse({ productId: 'p', supplierId: 's', isPreferred: false })).toEqual({ isPreferred: false });
  });
});
