import { describe, expect, it } from 'vitest';
import type { PurchaseOrderLine } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { buildReceiveLines, initialReceiveRows, parseCount, validateReceiveRow } from './receive';

function line(overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'poi_1',
    purchaseOrderId: 'po_1',
    productId: 'prod_1',
    variantId: null,
    sku: 'W-1',
    name: 'Widget',
    quantityOrdered: 10,
    quantityReceived: 4,
    quantityPending: 6,
    quantityRejected: 1,
    unitPrice: '2.50',
    discountPercent: '0.00',
    discountAmount: '0.00',
    taxPercent: '21.00',
    taxAmount: '0.00',
    total: '25.00',
    lastReceivedDate: null,
    notes: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

describe('initialReceiveRows', () => {
  it('prefills what remains and skips lines that are complete', () => {
    const rows = initialReceiveRows([line(), line({ id: 'poi_2', quantityOrdered: 3, quantityReceived: 3, quantityRejected: 0 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: 'poi_1', remaining: 5, quantity: '5', rejected: '0' });
  });

  it('marks lot and expiry tracking from the product', () => {
    const rows = initialReceiveRows([line()], { prod_1: { trackLots: true, trackExpiry: true } });
    expect(rows[0]).toMatchObject({ trackLots: true, trackExpiry: true });
  });
});

describe('parseCount', () => {
  it('reads whole numbers, empty as zero, and rejects the rest', () => {
    expect(parseCount('12')).toBe(12);
    expect(parseCount('')).toBe(0);
    expect(parseCount(' 3 ')).toBe(3);
    expect(parseCount('-1')).toBeNull();
    expect(parseCount('1.5')).toBeNull();
    expect(parseCount('x')).toBeNull();
  });
});

describe('validateReceiveRow', () => {
  const base = initialReceiveRows([line()], { prod_1: { trackLots: true, trackExpiry: false } })[0];

  it('accepts what remains, with a lot for a lot-tracked product', () => {
    expect(validateReceiveRow({ ...base, lotNumber: 'L1' })).toBeNull();
  });

  it('refuses more than remains, counting rejected units', () => {
    expect(validateReceiveRow({ ...base, quantity: '5', rejected: '1', lotNumber: 'L1' })).toBe('over_receipt');
  });

  it('asks for a lot when units are received on a lot-tracked product, but not for rejected-only', () => {
    expect(validateReceiveRow(base)).toBe('lot_required');
    expect(validateReceiveRow({ ...base, quantity: '0', rejected: '2' })).toBeNull();
  });

  it('refuses text and negative numbers', () => {
    expect(validateReceiveRow({ ...base, quantity: 'abc' })).toBe('invalid_number');
    expect(validateReceiveRow({ ...base, rejected: '-1' })).toBe('invalid_number');
  });
});

describe('buildReceiveLines', () => {
  it('builds the request lines, leaving out rows with nothing and empty optional fields', () => {
    const [a, b] = [
      ...initialReceiveRows([line(), line({ id: 'poi_2', quantityReceived: 0, quantityRejected: 0 })], {
        prod_1: { trackLots: true, trackExpiry: true },
      }),
    ];
    const lines = buildReceiveLines([
      { ...a, quantity: '3', rejected: '1', locationId: 'loc_1', lotNumber: ' L9 ', expiryDate: '2027-01-31' },
      { ...b, quantity: '0', rejected: '0' },
    ]);
    expect(lines).toEqual([
      { itemId: 'poi_1', quantity: 3, rejected: 1, locationId: 'loc_1', lotNumber: 'L9', expiryDate: '2027-01-31' },
    ]);
  });

  it('keeps a rejected-only line with quantity zero', () => {
    const [row] = initialReceiveRows([line()]);
    expect(buildReceiveLines([{ ...row, quantity: '0', rejected: '2' }])).toEqual([
      { itemId: 'poi_1', quantity: 0, rejected: 2 },
    ]);
  });
});
