import type {
  JurisdictionAdapter,
  TaxIdentifierType,
  TaxIdentifierValidation,
  TaxRateDecision,
  TaxResolutionContext,
  TaxReturnArtifact,
  TaxReturnLine,
} from '../types';
import { brChartOfAccounts } from './chart-of-accounts';
import { validateCnpjOrCpf, validateInscricaoEstadual } from './identifiers';
import { getBrInvoiceRequirements } from './invoice-format';
import { brRegimeOf } from './regimes';
import { computeBrDocumentTaxes } from './tax-engine';
import { brTaxCategoriesFor } from './tax-profiles';

export * from './identifiers';
export * from './states';
export * from './regimes';
export * from './tax-profiles';
export * from './tax-engine';
export * from './invoice-format';
export * from './pix';
export * from './simples';
export * from './apuracao';
export * from './ecd';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * The tax-ledger summary of a period per tax and direction, as CSV. The full
 * monthly worksheet (DAS, IRPJ/CSLL, withholdings to pay) needs revenue and
 * payroll as well, so books-api builds it with `computeBrApuracao`.
 */
function buildBrTaxLedgerSummary(periodStart: string, periodEnd: string, lines: TaxReturnLine[]): TaxReturnArtifact {
  const totals = new Map<string, { taxable: number; tax: number }>();
  for (const line of lines) {
    const key = `${line.direction ?? 'sales'}:${line.component ?? line.taxCategoryCode}`;
    const t = totals.get(key) ?? { taxable: 0, tax: 0 };
    t.taxable += line.taxableAmount;
    t.tax += line.taxAmount;
    totals.set(key, t);
  }
  const summary: Record<string, number> = {};
  const rows = ['direcao;tributo;base;valor'];
  for (const [key, t] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [direction, component] = key.split(':');
    summary[`${key}:base`] = round2(t.taxable);
    summary[`${key}:valor`] = round2(t.tax);
    rows.push(`${direction};${component};${round2(t.taxable).toFixed(2)};${round2(t.tax).toFixed(2)}`);
  }
  return {
    filename: `apuracao-${periodStart}-${periodEnd}.csv`,
    mimeType: 'text/csv',
    content: rows.join('\r\n'),
    summary,
  };
}

export const brAdapter: JurisdictionAdapter = {
  code: 'BR',
  name: 'Brazil',
  defaultLocale: 'pt-BR',
  defaultCurrency: 'BRL',
  features: {
    vatReturn: false,
    icp: false,
    xafExport: false,
    smallBusinessScheme: false,
    gstReturn: false,
    salesTax: false,
    form1099: false,
    brTaxReturn: true,
    fiscalDocuments: true,
    spedEcd: true,
  },
  terminology: {
    tax: 'tributos',
    taxId: 'cnpj',
    registrationId: 'ie',
    supplier: 'supplier',
    creditNote: 'credit_note',
  },
  purchaseTax: 'recoverable',

  getChartOfAccountsTemplate() {
    return brChartOfAccounts;
  },

  getStandardTaxCategories(opts) {
    return brTaxCategoriesFor(brRegimeOf(opts?.taxClassification));
  },

  validateTaxIdentifier(type: TaxIdentifierType, value: string): TaxIdentifierValidation {
    if (type === 'vatNumber') return validateCnpjOrCpf(value);
    if (type === 'registrationNumber') return validateInscricaoEstadual(value);
    return { valid: true, formatted: value };
  },

  async buildTaxReturn(_entity, periodStart, periodEnd, lines) {
    return buildBrTaxLedgerSummary(periodStart, periodEnd, lines);
  },

  getInvoiceRequirements(locale) {
    return getBrInvoiceRequirements(locale ?? 'pt-BR');
  },

  resolveTaxRate(ctx: TaxResolutionContext): TaxRateDecision {
    const buyer = ctx.buyerCountry?.toUpperCase();
    if (buyer && buyer !== 'BR') {
      return { taxCategoryCode: 'export_goods', rate: '0.00', reasoning: 'Export: ICMS, IPI, PIS, COFINS and ISS do not apply' };
    }
    // The amounts come from the line's tax profile (computeDocumentTaxes); the rate column itself is 0.
    return { taxCategoryCode: 'standard', rate: '0.00', reasoning: 'Taxes worked out per line from the tax profile' };
  },

  computeDocumentTaxes(lines, ctx) {
    return computeBrDocumentTaxes(lines, ctx);
  },
};
