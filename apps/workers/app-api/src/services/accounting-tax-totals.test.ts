import { describe, it, expect } from 'vitest';
import { calculateLineTaxTotals } from './accounting-tax-totals';

describe('calculateLineTaxTotals', () => {
  it('keeps single-rate breakdown for non-IN jurisdictions', () => {
    const result = calculateLineTaxTotals(
      [
        {
          quantity: '1',
          unitPrice: '100',
          discountPercent: '0',
          taxRate: '21',
          taxRateName: 'BTW Hoog 21%',
        },
      ],
      { jurisdictionCode: 'NL' },
    );
    expect(result.taxTotal).toBe('21.00');
    expect(result.taxBreakdown).toHaveLength(1);
    expect(result.taxBreakdown[0].taxRate).toBe(21);
  });

  it('expands IN GST slab into CGST+SGST for intra-state', () => {
    const result = calculateLineTaxTotals(
      [
        {
          quantity: '1',
          unitPrice: '1000',
          discountPercent: '0',
          taxRate: '18',
          taxRateId: 'txr_gst18',
          taxRateName: 'GST 18%',
          jurisdictionMetadata: {
            gstSlab: '18',
            components: {
              intrastate: [
                { code: 'cgst', rate: '9.00', accountRole: 'tax_output_cgst' },
                { code: 'sgst', rate: '9.00', accountRole: 'tax_output_sgst' },
              ],
              interstate: [
                { code: 'igst', rate: '18.00', accountRole: 'tax_output_igst' },
              ],
            },
          },
        },
      ],
      {
        jurisdictionCode: 'IN',
        sellerStateCode: '27',
        buyerStateCode: '27',
        buyerCountry: 'IN',
      },
    );
    expect(result.taxTotal).toBe('180.00');
    expect(result.taxBreakdown).toHaveLength(2);
    expect(result.taxBreakdown.map((r) => r.component).sort()).toEqual(['cgst', 'sgst']);
  });

  it('treats quantity 0 as zero, not one', () => {
    const result = calculateLineTaxTotals(
      [
        {
          quantity: '0',
          unitPrice: '100',
          discountPercent: '0',
          taxRate: '18',
        },
      ],
      { jurisdictionCode: 'NL' },
    );
    expect(result.subtotal).toBe('0.00');
    expect(result.taxTotal).toBe('0.00');
  });

  it('uses tax_input_* roles for purchase direction', () => {
    const result = calculateLineTaxTotals(
      [
        {
          quantity: '1',
          unitPrice: '1000',
          discountPercent: '0',
          taxRate: '18',
          taxRateId: 'txr_gst18',
          taxRateName: 'GST 18%',
          jurisdictionMetadata: {
            gstSlab: '18',
            components: {
              intrastate: [
                { code: 'cgst', rate: '9.00', accountRole: 'tax_output_cgst' },
                { code: 'sgst', rate: '9.00', accountRole: 'tax_output_sgst' },
              ],
              interstate: [
                { code: 'igst', rate: '18.00', accountRole: 'tax_output_igst' },
              ],
            },
          },
        },
      ],
      {
        jurisdictionCode: 'IN',
        sellerStateCode: '27',
        buyerStateCode: '27',
        buyerCountry: 'IN',
        direction: 'purchase',
      },
    );
    expect(result.taxBreakdown.map((r) => r.accountRole).sort()).toEqual([
      'tax_input_cgst',
      'tax_input_sgst',
    ]);
  });

  it('keeps processedItems tax consistent with breakdown for fractional-cent GST', () => {
    const result = calculateLineTaxTotals(
      [
        {
          quantity: '1',
          unitPrice: '0.03',
          discountPercent: '0',
          taxRate: '18',
          taxRateId: 'txr_gst18',
          taxRateName: 'GST 18%',
          jurisdictionMetadata: {
            gstSlab: '18',
            components: {
              intrastate: [
                { code: 'cgst', rate: '9.00', accountRole: 'tax_output_cgst' },
                { code: 'sgst', rate: '9.00', accountRole: 'tax_output_sgst' },
              ],
              interstate: [
                { code: 'igst', rate: '18.00', accountRole: 'tax_output_igst' },
              ],
            },
          },
        },
      ],
      {
        jurisdictionCode: 'IN',
        sellerStateCode: '27',
        buyerStateCode: '27',
        buyerCountry: 'IN',
      },
    );
    const processedTax = result.processedItems.reduce((s, p) => s + parseFloat(p.taxAmount), 0);
    const breakdownTax = result.taxBreakdown.reduce((s, r) => s + r.taxAmount, 0);
    expect(result.taxTotal).toBe(processedTax.toFixed(2));
    expect(parseFloat(result.taxTotal)).toBeCloseTo(breakdownTax, 2);
    expect(result.total).toBe(
      (parseFloat(result.subtotal) + parseFloat(result.taxTotal)).toFixed(2),
    );
  });

  it('keeps export GST at zero even when slab rate is nonzero', () => {
    const result = calculateLineTaxTotals(
      [
        {
          quantity: '1',
          unitPrice: '100',
          discountPercent: '0',
          taxRate: '18',
          taxRateId: 'txr_gst18',
          taxRateName: 'GST 18%',
          jurisdictionMetadata: {
            gstSlab: '18',
            components: {
              intrastate: [
                { code: 'cgst', rate: '9.00', accountRole: 'tax_output_cgst' },
                { code: 'sgst', rate: '9.00', accountRole: 'tax_output_sgst' },
              ],
              interstate: [
                { code: 'igst', rate: '18.00', accountRole: 'tax_output_igst' },
              ],
            },
          },
        },
      ],
      {
        jurisdictionCode: 'IN',
        sellerStateCode: '27',
        buyerStateCode: '27',
        buyerCountry: 'US',
      },
    );
    expect(result.taxTotal).toBe('0.00');
    expect(result.total).toBe('100.00');
    expect(result.taxBreakdown).toHaveLength(1);
    expect(result.taxBreakdown[0].component).toBe('export');
    expect(result.taxBreakdown[0].taxAmount).toBe(0);
  });
});
