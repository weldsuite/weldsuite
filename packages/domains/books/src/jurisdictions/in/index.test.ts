import { describe, it, expect } from 'vitest';
import {
  inAdapter,
  validateGstin,
  validatePan,
  extractStateCodeFromGstin,
  extractPanFromGstin,
  expandGstTaxBreakdown,
  gstinCheckCharacter,
  gstStateCodeFromText,
  usesUtgst,
} from './index';
import { listJurisdictions, hasAdapter, getAdapter } from '../registry';

describe('India GSTIN validation', () => {
  it('accepts a well-formed GSTIN and formats it', () => {
    const result = validateGstin('27aabcu9603r1zn');
    expect(result.valid).toBe(true);
    expect(result.formatted).toBe('27AABCU9603R1ZN');
  });

  it('verifies the check digit', () => {
    expect(gstinCheckCharacter('27AABCU9603R1Z')).toBe('N');
    expect(validateGstin('27AAPFU0939F1ZV').valid).toBe(true);
    // Right shape, wrong check character.
    const wrong = validateGstin('27AABCU9603R1ZX');
    expect(wrong.valid).toBe(false);
    expect(wrong.error).toMatch(/check digit/i);
    expect(validateGstin('27AABCU9603R1ZM').valid).toBe(false);
  });

  it('rejects state codes outside 01-38 and 97', () => {
    // Same body with the state code swapped: the check digit is recomputed so only the state code can fail.
    for (const code of ['00', '39', '99']) {
      const body = `${code}AABCU9603R1Z`;
      const gstin = body + gstinCheckCharacter(body);
      const result = validateGstin(gstin);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/state code/i);
    }
    const body97 = '97AABCU9603R1Z';
    expect(validateGstin(body97 + gstinCheckCharacter(body97)).valid).toBe(true);
  });

  it('requires the PAN inside the GSTIN to match the entity PAN', () => {
    expect(validateGstin('27AABCU9603R1ZN', { pan: 'AABCU9603R' }).valid).toBe(true);
    expect(validateGstin('27AABCU9603R1ZN', { pan: 'aabcu9603r' }).valid).toBe(true);
    const mismatch = validateGstin('27AABCU9603R1ZN', { pan: 'AAPFU0939F' });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.error).toMatch(/PAN/);
    // No PAN given: nothing to compare.
    expect(validateGstin('27AABCU9603R1ZN', { pan: '' }).valid).toBe(true);
  });

  it('rejects an invalid GSTIN', () => {
    expect(validateGstin('NL123456789B01').valid).toBe(false);
    expect(validateGstin('27AABCU9603R1').valid).toBe(false);
  });

  it('extracts state code and PAN from GSTIN', () => {
    expect(extractStateCodeFromGstin('27AABCU9603R1ZN')).toBe('27');
    expect(extractPanFromGstin('27AABCU9603R1ZN')).toBe('AABCU9603R');
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

  it('fails closed without components when place of supply is unknown', () => {
    const decision = inAdapter.resolveTaxRate({
      isB2B: true,
      buyerCountry: 'IN',
      gstSlab: '18',
    });
    expect(decision.rate).toBe('18.00');
    expect(decision.components).toBeUndefined();
    expect(decision.reasoning).toMatch(/place of supply unknown/i);
  });

  it('rejects an unsupported GST slab instead of falling back to 18%', () => {
    const decision = inAdapter.resolveTaxRate({
      isB2B: true,
      buyerCountry: 'IN',
      sellerStateCode: '27',
      buyerStateCode: '27',
      gstSlab: '15',
    });
    expect(decision.rate).toBe('0.00');
    expect(decision.reasoning).toMatch(/Unsupported GST slab/i);
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

  it('fails closed to a single slab row when states are missing', () => {
    const rows = expandGstTaxBreakdown({
      taxableAmount: 1000,
      taxRateId: 'txr_1',
      taxRateName: 'GST 18%',
      slabRate: 18,
      jurisdictionMetadata: meta as unknown as Record<string, unknown>,
      buyerCountry: 'IN',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].component).toBeUndefined();
    expect(rows[0].taxAmount).toBe(180);
  });

  it('maps purchase direction to tax_input_* roles', () => {
    const rows = expandGstTaxBreakdown({
      taxableAmount: 1000,
      taxRateId: 'txr_1',
      taxRateName: 'GST 18%',
      slabRate: 18,
      jurisdictionMetadata: meta as unknown as Record<string, unknown>,
      sellerStateCode: '27',
      buyerStateCode: '27',
      buyerCountry: 'IN',
      direction: 'purchase',
    });
    expect(rows.map((r) => r.accountRole).sort()).toEqual([
      'tax_input_cgst',
      'tax_input_sgst',
    ]);
  });
});

describe('IN adapter registration', () => {
  it('is registered alongside NL', () => {
    expect(hasAdapter('IN')).toBe(true);
    expect(hasAdapter('NL')).toBe(true);
    const codes = listJurisdictions().map((j) => j.code).sort();
    expect(codes).toEqual(['BR', 'IN', 'NL', 'US']);
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
    expect(taxes.some((t) => t.rate === '40.00')).toBe(true);
  });
});

describe('India state codes', () => {
  it('maps state names, ISO codes and GST codes to the GST state code', () => {
    expect(gstStateCodeFromText('Maharashtra')).toBe('27');
    expect(gstStateCodeFromText('maharashtra ')).toBe('27');
    expect(gstStateCodeFromText('MH')).toBe('27');
    expect(gstStateCodeFromText('IN-KA')).toBe('29');
    expect(gstStateCodeFromText('29')).toBe('29');
    expect(gstStateCodeFromText('Orissa')).toBe('21');
    expect(gstStateCodeFromText('Atlantis')).toBeUndefined();
    expect(gstStateCodeFromText('99')).toBeUndefined();
  });

  it('levies UTGST only in union territories without a legislature', () => {
    expect(usesUtgst('04')).toBe(true);
    expect(usesUtgst('27')).toBe(false);
    expect(usesUtgst('07')).toBe(false);
  });
});

describe('India GST split on intra-UT, export and legacy slabs', () => {
  const slab18 = inAdapter.getStandardTaxCategories().find((t) => t.name === 'GST 18%')!;
  const base = {
    taxableAmount: 1000,
    taxRateId: 'txr_1',
    taxRateName: 'GST 18%',
    slabRate: 18,
    jurisdictionMetadata: slab18.jurisdictionMetadata,
  };

  it('splits an intra-state supply into CGST + SGST with the output account roles', () => {
    const rows = expandGstTaxBreakdown({ ...base, sellerStateCode: '27', buyerStateCode: '27' });
    expect(rows.map((r) => [r.component, r.taxAmount, r.accountRole])).toEqual([
      ['cgst', 90, 'tax_output_cgst'],
      ['sgst', 90, 'tax_output_sgst'],
    ]);
  });

  it('charges IGST on an inter-state supply', () => {
    const rows = expandGstTaxBreakdown({ ...base, sellerStateCode: '27', buyerStateCode: '29' });
    expect(rows.map((r) => [r.component, r.taxAmount, r.accountRole])).toEqual([['igst', 180, 'tax_output_igst']]);
  });

  it('uses the input accounts on the purchase side', () => {
    const rows = expandGstTaxBreakdown({ ...base, sellerStateCode: '27', buyerStateCode: '29', direction: 'purchase' });
    expect(rows[0].accountRole).toBe('tax_input_igst');
  });

  it('charges UTGST instead of SGST inside a union territory without a legislature', () => {
    const rows = expandGstTaxBreakdown({ ...base, sellerStateCode: '04', buyerStateCode: '04' });
    expect(rows.map((r) => r.component)).toEqual(['cgst', 'utgst']);
    // Posts to the SGST account until dedicated UTGST ledger roles exist.
    expect(rows[1].accountRole).toBe('tax_output_sgst');
  });

  it('zero-rates an export, also when the place of supply is the foreign-country code', () => {
    const byCountry = expandGstTaxBreakdown({ ...base, sellerStateCode: '27', buyerStateCode: '27', buyerCountry: 'US' });
    expect(byCountry).toHaveLength(1);
    expect(byCountry[0].taxAmount).toBe(0);
    const byCode = expandGstTaxBreakdown({ ...base, sellerStateCode: '27', buyerStateCode: '96' });
    expect(byCode[0].component).toBe('export');
  });
});

describe('India seeded rate table', () => {
  const rates = inAdapter.getStandardTaxCategories();

  it('keeps 5, 18 and 40 percent active, with 3 and 0.25 percent for gold and rough diamonds', () => {
    for (const name of ['GST 5%', 'GST 18%', 'GST 40%', 'GST 3% (gold, silver)', 'GST 0.25% (rough diamonds)']) {
      const rate = rates.find((r) => r.name === name);
      expect(rate, name).toBeDefined();
      expect(rate?.isActive ?? true).toBe(true);
    }
    expect(rates.find((r) => r.isDefault)?.name).toBe('GST 18%');
  });

  it('seeds the old 12 and 28 percent slabs as inactive legacy rows', () => {
    for (const rate of ['12.00', '28.00']) {
      const row = rates.find((r) => r.rate === rate);
      expect(row?.isActive).toBe(false);
      expect((row?.jurisdictionMetadata as { legacy?: boolean }).legacy).toBe(true);
    }
  });

  it('keeps zero, exempt, export and reverse charge', () => {
    const codes = rates.map((r) => r.taxCategoryCode);
    expect(codes).toEqual(expect.arrayContaining(['zero', 'exempt', 'export_goods', 'reverse_charge']));
  });
});
