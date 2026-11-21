import { describe, expect, it } from 'vitest';
import {
  PURCHASE_ORDER_STATUSES,
  createPurchaseOrderLineSchema,
  createPurchaseOrderSchema,
  markPurchaseOrderOrderedSchema,
  receivePurchaseOrderLineSchema,
  receivePurchaseOrderSchema,
  updatePurchaseOrderLineSchema,
  updatePurchaseOrderSchema,
} from './purchase-orders';

describe('PURCHASE_ORDER_STATUSES', () => {
  it('lists the lifecycle from draft to closed', () => {
    expect(PURCHASE_ORDER_STATUSES).toEqual(['draft', 'pending', 'approved', 'ordered', 'partial', 'received', 'cancelled', 'closed']);
  });
});

describe('createPurchaseOrderSchema', () => {
  it('accepts an empty header, every field being optional', () => {
    expect(createPurchaseOrderSchema.parse({})).toEqual({});
  });

  it('accepts a full header with nullable references', () => {
    const input = {
      poNumber: 'PO-1',
      supplierId: 'sup_1',
      supplierName: null,
      warehouseId: null,
      orderDate: '2026-11-01',
      expectedDate: null,
      currency: 'EUR',
      shippingTotal: 5,
      discountTotal: 0,
      paymentTerms: 'Net 30',
    };
    expect(createPurchaseOrderSchema.parse(input)).toEqual(input);
  });

  it.each([
    ['an empty PO number', { poNumber: '' }],
    ['a PO number over 50 characters', { poNumber: 'x'.repeat(51) }],
    ['a currency that is not 3 letters', { currency: 'EURO' }],
    ['negative shipping', { shippingTotal: -1 }],
    ['negative discount', { discountTotal: -0.01 }],
    ['a supplier name over 255 characters', { supplierName: 'x'.repeat(256) }],
    ['payment terms over 100 characters', { paymentTerms: 'x'.repeat(101) }],
  ])('rejects %s', (_name, input) => {
    expect(createPurchaseOrderSchema.safeParse(input).success).toBe(false);
  });
});

describe('updatePurchaseOrderSchema', () => {
  it('accepts a status on top of the partial header', () => {
    expect(updatePurchaseOrderSchema.parse({ status: 'ordered', internalNotes: 'x' })).toEqual({
      status: 'ordered',
      internalNotes: 'x',
    });
  });

  it('still applies the header limits and caps the status at 30 characters', () => {
    expect(updatePurchaseOrderSchema.safeParse({ currency: 'EU' }).success).toBe(false);
    expect(updatePurchaseOrderSchema.safeParse({ status: 'x'.repeat(31) }).success).toBe(false);
  });
});

describe('createPurchaseOrderLineSchema', () => {
  const line = { name: 'Widget', unitPrice: 2.5 };

  it('accepts a minimal line and a full line', () => {
    expect(createPurchaseOrderLineSchema.parse(line)).toEqual(line);
    const full = { ...line, productId: 'prod_1', variantId: null, sku: 'W-1', quantityOrdered: 10, discountPercent: 5, taxPercent: 21, notes: 'n' };
    expect(createPurchaseOrderLineSchema.parse(full)).toEqual(full);
  });

  it.each([
    ['an empty name', { ...line, name: '' }],
    ['a missing unit price', { name: 'Widget' }],
    ['a negative unit price', { ...line, unitPrice: -1 }],
    ['a unit price over 10,000,000', { ...line, unitPrice: 10_000_001 }],
    ['a quantity of 0', { ...line, quantityOrdered: 0 }],
    ['a fractional quantity', { ...line, quantityOrdered: 1.5 }],
    ['a quantity over 1,000,000', { ...line, quantityOrdered: 1_000_001 }],
    ['a discount over 100 percent', { ...line, discountPercent: 101 }],
    ['negative tax', { ...line, taxPercent: -1 }],
    ['a SKU over 100 characters', { ...line, sku: 'x'.repeat(101) }],
  ])('rejects %s', (_name, input) => {
    expect(createPurchaseOrderLineSchema.safeParse(input).success).toBe(false);
  });

  it('accepts the upper bounds', () => {
    expect(
      createPurchaseOrderLineSchema.safeParse({ ...line, unitPrice: 10_000_000, quantityOrdered: 1_000_000, discountPercent: 100, taxPercent: 100 })
        .success,
    ).toBe(true);
  });
});

describe('updatePurchaseOrderLineSchema', () => {
  it('accepts a partial update and applies the same limits', () => {
    expect(updatePurchaseOrderLineSchema.parse({ quantityOrdered: 3 })).toEqual({ quantityOrdered: 3 });
    expect(updatePurchaseOrderLineSchema.parse({})).toEqual({});
    expect(updatePurchaseOrderLineSchema.safeParse({ quantityOrdered: 0 }).success).toBe(false);
  });
});

describe('markPurchaseOrderOrderedSchema', () => {
  it('accepts optional dates and rejects non-strings', () => {
    expect(markPurchaseOrderOrderedSchema.parse({})).toEqual({});
    expect(markPurchaseOrderOrderedSchema.parse({ orderDate: '2026-11-01', expectedDate: '2026-11-15' })).toEqual({
      orderDate: '2026-11-01',
      expectedDate: '2026-11-15',
    });
    expect(markPurchaseOrderOrderedSchema.safeParse({ orderDate: 5 }).success).toBe(false);
  });
});

describe('receivePurchaseOrderLineSchema', () => {
  it('accepts a line with location, lot and expiry', () => {
    const input = { itemId: 'it1', quantity: 3, rejected: 1, locationId: 'loc_1', lotNumber: 'L1', expiryDate: '2027-01-01' };
    expect(receivePurchaseOrderLineSchema.parse(input)).toEqual(input);
  });

  it('allows receiving 0 but rejects negatives, fractions and a missing item id', () => {
    expect(receivePurchaseOrderLineSchema.safeParse({ itemId: 'it1', quantity: 0 }).success).toBe(true);
    expect(receivePurchaseOrderLineSchema.safeParse({ itemId: 'it1', quantity: -1 }).success).toBe(false);
    expect(receivePurchaseOrderLineSchema.safeParse({ itemId: 'it1', quantity: 1.5 }).success).toBe(false);
    expect(receivePurchaseOrderLineSchema.safeParse({ itemId: 'it1', quantity: 1, rejected: -1 }).success).toBe(false);
    expect(receivePurchaseOrderLineSchema.safeParse({ itemId: '', quantity: 1 }).success).toBe(false);
  });
});

describe('receivePurchaseOrderSchema', () => {
  const lines = [{ itemId: 'it1', quantity: 2 }];

  it('accepts a receipt with an idempotency key and lines', () => {
    const input = { idempotencyKey: 'k1', lines, notes: 'dock 3' };
    expect(receivePurchaseOrderSchema.parse(input)).toEqual(input);
  });

  it('requires the idempotency key (1 to 100 characters) and at least one line', () => {
    expect(receivePurchaseOrderSchema.safeParse({ lines }).success).toBe(false);
    expect(receivePurchaseOrderSchema.safeParse({ idempotencyKey: '', lines }).success).toBe(false);
    expect(receivePurchaseOrderSchema.safeParse({ idempotencyKey: 'k'.repeat(101), lines }).success).toBe(false);
    expect(receivePurchaseOrderSchema.safeParse({ idempotencyKey: 'k', lines: [] }).success).toBe(false);
  });
});
