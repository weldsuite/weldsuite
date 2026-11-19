import { describe, expect, it } from 'vitest';
import { computePurchaseOrderTotals, previewLineAmounts } from './po-totals';

describe('previewLineAmounts', () => {
  it('discounts the line, then adds tax on what is left', () => {
    // 10 x 12.50 = 125.00; 10% off = 12.50; net 112.50; 21% tax = 23.625 -> 23.63
    const amounts = previewLineAmounts({ quantityOrdered: 10, unitPrice: 12.5, discountPercent: 10, taxPercent: 21 });
    expect(amounts.gross).toBe(125);
    expect(amounts.discountAmount).toBe(12.5);
    expect(amounts.taxAmount).toBe(23.63);
    expect(amounts.total).toBe(136.13);
  });

  it('is exact in cents for awkward prices', () => {
    const amounts = previewLineAmounts({ quantityOrdered: 3, unitPrice: 0.1, discountPercent: 0, taxPercent: 0 });
    expect(amounts.total).toBe(0.3);
  });
});

describe('computePurchaseOrderTotals', () => {
  const lines = [
    { quantityOrdered: 10, quantityReceived: 4, total: '121.00', taxAmount: '21.00' },
    { quantityOrdered: 5, quantityReceived: null, total: '54.50', taxAmount: '4.50' },
  ];

  it('sums subtotal, tax and quantities from the lines', () => {
    const totals = computePurchaseOrderTotals(lines);
    expect(totals.itemCount).toBe(2);
    expect(totals.totalQuantityOrdered).toBe(15);
    expect(totals.totalQuantityReceived).toBe(4);
    expect(totals.taxTotal).toBe(25.5);
    // Line totals include tax, so the subtotal takes it out again.
    expect(totals.subtotal).toBe(150);
    expect(totals.total).toBe(175.5);
  });

  it('adds shipping and takes off the header discount', () => {
    const totals = computePurchaseOrderTotals(lines, { shippingTotal: '10.00', discountTotal: 5 });
    expect(totals.shippingTotal).toBe(10);
    expect(totals.discountTotal).toBe(5);
    expect(totals.total).toBe(180.5);
  });

  it('reads an order without lines as zero', () => {
    const totals = computePurchaseOrderTotals([]);
    expect(totals).toMatchObject({ itemCount: 0, subtotal: 0, taxTotal: 0, total: 0 });
  });

  it('treats missing or unparsable amounts as zero', () => {
    const totals = computePurchaseOrderTotals([{ quantityOrdered: 1, total: null, taxAmount: 'abc' }]);
    expect(totals.total).toBe(0);
  });
});
