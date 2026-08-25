import { describe, expect, it } from 'vitest';
import {
  dominantTaxRate,
  exclusiveAmount,
  lineItemsForBill,
  normalizeOcrResult,
} from './accounting-ocr';

describe('normalizeOcrResult', () => {
  it('fills empty extraction with nulls rather than throwing', () => {
    const result = normalizeOcrResult({});
    expect(result.vendor.name).toBeNull();
    expect(result.lineItems).toEqual([]);
    expect(result.currency).toBe('EUR');
    expect(result.confidence.overall).toBe(0);
  });

  it('converts Dutch dates to ISO', () => {
    const result = normalizeOcrResult({ invoiceDate: '24-08-2026', dueDate: '1/9/2026' });
    expect(result.invoiceDate).toBe('2026-08-24');
    expect(result.dueDate).toBe('2026-09-01');
  });

  it('keeps ISO dates intact', () => {
    const result = normalizeOcrResult({ invoiceDate: '2026-08-24T12:00:00Z' });
    expect(result.invoiceDate).toBe('2026-08-24');
  });
});

describe('lineItemsForBill', () => {
  it('maps OCR line items through', () => {
    const ocr = normalizeOcrResult({
      lineItems: [{ description: 'Coffee', quantity: 2, unitPrice: 3.5, taxRate: 9, total: 7 }],
    });
    expect(lineItemsForBill(ocr)).toEqual([
      {
        description: 'Coffee',
        quantity: '2',
        unitPrice: '3.5',
        taxRate: '9',
        sortOrder: 0,
      },
    ]);
  });

  it('synthesises one line from a total-only receipt', () => {
    const ocr = normalizeOcrResult({
      vendor: { name: 'Shell' },
      total: 12.1,
      taxBreakdown: [{ rate: 21, taxableAmount: 10, taxAmount: 2.1 }],
    });
    const items = lineItemsForBill(ocr);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('Shell');
    expect(items[0].unitPrice).toBe('10');
    expect(items[0].taxRate).toBe('21');
  });
});

describe('exclusiveAmount', () => {
  it('prefers the stated subtotal', () => {
    const ocr = normalizeOcrResult({ subtotal: 40, total: 48.4, taxBreakdown: [{ rate: 21, taxableAmount: 40, taxAmount: 8.4 }] });
    expect(exclusiveAmount(ocr)).toBe(40);
  });

  it('backs out VAT from a total when no subtotal exists', () => {
    const ocr = normalizeOcrResult({
      total: 121,
      taxBreakdown: [{ rate: 21, taxableAmount: 100, taxAmount: 21 }],
    });
    expect(exclusiveAmount(ocr)).toBe(100);
    expect(dominantTaxRate(ocr)).toBe(21);
  });
});
