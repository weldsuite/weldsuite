import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WELD_TAX_CODE,
  WELD_TAX_CODES,
  WELD_TAX_CODE_INFO,
  isAvalaraTaxCode,
  isStripeTaxCode,
  isWeldTaxCode,
  normalizeWeldTaxCode,
  toAvalaraTaxCode,
  toStripeTaxCode,
} from './tax-codes';
import { SalesTaxEngineError } from '../../sales-tax/types';

describe('WeldBooks tax codes', () => {
  it('lists the twelve product codes with a label and description each', () => {
    expect(WELD_TAX_CODES).toHaveLength(12);
    for (const code of WELD_TAX_CODES) {
      const info = WELD_TAX_CODE_INFO[code];
      expect(info.code).toBe(code);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(10);
    }
  });

  it('recognises WeldBooks codes only', () => {
    expect(isWeldTaxCode('saas')).toBe(true);
    expect(isWeldTaxCode('txcd_99999999')).toBe(false);
    expect(isWeldTaxCode('P0000000')).toBe(false);
    expect(isWeldTaxCode('')).toBe(false);
    expect(isWeldTaxCode(undefined)).toBe(false);
  });

  it('falls back to general for a stored value it does not know', () => {
    expect(normalizeWeldTaxCode('clothing')).toBe('clothing');
    expect(normalizeWeldTaxCode('standard')).toBe(DEFAULT_WELD_TAX_CODE);
    expect(normalizeWeldTaxCode(null)).toBe('general');
    expect(normalizeWeldTaxCode(undefined)).toBe('general');
  });
});

describe('Stripe Tax codes', () => {
  it('maps every WeldBooks code to a txcd code, for both uses', () => {
    for (const code of WELD_TAX_CODES) {
      for (const use of ['business', 'personal'] as const) {
        const mapped = toStripeTaxCode(code, use);
        expect(isStripeTaxCode(mapped), `${code} ${use} -> ${mapped}`).toBe(true);
      }
    }
  });

  it('uses the published codes', () => {
    expect(toStripeTaxCode('general')).toBe('txcd_99999999');
    expect(toStripeTaxCode('services')).toBe('txcd_20030000');
    expect(toStripeTaxCode('professional_services')).toBe('txcd_20060000');
    expect(toStripeTaxCode('shipping')).toBe('txcd_92010001');
    expect(toStripeTaxCode('handling')).toBe('txcd_92010004');
    expect(toStripeTaxCode('clothing')).toBe('txcd_30011000');
    expect(toStripeTaxCode('prescription_drugs')).toBe('txcd_32020001');
    expect(toStripeTaxCode('food_grocery')).toBe('txcd_40040000');
    expect(toStripeTaxCode('prepared_food')).toBe('txcd_40060003');
    expect(toStripeTaxCode('non_taxable')).toBe('txcd_00000000');
    expect(toStripeTaxCode('digital_goods')).toBe('txcd_10000000');
  });

  it('splits SaaS by business or personal use', () => {
    expect(toStripeTaxCode('saas', 'business')).toBe('txcd_10103001');
    expect(toStripeTaxCode('saas', 'personal')).toBe('txcd_10103000');
    expect(toStripeTaxCode('saas')).toBe('txcd_10103001');
  });

  it('passes a Stripe code through, treats blank as general, and refuses to guess anything else', () => {
    expect(toStripeTaxCode('txcd_10302000')).toBe('txcd_10302000');
    expect(toStripeTaxCode('')).toBe('txcd_99999999');
    expect(toStripeTaxCode('  ')).toBe('txcd_99999999');
    expect(() => toStripeTaxCode('grocery')).toThrow(SalesTaxEngineError);
    expect(() => toStripeTaxCode('P0000000')).toThrow(/No Stripe tax code is mapped/);
    expect(() => toStripeTaxCode('txcd_123')).toThrow(SalesTaxEngineError);
  });
});

describe('Avalara tax codes', () => {
  it('maps every WeldBooks code to an Avalara code, for both uses', () => {
    for (const code of WELD_TAX_CODES) {
      for (const use of ['business', 'personal'] as const) {
        const mapped = toAvalaraTaxCode(code, use);
        expect(isAvalaraTaxCode(mapped), `${code} ${use} -> ${mapped}`).toBe(true);
      }
    }
  });

  it('uses the Avalara codes', () => {
    expect(toAvalaraTaxCode('general')).toBe('P0000000');
    expect(toAvalaraTaxCode('non_taxable')).toBe('NT');
    expect(toAvalaraTaxCode('digital_goods')).toBe('D0000000');
    expect(toAvalaraTaxCode('shipping')).toBe('FR020100');
    expect(toAvalaraTaxCode('services')).toBe('S0000000');
    expect(toAvalaraTaxCode('professional_services')).toBe('SP140000');
    expect(toAvalaraTaxCode('prescription_drugs')).toBe('PH050102');
  });

  it('splits clothing and SaaS by use', () => {
    expect(toAvalaraTaxCode('clothing', 'personal')).toBe('PC040100');
    expect(toAvalaraTaxCode('clothing', 'business')).toBe('PC030100');
    expect(toAvalaraTaxCode('saas', 'personal')).toBe('SW054000');
    expect(toAvalaraTaxCode('saas', 'business')).toBe('SW054002');
  });

  it('passes an Avalara code through, treats blank as general, and refuses to guess anything else', () => {
    expect(toAvalaraTaxCode('PC040158')).toBe('PC040158');
    expect(toAvalaraTaxCode('NT')).toBe('NT');
    expect(toAvalaraTaxCode('')).toBe('P0000000');
    expect(() => toAvalaraTaxCode('grocery')).toThrow(SalesTaxEngineError);
    expect(() => toAvalaraTaxCode('txcd_99999999')).toThrow(/No Avalara tax code is mapped/);
    expect(() => toAvalaraTaxCode('ABC')).toThrow(SalesTaxEngineError);
  });

  it('keeps provider code shapes apart', () => {
    expect(isStripeTaxCode('PC040100')).toBe(false);
    expect(isAvalaraTaxCode('txcd_99999999')).toBe(false);
    expect(isAvalaraTaxCode('general')).toBe(false);
    expect(isAvalaraTaxCode('NT')).toBe(true);
    expect(isAvalaraTaxCode('PA0010000')).toBe(true);
  });

  it('is deterministic: the same inputs give the same code', () => {
    for (const code of WELD_TAX_CODES) {
      expect(toAvalaraTaxCode(code, 'business')).toBe(toAvalaraTaxCode(code, 'business'));
      expect(toStripeTaxCode(code, 'personal')).toBe(toStripeTaxCode(code, 'personal'));
    }
  });
});
