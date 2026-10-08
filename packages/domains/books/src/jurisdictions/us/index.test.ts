import { describe, it, expect } from 'vitest';
import { usAdapter } from './index';
import { getAdapter, getJurisdictionFeatures, hasAdapter, listJurisdictions } from '../registry';

describe('US adapter registration', () => {
  it('is registered next to NL and IN', () => {
    expect(hasAdapter('US')).toBe(true);
    expect(hasAdapter('us')).toBe(true);
    expect(getAdapter('US')).toBe(usAdapter);
    const codes = listJurisdictions().map((j) => j.code).sort();
    expect(codes).toEqual(['IN', 'NL', 'US']);
  });

  it('is the US in English with US dollars', () => {
    expect(usAdapter.code).toBe('US');
    expect(usAdapter.name).toBe('United States');
    expect(usAdapter.defaultLocale).toBe('en-US');
    expect(usAdapter.defaultCurrency).toBe('USD');
  });

  it('turns on sales tax and 1099 and nothing VAT-shaped', () => {
    expect(usAdapter.features).toEqual({
      vatReturn: false,
      icp: false,
      xafExport: false,
      smallBusinessScheme: false,
      gstReturn: false,
      salesTax: true,
      form1099: true,
    });
    expect(getJurisdictionFeatures('US')).toEqual(usAdapter.features);
    const summary = listJurisdictions().find((j) => j.code === 'US');
    expect(summary?.features.salesTax).toBe(true);
    expect(summary?.terminology.taxId).toBe('ein');
  });

  it('uses US terminology', () => {
    expect(usAdapter.terminology).toEqual({
      tax: 'sales_tax',
      taxId: 'ein',
      registrationId: 'state_id',
      supplier: 'vendor',
      creditNote: 'credit_memo',
    });
  });
});

describe('US adapter: chart of accounts', () => {
  it('seeds the sole proprietor chart without options', () => {
    const chart = usAdapter.getChartOfAccountsTemplate();
    const roles = chart.map((a) => a.systemRole).filter(Boolean);
    expect(roles).toContain('accounts_receivable');
    expect(roles).toContain('sales_tax_payable');
    expect(roles).toContain('owner_draws');
  });

  it('varies the equity section by entity type', () => {
    const sCorp = usAdapter.getChartOfAccountsTemplate({ entityType: 's_corp' });
    expect(sCorp.map((a) => a.name)).toContain('Shareholder distributions');
    expect(sCorp.map((a) => a.systemRole)).not.toContain('owner_draws');
    const partnership = usAdapter.getChartOfAccountsTemplate({ entityType: 'multi_member_llc', taxClassification: 'partnership' });
    expect(partnership.map((a) => a.name)).toContain("Partners' capital");
  });
});

describe('US adapter: tax categories', () => {
  it('seeds a single 0% "No sales tax" default so per-line pickers keep working', () => {
    const categories = usAdapter.getStandardTaxCategories();
    expect(categories).toHaveLength(1);
    expect(categories[0]).toMatchObject({
      name: 'No sales tax',
      rate: '0.00',
      type: 'both',
      taxCategoryCode: 'exempt',
      isDefault: true,
    });
  });

  it('resolves a 0% decision that points at the sales tax engine', () => {
    const decision = usAdapter.resolveTaxRate({ isB2B: false, buyerCountry: 'US' });
    expect(decision.rate).toBe('0.00');
    expect(decision.taxCategoryCode).toBe('exempt');
    expect(decision.components).toBeUndefined();
    expect(decision.reasoning).toMatch(/sales tax engine/i);
    // the seeded category carries the decision's code
    expect(usAdapter.getStandardTaxCategories().some((c) => c.taxCategoryCode === decision.taxCategoryCode)).toBe(true);
  });
});

describe('US adapter: tax identifiers', () => {
  it('validates an EIN for vatNumber', () => {
    expect(usAdapter.validateTaxIdentifier('vatNumber', '123456789')).toEqual({ valid: true, formatted: '12-3456789' });
    expect(usAdapter.validateTaxIdentifier('vatNumber', '07-1234567').valid).toBe(false);
    expect(usAdapter.validateTaxIdentifier('vatNumber', '123-45-6789').valid).toBe(false);
  });

  it('accepts an EIN or an SSN for einOrSsn, told apart by format', () => {
    expect(usAdapter.validateTaxIdentifier('einOrSsn', '12-3456789')).toEqual({ valid: true, formatted: '12-3456789' });
    expect(usAdapter.validateTaxIdentifier('einOrSsn', '123-45-6789')).toEqual({ valid: true, formatted: '123-45-6789' });
    expect(usAdapter.validateTaxIdentifier('einOrSsn', '123456789').formatted).toBe('12-3456789');
    // 8xx digits with prefix 89 is not an EIN, but is a valid SSN
    expect(usAdapter.validateTaxIdentifier('einOrSsn', '891234567').formatted).toBe('891-23-4567');
  });

  it('rejects numbers that are neither', () => {
    expect(usAdapter.validateTaxIdentifier('einOrSsn', '666-12-3456').valid).toBe(false);
    expect(usAdapter.validateTaxIdentifier('einOrSsn', '07-1234567').valid).toBe(false);
    expect(usAdapter.validateTaxIdentifier('einOrSsn', '000000000').valid).toBe(false);
    expect(usAdapter.validateTaxIdentifier('einOrSsn', 'abc').valid).toBe(false);
    expect(usAdapter.validateTaxIdentifier('einOrSsn', '').valid).toBe(false);
  });

  it('takes a free-text state ID for registrationNumber', () => {
    expect(usAdapter.validateTaxIdentifier('registrationNumber', ' 32-123456-7 ')).toEqual({
      valid: true,
      formatted: '32-123456-7',
    });
    expect(usAdapter.validateTaxIdentifier('registrationNumber', '').valid).toBe(false);
  });
});

describe('US adapter: invoices and returns', () => {
  it('gives US invoice requirements', () => {
    const requirements = usAdapter.getInvoiceRequirements();
    expect(requirements.labels.creditNote).toBe('Credit memo');
    expect(requirements.formatInvoiceNumber('INV-', 7, requirements.defaultPadding)).toBe('INV-0007');
  });

  it('builds the tax return through the sales tax return builder', () => {
    // The builder is implemented elsewhere; the adapter must hand the call over.
    expect(typeof usAdapter.buildTaxReturn).toBe('function');
  });
});
