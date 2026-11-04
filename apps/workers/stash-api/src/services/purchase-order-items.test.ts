import { describe, expect, it } from 'vitest';
import { centsText, lineAmounts, twoDecimalText } from './purchase-order-items';

// Mirrored by rust/modules/stash/src/purchase_order_items.rs (its unit tests):
// the two backends must write the same text.

const line = (quantityOrdered: number, quantityReceived: number, unitPrice: number, discountPercent: number, taxPercent: number) =>
  lineAmounts({ quantityOrdered, quantityReceived, unitPrice, discountPercent, taxPercent });

describe('lineAmounts', () => {
  it('works out discount, tax and total in cents', () => {
    expect(line(3, 0, 600, 10, 21)).toEqual({
      unitPrice: '600.00',
      discountPercent: '10.00',
      taxPercent: '21.00',
      discountAmount: '180.00',
      taxAmount: '340.20',
      total: '1960.20',
      quantityPending: 3,
    });
  });

  it('a plain line has no discount and no tax', () => {
    expect(line(1, 0, 12.5, 0, 0)).toMatchObject({ total: '12.50', discountAmount: '0.00', taxAmount: '0.00' });
  });

  it('rounds each step to the cent, half up', () => {
    // 3 x 0.35 = 1.05; 15% off = 0.1575 -> 0.16; net 0.89; 21% tax = 0.1869 -> 0.19.
    expect(line(3, 0, 0.35, 15, 21)).toMatchObject({ discountAmount: '0.16', taxAmount: '0.19', total: '1.08' });
  });

  it('pending is ordered less received and never below zero', () => {
    expect(line(4, 1, 1, 0, 0).quantityPending).toBe(3);
    expect(line(2, 5, 1, 0, 0).quantityPending).toBe(0);
  });
});

describe('centsText', () => {
  it('writes whole cents as numeric text', () => {
    expect(centsText(0)).toBe('0.00');
    expect(centsText(5)).toBe('0.05');
    expect(centsText(123_456)).toBe('1234.56');
    expect(twoDecimalText(1.1)).toBe('1.10');
  });
});
