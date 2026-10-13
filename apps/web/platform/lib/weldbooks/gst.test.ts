import { describe, expect, it } from 'vitest';
import { GST_FOREIGN_COUNTRY_CODE, gstSplitRows, isGstSplit, isValidHsnSac, placeOfSupplyName } from './gst';

describe('gst helpers', () => {
  it('accepts blank and 4 to 8 digit HSN/SAC codes only', () => {
    for (const ok of ['', '9983', '998313', '84713010']) expect(isValidHsnSac(ok), ok).toBe(true);
    for (const bad of ['998', '123456789', '99831A', '99 83']) expect(isValidHsnSac(bad), bad).toBe(false);
    expect(isValidHsnSac(undefined)).toBe(true);
  });

  it('names a place of supply', () => {
    expect(placeOfSupplyName('27', 'Outside India')).toBe('Maharashtra (27)');
    expect(placeOfSupplyName(GST_FOREIGN_COUNTRY_CODE, 'Outside India')).toBe('Outside India');
    expect(placeOfSupplyName('', 'Outside India')).toBe('');
    expect(placeOfSupplyName('99', 'Outside India')).toBe('99');
  });

  it('sums a breakdown per component and orders it CGST, SGST, IGST', () => {
    const rows = gstSplitRows([
      { taxRateName: 'SGST 9%', taxRate: 9, taxableAmount: 100, taxAmount: 9, component: 'sgst' },
      { taxRateName: 'CGST 9%', taxRate: 9, taxableAmount: 100, taxAmount: 9, component: 'cgst' },
      { taxRateName: 'CGST 9%', taxRate: 9, taxableAmount: 50, taxAmount: 4.5, component: 'cgst' },
      { taxRateName: 'IGST 18%', taxRate: 18, taxableAmount: 10, taxAmount: 1.8, component: 'igst' },
    ]);
    expect(rows.map((r) => [r.component, r.rate, r.taxableAmount, r.taxAmount])).toEqual([
      ['cgst', 9, 150, 13.5],
      ['sgst', 9, 100, 9],
      ['igst', 18, 10, 1.8],
    ]);
  });

  it('tells a split breakdown from an unsplit slab', () => {
    expect(isGstSplit([{ taxRateName: 'GST 18%', taxRate: 18, taxableAmount: 1, taxAmount: 0.18 }])).toBe(false);
    expect(isGstSplit([{ taxRateName: 'IGST 18%', taxRate: 18, taxableAmount: 1, taxAmount: 0.18, component: 'igst' }])).toBe(true);
    expect(isGstSplit(null)).toBe(false);
  });
});
