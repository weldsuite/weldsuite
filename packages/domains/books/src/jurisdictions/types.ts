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
  /** Code of the parent row (sub-accounts), e.g. a per-agency Sales Tax Payable child. */
  parentCode?: string;
  /** US: default income-tax line (see us/tax-lines.ts), stored on accounts.tax_line. */
  taxLine?: string;
  /** US: default 1099 box for payments booked here (nec_1, misc_1, ... or omit). */
  form1099Box?: string;
}

/** What the chart template may vary on (US: the equity section differs per entity type). */
export interface ChartOfAccountsTemplateOptions {
  /** entities.entity_type */
  entityType?: string | null;
  /** entities.tax_classification */
  taxClassification?: string | null;
}

export type SystemAccountRole =
  | 'accounts_receivable'
  | 'accounts_payable'
  | 'tax_output_standard'
  | 'tax_output_reduced'
  | 'tax_input'
  | 'tax_payable'
  | 'tax_output_cgst'
  | 'tax_output_sgst'
  | 'tax_output_igst'
  | 'tax_input_cgst'
  | 'tax_input_sgst'
  | 'tax_input_igst'
  | 'sales_revenue'
  | 'general_expense'
  | 'bad_debt_expense'
  | 'retained_earnings'
  | 'realized_fx_gain'
  | 'realized_fx_loss'
  | 'rounding'
  // US (and any jurisdiction that wants them)
  | 'undeposited_funds'
  | 'sales_tax_payable'
  | 'use_tax_payable'
  | 'owner_equity'
  | 'owner_draws'
  | 'opening_balance_equity'
  | 'credit_card_payable'
  | 'backup_withholding_payable'
  | 'sales_tax_vendor_discount'
  | 'tax_penalties_interest'
  | 'accumulated_depreciation'
  | 'depreciation_expense'
  | 'fixed_assets'
  | 'gain_loss_on_disposal'
  | 'payroll_wages_expense'
  | 'payroll_tax_expense'
  | 'payroll_liabilities'
  | 'unapplied_cash_payment_income'
  | 'unapplied_cash_bill_payment_expense';

/** GST component code used in India tax expansion (CGST/SGST/IGST). */
export type GstComponentCode = 'cgst' | 'sgst' | 'igst';

export interface GstTaxComponentTemplate {
  code: GstComponentCode;
  rate: string;
  accountRole: SystemAccountRole;
}

export interface GstSlabMetadata {
  gstSlab: string;
  components: {
    intrastate: GstTaxComponentTemplate[];
    interstate: GstTaxComponentTemplate[];
  };
}

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
  from: string;
  billTo: string;
  shipTo: string;
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

/** Entity identifiers an invoice can print. `einOrSsn` is the US tax ID (print it only when it is an EIN). */
export type InvoiceField = 'vatNumber' | 'registrationNumber' | 'einOrSsn' | 'iban' | 'bic';

export interface InvoiceRequirements {
  /** Format an entity-scoped sequence number (prefix + padded number). */
  formatInvoiceNumber(prefix: string, value: number, padding: number): string;
  /** Default padding for new number sequences in this jurisdiction. */
  defaultPadding: number;
  /** Legally required display fields on an invoice. */
  requiredFields: InvoiceField[];
  /** Fields printed when the entity has them although no law requires them (US: the EIN). */
  recommendedFields?: InvoiceField[];
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
  /** Seller's Indian state code (2-digit GST state, e.g. "27" for Maharashtra). */
  sellerStateCode?: string;
  /** Buyer's Indian state code for place-of-supply resolution. */
  buyerStateCode?: string;
  /** Buyer's GSTIN when known (state can also be derived from it). */
  buyerGstin?: string;
  /**
   * Preferred GST slab rate as a percentage string (e.g. "18.00").
   * When omitted, the adapter defaults to the standard slab (18%).
   */
  gstSlab?: string;
}

export interface TaxRateComponentDecision {
  taxCategoryCode: string;
  rate: string;
  component: GstComponentCode;
  accountRole: SystemAccountRole;
  jurisdictionMetadata?: Record<string, unknown>;
}

