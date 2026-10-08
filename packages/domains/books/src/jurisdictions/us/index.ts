import type {
  JurisdictionAdapter,
  TaxCategoryTemplate,
  TaxIdentifierType,
  TaxIdentifierValidation,
  TaxRateDecision,
} from '../types';
import { getUsChartOfAccountsTemplate } from './chart-of-accounts';
import { getUsInvoiceRequirements } from './invoice-format';
import { validateEin, validateSsn, validateStateTaxId } from './identifiers';
import { buildUsSalesTaxReturn } from './sales-tax-return';

export * from './chart-of-accounts';
export * from './entity-types';
export * from './identifiers';
export * from './invoice-format';
export * from './tax-codes';
export * from './tax-lines';

/**
 * US sales tax is destination-based, differs per product and agency, and is
 * only collected where the seller is registered. It comes from the entity's
 * sales tax engine (`sales-tax/`), not from `tax_rates`. The one seeded rate,
 * a 0% "No sales tax", keeps the per-line rate pickers and the posting code
 * (which expect a rate per line) working; the engine's result replaces it on
 * every taxable document.
 */
const usTaxCategories: TaxCategoryTemplate[] = [
  {
    name: 'No sales tax',
    rate: '0.00',
    type: 'both',
    taxCategoryCode: 'exempt',
    isDefault: true,
    jurisdictionMetadata: { source: 'sales_tax_engine' },
  },
];

/**
 * An EIN or an SSN. `XX-XXXXXXX` is an EIN and `XXX-XX-XXXX` an SSN; nine bare
 * digits are an EIN when the prefix is one the IRS assigns, otherwise an SSN.
 */
function validateEinOrSsn(value: string): TaxIdentifierValidation {
  const trimmed = value.trim();
  if (/^\d{3}-\d{2}-\d{4}$/.test(trimmed)) return validateSsn(trimmed);
  if (/^\d{2}-\d{7}$/.test(trimmed)) return validateEin(trimmed);
  if (/^\d{9}$/.test(trimmed)) {
    const ein = validateEin(trimmed);
    if (ein.valid) return ein;
    const ssn = validateSsn(trimmed);
    return ssn.valid ? ssn : { valid: false, error: 'Enter an EIN (12-3456789) or an SSN (123-45-6789)' };
  }
  return { valid: false, error: 'Enter an EIN (12-3456789) or an SSN (123-45-6789)' };
}

export const usAdapter: JurisdictionAdapter = {
  code: 'US',
  name: 'United States',
  defaultLocale: 'en-US',
  defaultCurrency: 'USD',
  features: {
    vatReturn: false,
    icp: false,
    xafExport: false,
    smallBusinessScheme: false,
    gstReturn: false,
    salesTax: true,
    form1099: true,
  },
  terminology: {
    tax: 'sales_tax',
    taxId: 'ein',
    registrationId: 'state_id',
    supplier: 'vendor',
    creditNote: 'credit_memo',
  },
  // Sales tax a vendor charges is part of the cost; only accrued use tax reaches a return.
  purchaseTax: 'cost',

  getChartOfAccountsTemplate(opts) {
    return getUsChartOfAccountsTemplate(opts);
  },

  getStandardTaxCategories() {
    return usTaxCategories;
  },

  validateTaxIdentifier(type: TaxIdentifierType, value: string): TaxIdentifierValidation {
    switch (type) {
      case 'vatNumber':
        // The generic "tax number" slot holds the EIN for a US entity.
        return validateEin(value);
      case 'einOrSsn':
        return validateEinOrSsn(value);
      case 'registrationNumber':
        return validateStateTaxId(value);
    }
  },

  buildTaxReturn(entity, periodStart, periodEnd, lines) {
    return buildUsSalesTaxReturn(entity, periodStart, periodEnd, lines);
  },

  getInvoiceRequirements(locale) {
    return getUsInvoiceRequirements(locale ?? 'en-US');
  },

  resolveTaxRate(): TaxRateDecision {
    return {
      taxCategoryCode: 'exempt',
      rate: '0.00',
      reasoning:
        'US sales tax is computed per document by the sales tax engine (destination, product and exemption certificate), not from a rate table',
    };
  },
};
