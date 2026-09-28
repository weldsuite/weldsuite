import type {
  JurisdictionAdapter,
  TaxIdentifierType,
  TaxIdentifierValidation,
  TaxResolutionContext,
  TaxRateDecision,
} from '../types';
import { nlChartOfAccounts } from './chart-of-accounts';
import { nlTaxCategories } from './tax-categories';
import { getNlInvoiceRequirements } from './invoice-format';
import { buildNlBtwReturn } from './btw-return';

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

function validateBtwNumber(value: string): TaxIdentifierValidation {
  const normalized = value.replace(/\s/g, '').toUpperCase();
  // Dutch BTW: NL + 9 digits + B + 2 digits
  if (!/^NL\d{9}B\d{2}$/.test(normalized)) {
    return { valid: false, error: 'Dutch BTW number must match format NL123456789B01' };
  }
  return { valid: true, formatted: normalized };
}

function validateKvk(value: string): TaxIdentifierValidation {
  const normalized = value.replace(/\s/g, '');
  if (!/^\d{8}$/.test(normalized)) {
    return { valid: false, error: 'KVK number must be 8 digits' };
  }
  return { valid: true, formatted: normalized };
}

export const nlAdapter: JurisdictionAdapter = {
  code: 'NL',
  name: 'Netherlands',
  defaultLocale: 'nl-NL',
  defaultCurrency: 'EUR',

  getChartOfAccountsTemplate() {
    return nlChartOfAccounts;
  },

  getStandardTaxCategories() {
    return nlTaxCategories;
  },

  validateTaxIdentifier(type: TaxIdentifierType, value: string): TaxIdentifierValidation {
    if (type === 'vatNumber') return validateBtwNumber(value);
    if (type === 'registrationNumber') return validateKvk(value);
    return { valid: true, formatted: value };
  },

  buildTaxReturn(entity, periodStart, periodEnd, lines) {
    return buildNlBtwReturn(entity, periodStart, periodEnd, lines);
  },

  getInvoiceRequirements(locale) {
    return getNlInvoiceRequirements(locale ?? 'nl-NL');
  },

  resolveTaxRate(ctx: TaxResolutionContext): TaxRateDecision {
    // KOR (kleineondernemersregeling): while opted in, NO VAT on any sale —
    // domestic, EU, or export — and no BTW-aangifte. Current rules (2025+):
    // €20k turnover cap, opt-out possible per quarter, NO 3-year lock-in.
    if (ctx.sellerSmallBusinessScheme) {
      return {
        taxCategoryCode: 'exempt',
        rate: '0.00',
        reasoning: 'KOR — vrijgesteld van BTW (art. 25 Wet OB)',
      };
    }

    const buyer = ctx.buyerCountry?.toUpperCase();

    if (!buyer || buyer === 'NL') {
      return { taxCategoryCode: 'standard', rate: '21.00', reasoning: 'Dutch domestic sale' };
    }

    if (EU_COUNTRIES.has(buyer)) {
      if (ctx.isB2B && ctx.buyerVatNumber) {
        return {
          taxCategoryCode: 'eu_b2b_service',
          rate: '0.00',
          reasoning: 'EU B2B with valid VAT number — reverse charge applies',
        };
      }
      return {
        taxCategoryCode: 'standard',
        rate: '21.00',
        reasoning: 'EU B2C — Dutch VAT applies (OSS not yet supported)',
      };
    }

    return {
      taxCategoryCode: 'export_goods',
      rate: '0.00',
      reasoning: 'Export outside EU — zero-rated',
    };
  },
};
