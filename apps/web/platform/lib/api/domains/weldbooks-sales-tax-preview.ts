/**
 * WeldBooks document tax: the calculation preview the invoice, credit memo,
 * bill and recurring forms show, and the tax fields the document detail
 * endpoints return on top of `InvoiceDetail` / `BillDetail`.
 *
 * Nothing on the client calculates tax: the forms send their state to
 * `POST /api/sales-tax/calculate` (any jurisdiction: VAT / GST lines come back
 * with their rate, US sales tax with its jurisdictions) and show the answer.
 *
 * The document types of `weldbooks.ts` predate the US tax columns, so they
 * are extended here with intersection types instead of editing that file.
 */
import { weldbooksApi } from '../weldbooks-client';
import type { PostalAddress } from '@/components/address/postal-address';
import type { StoredAccountingAddress } from '@/lib/weldbooks/address';
import type { BillDetail, InvoiceDetail } from './weldbooks';

export type TaxDocumentKind = 'invoice' | 'estimate' | 'credit_memo' | 'bill';
export type TaxUse = 'business' | 'personal';
export type TaxJurisdictionLevel = 'state' | 'county' | 'city' | 'district';

// ============================================================================
// Preview
// ============================================================================

export interface TaxPreviewItem {
  description?: string;
  quantity?: string;
  unitPrice: string;
  discountPercent?: string;
  productId?: string | null;
  taxCode?: string | null;
  taxUse?: TaxUse | null;
  taxIncluded?: boolean;
  taxOverrideAmount?: string | null;
  taxOverrideReason?: string | null;
  /** Bills: accrue use tax on this line. */
  accrueUseTax?: boolean;
  /** Credit memos: the invoice line this one credits. */
  originalLineId?: string | null;
  /** VAT / GST rate of the line. */
  taxRateId?: string | null;
  /** US bills: the sales tax percentage the vendor charged. */
  taxRate?: string | null;
}

export interface TaxPreviewRequest {
  kind: TaxDocumentKind;
  contactId?: string | null;
  issueDate?: string;
  currency?: string;
  billingAddress?: PostalAddress | null;
  shippingAddress?: PostalAddress | null;
  shipFromAddress?: PostalAddress | null;
  /** Bills: where the goods were delivered (use tax). */
  deliveryAddress?: PostalAddress | null;
  marketplaceFacilitated?: boolean;
  originalInvoiceId?: string | null;
  items: TaxPreviewItem[];
}

export interface TaxPreviewLine {
  index: number;
  id: string;
  lineTotal: string;
  taxAmount: string;
  lineTotalWithTax: string;
  taxRate: string | null;
  taxRateId: string | null;
  taxCode: string | null;
}

/** The breakdown rows grouped per jurisdiction, for the totals block. */
export interface TaxPreviewJurisdiction {
  jurisdictionCode: string | null;
  jurisdictionName: string;
  level: TaxJurisdictionLevel | string;
  stateCode: string | null;
  agencyId: string | null;
  /** Percentage, e.g. 6.25. */
  rate: number;
  taxableAmount: number;
  taxAmount: number;
  kind: 'tax' | 'use' | string;
}

/** A row of a document's `taxBreakdown`: per VAT / GST rate, or per US jurisdiction and line. */
export interface TaxBreakdownRow {
  taxRateId?: string;
  taxRateName: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  component?: string;
  accountRole?: string;
  taxCategoryCode?: string;
  /** Use tax the buyer accrues itself: not owed to the vendor. */
  selfAssessed?: boolean;
  lineId?: string;
  jurisdictionCode?: string;
  jurisdictionName?: string;
  jurisdictionLevel?: TaxJurisdictionLevel;
  stateCode?: string;
  agencyId?: string;
  exemptAmount?: number;
  nonTaxableAmount?: number;
  exemptReason?: string;
  certificateId?: string;
  taxCode?: string;
  kind?: 'tax' | 'use';
}

export interface TaxPreviewResult {
  /** null for VAT / GST entities. */
  engine: string | null;
  engineRef: string | null;
  calculatedAt: string;
  /** Codes such as `not_registered_in_state`, `address_unverified`. */
  warnings: string[];
  shipToState: string | null;
  shipToPostalCode: string | null;
  /** A taxable sale with no ship-to (or bill-to) state and ZIP. */
  addressIncomplete: boolean;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  lines: TaxPreviewLine[];
  jurisdictions: TaxPreviewJurisdiction[];
  taxBreakdown: TaxBreakdownRow[];
}

/** Codes of the refusals the document routes answer with (`error.code`). */
export type SalesTaxErrorCode =
  | 'ADDRESS_REQUIRED'
  | 'TAX_ENGINE_UNAVAILABLE'
  | 'TAX_RATES_NOT_CONFIGURED'
  | 'USE_TAX_ENGINE_UNSUPPORTED'
  | 'CREDIT_LINE_NOT_ON_ORIGINAL'
  | 'TAX_NOT_CALCULATED'
  | 'TAX_COMMIT_NOT_APPLICABLE';