export interface TaxRateDecision {
  /** Generic category; the adapter's seeded rates should include one with this `taxCategoryCode`. */
  taxCategoryCode: string;
  /** Combined / slab rate (e.g. "18.00" for GST 18%, or "21.00" for NL BTW). */
  rate: string;
  reasoning: string;
  /**
   * When present (India GST), the line must post each component separately
   * (CGST+SGST or IGST). NL and other single-rate jurisdictions omit this.
   */
  components?: TaxRateComponentDecision[];
}

export interface TaxReturnLine {
  taxRateId: string;
  taxCategoryCode: string;
  taxableAmount: number;
  taxAmount: number;
  /** sales = charged to customers, purchase = paid or self-assessed. Rows from the tax ledger always carry it. */
  direction?: 'sales' | 'purchase';
  /** Purchase tax the buyer accounts for itself (reverse charge, imports). */
  selfAssessed?: boolean;
  jurisdictionMetadata?: Record<string, unknown>;

  // US sales tax detail, from the tax_lines columns of the same name.
  /** sales tax charged, or use tax accrued on purchases. */
  kind?: 'sales' | 'use';
  agencyId?: string | null;
  stateCode?: string | null;
  jurisdictionCode?: string | null;
  jurisdictionName?: string | null;
  jurisdictionLevel?: string | null;
  reportingCode?: string | null;
  rate?: number;
  grossAmount?: number;
  exemptAmount?: number;
  nonTaxableAmount?: number;
  exemptReason?: string | null;
  taxCode?: string | null;
  shipToState?: string | null;
  marketplaceFacilitated?: boolean;
  sourceType?: string;
  sourceId?: string | null;
  /** tax_lines.source_line_id: the rows of one document line share it, so its gross is counted once. */
  sourceLineId?: string | null;
  certificateId?: string | null;
  taxDate?: string;
}

export interface TaxReturnArtifact {
  filename: string;
  mimeType: string;
  content: string;
  /** Structured snapshot of what the content encodes — for UI display / audit. */
  summary: Record<string, number>;
}

/**
 * Which jurisdiction-specific modules an entity gets. Routes, navigation and
 * pages gate on these flags instead of comparing jurisdiction codes.
 */
export interface JurisdictionFeatures {
  /** Dutch BTW return (rubrieken), filed through Digipoort. */
  vatReturn: boolean;
  /** EU ICP listing of intra-community supplies. */
  icp: boolean;
  /** Dutch XAF audit file export. */
  xafExport: boolean;
  /** Small-business VAT exemption (NL KOR). */
  smallBusinessScheme: boolean;
  /** India GST return. */
  gstReturn: boolean;
  /** US sales tax: agencies, per-state returns. */
  salesTax: boolean;
  /** US 1099 information returns. */
  form1099: boolean;
}

/**
 * How tax a supplier charges on a purchase is accounted for.
 *
 * - `recoverable`: input VAT / GST, a receivable the buyer reclaims on its
 *   return (NL, IN). Bills post it to an input tax account.
 * - `cost`: sales tax the buyer can never reclaim (US). Bills post it into
 *   the line's expense or asset account; use tax the buyer accrues itself is
 *   the only purchase tax that reaches a return.
 */
export type PurchaseTaxTreatment = 'recoverable' | 'cost';

/**
 * Words that differ per jurisdiction, as codes the UI translates (en/nl/…):
 * a US user sees "Sales tax", "EIN", "Vendor" and "Credit memo" where a Dutch
 * user sees "BTW", "BTW-nummer", "Leverancier" and "Creditnota".
 */
export interface JurisdictionTerminology {
  tax: 'vat' | 'gst' | 'sales_tax';
  taxId: 'vat_number' | 'gstin' | 'ein';
  registrationId: 'kvk' | 'pan' | 'company_number' | 'state_id';
  supplier: 'supplier' | 'vendor';
  creditNote: 'credit_note' | 'credit_memo';
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
  readonly features: JurisdictionFeatures;
  readonly terminology: JurisdictionTerminology;
  /** Bills post supplier-charged tax as a receivable (`recoverable`) or into the cost (`cost`). */
  readonly purchaseTax: PurchaseTaxTreatment;

  getChartOfAccountsTemplate(opts?: ChartOfAccountsTemplateOptions): ChartOfAccountsTemplateRow[];

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
