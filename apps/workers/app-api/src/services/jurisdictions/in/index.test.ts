import { describe, it, expect } from 'vitest';
import {
  inAdapter,
  validateGstin,
  validatePan,
  extractStateCodeFromGstin,
  extractPanFromGstin,
  expandGstTaxBreakdown,
} from './index';
import { listJurisdictions, hasAdapter, getAdapter } from '../registry';

describe('India GSTIN validation', () => {
  it('accepts a well-formed GSTIN and formats it', () => {
    const result = validateGstin('27aabcu9603r1zm');
    expect(result.valid).toBe(true);
    expect(result.formatted).toBe('27AABCU9603R1ZM');
  });

  it('rejects an invalid GSTIN', () => {
    expect(validateGstin('NL123456789B01').valid).toBe(false);
    expect(validateGstin('27AABCU9603R1').valid).toBe(false);
  });

  it('extracts state code and PAN from GSTIN', () => {
    expect(extractStateCodeFromGstin('27AABCU9603R1ZM')).toBe('27');
    expect(extractPanFromGstin('27AABCU9603R1ZM')).toBe('AABCU9603R');
  });

  it('validates PAN', () => {
    expect(validatePan('AABCU9603R').valid).toBe(true);
    expect(validatePan('invalid').valid).toBe(false);
  });
});

describe('India place-of-supply tax resolution', () => {
  it('returns CGST+SGST for intra-state (27→27)', () => {
    const decision = inAdapter.resolveTaxRate({
      isB2B: true,
      buyerCountry: 'IN',
      sellerStateCode: '27',
      buyerStateCode: '27',
      gstSlab: '18',
    });
    expect(decision.rate).toBe('18.00');
    expect(decision.components).toHaveLength(2);
    expect(decision.components?.map((c) => c.component).sort()).toEqual(['cgst', 'sgst']);
    expect(decision.components?.every((c) => c.rate === '9.00')).toBe(true);
    expect(decision.reasoning).toMatch(/Intra-state/i);
  });

  it('returns IGST for inter-state (27→29)', () => {
    const decision = inAdapter.resolveTaxRate({
      isB2B: true,
      buyerCountry: 'IN',
      sellerStateCode: '27',
      buyerStateCode: '29',
      gstSlab: '18',
    });
    expect(decision.components).toHaveLength(1);
    expect(decision.components?.[0].component).toBe('igst');
    expect(decision.components?.[0].rate).toBe('18.00');
    expect(decision.reasoning).toMatch(/Inter-state/i);
  });

  it('returns export 0% for non-India buyer', () => {
    const decision = inAdapter.resolveTaxRate({
      isB2B: true,
      buyerCountry: 'US',
      sellerStateCode: '27',
      gstSlab: '18',
    });
    expect(decision.taxCategoryCode).toBe('export_goods');
    expect(decision.rate).toBe('0.00');
    expect(decision.components).toBeUndefined();
  });
});

describe('expandGstTaxBreakdown', () => {
  const meta = {
    gstSlab: '18',
    components: {
      intrastate: [
        { code: 'cgst' as const, rate: '9.00', accountRole: 'tax_output_cgst' as const },
        { code: 'sgst' as const, rate: '9.00', accountRole: 'tax_output_sgst' as const },
      ],
      interstate: [
        { code: 'igst' as const, rate: '18.00', accountRole: 'tax_output_igst' as const },
      ],
    },
  };

  it('splits ₹1000 @ 18% intra-state into CGST 90 + SGST 90', () => {
    const rows = expandGstTaxBreakdown({
      taxableAmount: 1000,
      taxRateId: 'txr_1',
      taxRateName: 'GST 18%',
      slabRate: 18,
      jurisdictionMetadata: meta as unknown as Record<string, unknown>,
      sellerStateCode: '27',
      buyerStateCode: '27',
      buyerCountry: 'IN',
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.taxAmount).sort()).toEqual([90, 90]);
    expect(rows.map((r) => r.component).sort()).toEqual(['cgst', 'sgst']);
  });

  it('applies IGST for inter-state', () => {
    const rows = expandGstTaxBreakdown({
      taxableAmount: 1000,
      taxRateId: 'txr_1',
      taxRateName: 'GST 18%',
      slabRate: 18,
      jurisdictionMetadata: meta as unknown as Record<string, unknown>,
      sellerStateCode: '27',
      buyerStateCode: '29',
      buyerCountry: 'IN',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].component).toBe('igst');
    expect(rows[0].taxAmount).toBe(180);
  });
});

describe('IN adapter registration', () => {
  it('is registered alongside NL', () => {
    expect(hasAdapter('IN')).toBe(true);
    expect(hasAdapter('NL')).toBe(true);
    const codes = listJurisdictions().map((j) => j.code).sort();
    expect(codes).toEqual(['IN', 'NL']);
    expect(getAdapter('IN').defaultCurrency).toBe('INR');
  });

  it('seeds CoA with GST system roles and standard tax categories', () => {
    const coa = inAdapter.getChartOfAccountsTemplate();
    const roles = coa.map((a) => a.systemRole).filter(Boolean);
    expect(roles).toContain('tax_output_cgst');
    expect(roles).toContain('tax_output_sgst');
    expect(roles).toContain('tax_output_igst');
    expect(roles).toContain('accounts_receivable');

    const taxes = inAdapter.getStandardTaxCategories();
    expect(taxes.some((t) => t.isDefault && t.rate === '18.00')).toBe(true);
    expect(taxes.some((t) => t.name.includes('GST 5%'))).toBe(true);
  });
});