const SALES_TAX_ERROR_CODES: readonly string[] = [
  'ADDRESS_REQUIRED',
  'TAX_ENGINE_UNAVAILABLE',
  'TAX_RATES_NOT_CONFIGURED',
  'USE_TAX_ENGINE_UNSUPPORTED',
  'CREDIT_LINE_NOT_ON_ORIGINAL',
  'TAX_NOT_CALCULATED',
  'TAX_COMMIT_NOT_APPLICABLE',
];

/** The sales tax code of a failed request (`ADDRESS_REQUIRED`, ...), or null for any other failure. */
export function salesTaxErrorCode(err: unknown): SalesTaxErrorCode | null {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : null;
  return typeof code === 'string' && SALES_TAX_ERROR_CODES.includes(code) ? (code as SalesTaxErrorCode) : null;
}

// ============================================================================
// Provider sync
// ============================================================================

export type TaxSyncStatus = 'committed' | 'reversed' | 'already_synced' | 'not_applicable' | 'failed';

export interface TaxSyncResult {
  status: TaxSyncStatus;
  /** The provider's transaction reference after a successful sync. */
  ref?: string;
  warning?: string;
}

// ============================================================================
// Document extensions
// ============================================================================

/** Sales tax columns of an invoice or credit memo. */
export interface InvoiceTaxFields {
  type: string;
  creditNoteForInvoiceId?: string | null;
  shipFromAddress?: StoredAccountingAddress | null;
  marketplaceFacilitated?: boolean | null;
  taxEngine?: string | null;
  taxEngineRef?: string | null;
  taxCalculatedAt?: string | null;
  taxCommittedAt?: string | null;
  taxWarnings?: string[] | null;
  taxBreakdown?: TaxBreakdownRow[] | null;
}

export interface InvoiceItemTaxFields {
  productId?: string | null;
  taxCode?: string | null;
  taxUse?: TaxUse | null;
  taxIncluded?: boolean | null;
  taxOverrideAmount?: string | null;
  taxOverrideReason?: string | null;
  classId?: string | null;
  locationId?: string | null;
  /** Credit memos: the invoice line the line credits. */
  originalLineId?: string | null;
}

type InvoiceItemRow = InvoiceDetail['items'][number];

export type InvoiceWithTax = Omit<InvoiceDetail, 'items' | 'taxBreakdown'> &
  InvoiceTaxFields & { items: Array<InvoiceItemRow & InvoiceItemTaxFields> };

export interface BillItemTaxFields {
  productId?: string | null;
  taxCode?: string | null;
  accrueUseTax?: boolean | null;
  form1099Box?: string | null;
  classId?: string | null;
  locationId?: string | null;
}

type BillItemRow = BillDetail['items'][number];

export interface BillTaxFields {
  deliveryAddress?: StoredAccountingAddress | null;
  taxBreakdown?: TaxBreakdownRow[] | null;
}

export type BillWithTax = Omit<BillDetail, 'items'> & BillTaxFields & { items: Array<BillItemRow & BillItemTaxFields> };

/** A line of a recurring invoice template (`recurring_invoices.template_data.items`). */
export interface RecurringTemplateTaxItem {
  description: string;
  quantity: number;
  unitPrice: number;
  unit?: string;
  taxRateId?: string | null;
  accountId?: string | null;
  productId?: string | null;
  taxCode?: string | null;
  taxUse?: TaxUse | null;
  taxIncluded?: boolean;
  classId?: string | null;
  locationId?: string | null;
}

/** What `POST /recurring-invoices/:id/generate` returns, with the new finalize outcome. */
export interface GeneratedRecurringInvoice {
  invoiceId: string;
  invoiceNumber: string;
  nextIssueDate: string;
  status: string;
  journalEntryId: string | null;
  /** autoFinalize was on but posting failed (e.g. the tax engine was down): the invoice stays a draft. */
  finalizeError: string | null;
}

/** A customer's exemption certificate, as far as an invoice needs it. */
export interface ExemptionCertificateSummary {
  id: string;
  certificateNumber: string | null;
  reason: string;
  states: string[];
}

// ============================================================================
// Calls
// ============================================================================

export const salesTaxPreviewApi = {
  /** The tax of a draft document, as the server would post it. Nothing is saved. */
  calculate: (body: TaxPreviewRequest) =>
    weldbooksApi.post<{ data: TaxPreviewResult }>('/sales-tax/calculate', body),
  /** Retry recording a finalized invoice (or a credit memo's reversal) with the provider engine. */
  commitInvoiceTax: (invoiceId: string) =>
    weldbooksApi.post<{ data: TaxSyncResult }>(`/invoices/${invoiceId}/commit-tax`),
  getExemptionCertificate: (id: string) =>
    weldbooksApi.get<{ data: ExemptionCertificateSummary }>(`/exemption-certificates/${id}`),
};
