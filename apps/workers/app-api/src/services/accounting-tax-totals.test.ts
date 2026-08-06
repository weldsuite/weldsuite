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
});
