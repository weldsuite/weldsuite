import type { Entity, TaxCategoryCode } from '@weldsuite/db/schema';

/**
 * A chart-of-accounts row seeded at entity creation.
 * The jurisdiction adapter provides a localized, country-appropriate template.
 */
export interface ChartOfAccountsTemplateRow {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype?: string;
  normalSide: 'debit' | 'credit';
  isSystemAccount?: boolean;
  /** Semantic role so services can look up accounts by purpose rather than hardcoded code. */
  systemRole?: SystemAccountRole;
}

export type SystemAccountRole =
  | 'accounts_receivable'
  | 'accounts_payable'
  | 'tax_output_standard'
  | 'tax_output_reduced'
  | 'tax_input'
  | 'tax_payable'
  | 'sales_revenue'
  | 'retained_earnings'
  | 'realized_fx_gain'
  | 'realized_fx_loss'
  | 'rounding';

/**
 * A tax rate seeded at entity creation. Jurisdiction-specific codes
 * (Dutch btwRubriek, German Umsatzsteuer box, etc.) go in `jurisdictionMetadata`.
 */
export interface TaxCategoryTemplate {
  name: string;
  rate: string;
  type: 'sales' | 'purchase' | 'both';
  taxCategoryCode: TaxCategoryCode;
  isDefault?: boolean;
  jurisdictionMetadata?: Record<string, unknown>;
}

export interface InvoiceLabels {
  invoice: string;
  creditNote: string;
  invoiceNumber: string;
  date: string;
  dueDate: string;
  billTo: string;
  description: string;
  quantity: string;
  unitPrice: string;
  tax: string;
  amount: string;
  subtotal: string;
  discount: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  paymentInstructions: string;
  vatNumberLabel: string;
  registrationLabel: string;
}

export interface InvoiceRequirements {
  /** Format an entity-scoped sequence number (prefix + padded number). */
  formatInvoiceNumber(prefix: string, value: number, padding: number): string;
  /** Default padding for new number sequences in this jurisdiction. */
  defaultPadding: number;
  /** Legally required display fields on an invoice. */
  requiredFields: Array<'vatNumber' | 'registrationNumber' | 'iban' | 'bic'>;
  /** Free-form legally required text to append to the invoice. */
  requiredFooter?: string;
  /** Translated labels for invoice rendering. */
  labels: InvoiceLabels;
}

export type TaxIdentifierType = 'vatNumber' | 'registrationNumber' | 'einOrSsn';

export interface TaxIdentifierValidation {
  valid: boolean;
  formatted?: string;
  error?: string;
}

export interface TaxResolutionContext {
  buyerCountry?: string;
  buyerVatNumber?: string;
  isB2B: boolean;
  productType?: 'goods' | 'service' | 'digital_service';
  /**
   * Seller participates in a small-business VAT exemption scheme
   * (NL: KOR). No VAT is charged on any sale and no input VAT is
   * deductible while active.
   */
  sellerSmallBusinessScheme?: boolean;
}

export interface TaxRateDecision {
  /** Generic category; the adapter's seeded rates should include one with this `taxCategoryCode`. */
  taxCategoryCode: string;
  rate: string;
  reasoning: string;
}

export interface TaxReturnLine {
  taxRateId: string;
  taxCategoryCode: string;
  taxableAmount: number;
  taxAmount: number;
  jurisdictionMetadata?: Record<string, unknown>;
}

export interface TaxReturnArtifact {
  filename: string;
  mimeType: string;
  content: string;
  /** Structured snapshot of what the content encodes — for UI display / audit. */
  summary: Record<string, number>;
}

/**
 * Contract every jurisdiction adapter must implement. Registered in `registry.ts`.
 *
 * Add a new jurisdiction by:
 *   1. creating `jurisdictions/<code>/` with an `index.ts` default export satisfying this interface
 *   2. registering it in `jurisdictions/registry.ts`
 */
export interface JurisdictionAdapter {
  readonly code: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly defaultCurrency: string;

  getChartOfAccountsTemplate(): ChartOfAccountsTemplateRow[];

  getStandardTaxCategories(): TaxCategoryTemplate[];

  validateTaxIdentifier(type: TaxIdentifierType, value: string): TaxIdentifierValidation;

  buildTaxReturn(
    entity: Entity,
    periodStart: string,
    periodEnd: string,
    lines: TaxReturnLine[],
  ): Promise<TaxReturnArtifact>;

  getInvoiceRequirements(locale?: string): InvoiceRequirements;

  resolveTaxRate(ctx: TaxResolutionContext): TaxRateDecision;
}
