/**
 * WeldBooks US Sales Tax Center client: per-agency return periods and due
 * dates, the return worksheet and its flow (calculate, adjust, review, pre-file
 * and liability checks, file, payment, exceptions, amendments, export), the
 * sales tax reports, the certificate reports, the provider reconciliation and
 * the economic nexus monitor. Talks to books-api through the same
 * `weldbooksApi` transport as `accountingApi`; shapes mirror
 * `apps/workers/books-api/src/routes/tax-returns`, `routes/sales-tax/{reports,nexus}`
 * and `services/sales-tax-returns/*`.
 *
 * Money is a number of dollars here (the server sends numbers, not strings).
 * Dates are `YYYY-MM-DD`; instants are ISO timestamps.
 */
import { weldbooksApi } from '../weldbooks-client';

// ============================================================================
// Envelopes and helpers
// ============================================================================

interface Envelope<T> {
  data: T;
}

export interface CursorPage<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

/** What a failed call carries: the status, the error code and the `details` of the error body. */
export interface SalesTaxRequestError extends Error {
  status: number;
  body: unknown;
  code: string | null;
}

export function isSalesTaxRequestError(err: unknown): err is SalesTaxRequestError {
  return err instanceof Error && typeof (err as { status?: unknown }).status === 'number';
}

/** The `details` object of an error response, when it carries one. */
export function salesTaxErrorDetails(err: unknown): Record<string, unknown> | null {
  if (!isSalesTaxRequestError(err)) return null;
  const body = err.body as { error?: { details?: unknown } } | null;
  const details = body?.error?.details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
}

// ============================================================================
// Vocabulary
// ============================================================================

export const PERIOD_STATES = ['upcoming', 'in_progress', 'due', 'overdue', 'filed', 'paid'] as const;
export type PeriodState = (typeof PERIOD_STATES)[number];

export const RETURN_STATUSES = ['open', 'calculated', 'reviewed', 'filed', 'paid'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** Returns that are filed (and maybe paid): their worksheet and adjustments are frozen. */
export const FILED_RETURN_STATUSES: readonly string[] = ['filed', 'paid'];
/** Returns that can still change. */
export const EDITABLE_RETURN_STATUSES: readonly string[] = ['open', 'calculated', 'reviewed'];

export const ADJUSTMENT_TYPES = ['vendor_discount', 'prepayment', 'penalty', 'interest', 'rounding', 'other'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

export const DEDUCTION_KEYS = [
  'resale',
  'nonprofit',
  'government',
  'manufacturing',
  'agricultural',
  'other_exempt',
  'non_taxable',
  'exempt_freight',
  'marketplace',
  'returns',
  'bad_debts',
] as const;
export type DeductionKey = (typeof DEDUCTION_KEYS)[number];

export type FilingFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export type ReportingBasis = 'accrual' | 'cash';

// ============================================================================
// Periods and overview
// ============================================================================

export interface PeriodReturnSummary {
  id: string;
  status: ReturnStatus | string;
  totalDue: number;
  filedAt: string | null;
  paidAt: string | null;
  confirmationNumber: string | null;
}

export interface PeriodRow {
  /** Tax calendar key of the deadline (`sales_tax:<agencyId>:<periodEnd>`). */
  key: string;
  agencyId: string;
  agencyName: string;
  stateCode: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  /** The statutory due day before it moves to a business day. */
  nominalDueDate: string;
  /** The period's own return (not an amendment), if one was created. */
  return: PeriodReturnSummary | null;
  /** Returns amending it, newest first. */
  amendments: PeriodReturnSummary[];
  state: PeriodState;
  /** The period has ended and no return is filed for it. */
  unfiled: boolean;
  /** Unfiled and past its due date. */
  overdue: boolean;
  /** Days until the due date (negative once past). */
  daysUntilDue: number;
}

export interface AgencyPeriods {
  agencyId: string;
  agencyName: string;
  stateCode: string;
  status: string;
  filingFrequency: FilingFrequency | string;
  dueDay: number;
  reportingBasis: ReportingBasis | string;
  periods: PeriodRow[];
}

export interface PeriodsResponse {
  today: string;
  from: string;
  to: string;
  agencies: AgencyPeriods[];
}

export interface PeriodsFilter {
  agencyId?: string;
  from?: string;
  to?: string;
}

export interface AgencyNextPeriod {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  daysUntilDue: number;
  overdue: boolean;
  state: PeriodState;
  returnId: string | null;
  returnStatus: ReturnStatus | string | null;
  /** Tax of the period's ledger rows no return counted yet (sales tax + use tax). */
  estimatedTaxDue: number;
  estimatedSalesTax: number;
  estimatedUseTax: number;
}

export interface AgencyLastFiled {
  returnId: string;
  periodEnd: string;
  filedAt: string | null;
  totalDue: number;
  status: ReturnStatus | string;
}

export interface AgencyOverview {
  agencyId: string;
  agencyName: string;
  stateCode: string;
  filingFrequency: FilingFrequency | string;
  reportingBasis: ReportingBasis | string;
  nextPeriod: AgencyNextPeriod | null;
  /** Periods that ended with no filed return and are past their due date. */
  overduePeriods: number;
  lastFiled: AgencyLastFiled | null;
}

export interface SalesTaxOverview {
  today: string;
  agencies: AgencyOverview[];
  totals: { estimatedTaxDue: number; overduePeriods: number; dueWithin14Days: number };
}

// ============================================================================
// Returns
// ============================================================================

export interface WorksheetLocation {
  jurisdictionCode: string;
  jurisdictionName: string;
  level: string;
  reportingCode: string;
  /** Percent. */
  rate: number;
  taxableSales: number;
  tax: number;
}

/** A stored `lines` entry: a worksheet location tagged sales or use. */
export interface ReturnLine extends WorksheetLocation {
  kind: 'sales' | 'use';
}

export interface VendorDiscountProposal {
  /** The state has a vendor discount rule. */
  available: boolean;
  /** Dollars the discount would be on the sales tax of the worksheet (positive). */
  amount: number;
  /** The discount only holds when the return is filed and paid by this date. */
  requiresTimelyFilingBy: string | null;
  /** Today is already past the due date: not proposed. */
  late: boolean;
  note: string | null;
}

export interface ReturnSummary {
  reportingBasis: ReportingBasis;
  method: string;
  grossSales: number;
  deductions: Record<DeductionKey, number>;
  totalDeductions: number;
  taxableSales: number;
  salesTaxDue: number;
  useTaxDue: number;
  totalTaxDue: number;
  documentCount: number;
  rowCount: number;
  uncuredExempt: { sales: number; tax: number; lines: number };
  /** Paid by this return (the whole tax due, or the increase over the return it amends). */
  salesTaxPayable: number;
  useTaxPayable: number;
  uncuredTaxPayable: number;
  carriedForward?: { returnIds: string[]; rowCount: number; taxAmount: number };
  previouslyReported?: { returnId: string; salesTaxDue: number; useTaxDue: number; uncuredTax: number };
  vendorDiscount: VendorDiscountProposal;
  warnings: string[];
  calculatedAt: string;
  foreignCurrencyRows: number;
  /** Set once the return is paid. */
  payment?: {
    date: string;
    amount: number;
    reference: string | null;
    difference: number;
    differenceReason: string | null;
    liabilityDebit: number;
    taxSettled: number;
    bankAccountId: string;
    journalEntryId: string | null;
  };
}

/** A return adjustment as stored: a positive amount increases the payment, a negative one reduces it. */
export interface ReturnAdjustment {
  type: AdjustmentType;
  amount: number;
  note?: string;
  /** `other` adjustments: the ledger account they post to (default: the agency's sales tax payable). */
  accountId?: string;
  /** A proposal the calculation may refresh (the vendor discount). */
  auto?: boolean;
}

export interface TaxReturn {
  id: string;
  createdAt: string;
  updatedAt: string;
  entityId: string;
  jurisdictionCode: string;
  agencyId: string | null;
  stateCode: string | null;
  periodStart: string;
  periodEnd: string;
  dueDate: string | null;
  status: ReturnStatus | string;
  reportingBasis: ReportingBasis | string;
  /** Null until the first calculation. */
  summary: ReturnSummary | null;
  lines: ReturnLine[] | null;
  adjustments: ReturnAdjustment[] | null;
  exceptions: Array<Record<string, unknown>> | null;
  totalDue: number;
  filedAt: string | null;
  filedBy: string | null;
  confirmationNumber: string | null;
  paidAt: string | null;
  paymentAmount: number | null;
  paymentBankAccountId: string | null;
  paymentJournalEntryId: string | null;
  amendsReturnId: string | null;
  notes: string | null;
}

export interface TaxReturnAgency {
  id: string;
  name: string;
  stateCode: string;
  filingFrequency: FilingFrequency | string;
  dueDay: number;
  reportingBasis: ReportingBasis | string;
  registrationNumber: string | null;
  portalUrl: string | null;
}

export interface TaxReturnDetail extends TaxReturn {
  agency: TaxReturnAgency;
  amendments: Array<{ id: string; status: ReturnStatus | string; filedAt: string | null }>;
  /** Not filed and past its due date. */
  overdue: boolean;
}

export interface ReturnsFilter {
  agencyId?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface CreateReturnInput {
  agencyId: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface UpdateReturnInput {
  adjustments?: ReturnAdjustment[];
  notes?: string | null;
}

// -- Documents behind a return ----------------------------------------------

export interface DocumentInfo {
  /** `invoice`, `credit_note`, `bill`, `bill_credit_note`, `journal_entry`, or a raw source type. */
  type: string;
  id: string | null;
  number: string | null;
  contactId: string | null;
  contactName: string | null;
  date: string | null;
  status: string | null;
  currency: string | null;
  description: string | null;
}

export interface DocumentRowDetail {
  taxLineId: string;
  sourceLineId: string | null;
  kind: 'sales' | 'use';
  jurisdictionCode: string | null;
  jurisdictionName: string | null;
  jurisdictionLevel: string | null;
  reportingCode: string | null;
  rate: number;
  grossAmount: number;
  taxableAmount: number;
  exemptAmount: number;
  nonTaxableAmount: number;
  taxAmount: number;
  exemptReason: string | null;
  certificateId: string | null;
  taxCode: string | null;
  shipToState: string | null;
  marketplaceFacilitated: boolean;
  /** Share of the row counted (cash basis). */
  share: number;
  carried: boolean;
}

export interface CertificateRef {
  id: string;
  certificateNumber: string | null;
  reason: string;
  states: string[];
  expiresOn: string | null;
  status: string;
}

export interface ReturnDocument {
  key: string;
  document: DocumentInfo;
  taxDate: string;
  grossSales: number;
  taxableSales: number;
  exemptSales: number;
  nonTaxableSales: number;
  tax: number;
  useTax: number;
  carried: boolean;
  certificateIds: string[];
  certificates: CertificateRef[];
  rows: DocumentRowDetail[];
}

// -- Pre-file and liability checks -------------------------------------------

export type PreFileFindingCode =
  | 'net_sales_difference'
  | 'income_without_tax_data'
  | 'missing_ship_to'
  | 'payable_direct_entries';

export interface FindingDocument {
  documentType: 'invoice' | 'credit_note' | 'journal_entry';
  documentId: string;
  number: string | null;
  date: string;
  contactName: string | null;
  /** Income posted (invoice lines, or the journal entry's revenue). */
  amount: number;
  /** Gross sales the return counts for it. */
  returnAmount?: number;
  reason: string;
}

export interface PreFileFinding {
  code: PreFileFindingCode;
  severity: 'error' | 'warning';
  message: string;
  count: number;
  amount: number;
  documents: FindingDocument[];
  /** More documents than `documents` lists. */
  truncated: boolean;
}

export interface PreFileCheck {
  returnId: string;
  agencyId: string;
  stateCode: string;
  periodStart: string;
  periodEnd: string;
  comparison: { returnNetSales: number; incomeShippedToState: number; difference: number } | null;
  /** `<code>: <reason>` lines for the checks that did not run. */
  skipped: string[];
  findings: PreFileFinding[];
  ok: boolean;
}

export interface LiabilityItem {
  journalEntryId: string;
  entryNumber: string | null;
  date: string;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Credit minus debit on the agency's payable accounts. */
  glAmount: number;
  /** What the tax ledger (and a paid return) explains. */
  expectedAmount: number;
  difference: number;
}

export interface LiabilityCheck {
  returnId: string;
  agencyId: string;
  asOf: string;
  accounts: Array<{ id: string; code: string; name: string }>;
  /** The agency has no payable account of its own; the shared account holds other agencies' tax too. */
  sharedAccount: boolean;
  glBalance: number;
  collectedTax: number;
  paidTax: number;
  filedUnpaidTax: number;
  unfiledTax: number;
  expectedBalance: number;
  difference: number;
  items: LiabilityItem[];
  warnings: string[];
}

// -- Filing, payment, exceptions ----------------------------------------------

export interface FileWarning {
  code: 'late_filing' | 'vendor_discount_late' | 'earlier_period_unfiled' | string;
  message: string;
}

export interface FileReturnInput {
  confirmationNumber: string;
  /** `YYYY-MM-DD` or an ISO timestamp. */
  filedAt?: string;
}

export interface FileReturnResult extends TaxReturn {
  warnings: FileWarning[];
}

export interface PaymentInput {
  bankAccountId: string;
  amount: number;
  date: string;
  reference?: string;
  differenceReason?: string;
}

export interface PaymentResult extends TaxReturn {
  payment: {
    journalEntryId: string | null;
    totalDue: number;
    difference: number;
    lines: Array<{ accountId: string; debit: number; credit: number; description: string | null }>;
  };
}

export type ExceptionResolution = 'open' | 'carried_forward' | 'amended';

export interface ExceptionItem {
  key: string;
  document: { type: string; id: string | null; number: string | null; contactName: string | null; date: string | null };
  taxDate: string;
  postedAt: string;
  taxLineIds: string[];
  grossAmount: number;
  taxableAmount: number;
  taxAmount: number;
  resolution: ExceptionResolution | 'partial';
  amendedByReturnId: string | null;
  /** The return that counted a carried-forward row, once it was filed. */
  countedByReturnId: string | null;
}

export interface LatePayment {
  invoiceId: string;
  invoiceNumber: string | null;
  contactName: string | null;
  amount: number;
}

export interface ReturnExceptions {
  returnId: string;
  /** False until the return is filed. */
  applicable: boolean;
  items: ExceptionItem[];
  /** Cash basis: payments dated in the period but recorded after filing. */
  latePayments: LatePayment[];
  totals: Record<ExceptionResolution, { documents: number; taxAmount: number }>;
}

export interface CarryForwardResult extends TaxReturn {
  carriedRows: number;
  taxAmount: number;
  /** Later returns of the agency that are still open: recalculate them to pick the rows up. */
  recalculate: Array<{ id: string; status: string; periodEnd: string }>;
}

export interface AmendResult extends TaxReturn {
  exceptionRows: number;
}

// ============================================================================
// Reports
// ============================================================================

export interface LiabilityJurisdiction {
  jurisdictionCode: string;
  jurisdictionName: string;
  level: string;
  collected: number;
  filed: number;
  paid: number;
  outstanding: number;
}

export interface AgencyLiabilityRow {
  agencyId: string;
  agencyName: string;
  stateCode: string;
  status: string;
  collected: number;
  filed: number;
  paid: number;
  outstanding: number;
  unfiled: number;
  filedUnpaid: number;
  glBalance: number;
  /** glBalance - outstanding; zero when the ledger ties to the tax ledger. */
  difference: number;
  jurisdictions: LiabilityJurisdiction[];
  warnings: string[];
}

export interface LiabilityReport {
  asOf: string;
  agencies: AgencyLiabilityRow[];
  totals: { collected: number; filed: number; paid: number; outstanding: number; glBalance: number; difference: number };
}

export const SALES_SUMMARY_GROUPS = ['state', 'customer', 'jurisdiction'] as const;
export type SalesSummaryGroup = (typeof SALES_SUMMARY_GROUPS)[number];

export interface SalesSummaryRow {
  key: string;
  label: string;
  /** Jurisdiction level for `jurisdiction` rows. */
  level?: string;
  grossSales: number;
  taxableSales: number;
  exemptSales: number;
  exemptByReason: Record<string, number>;
  nonTaxableSales: number;
  marketplaceSales: number;
  tax: number;
  documents: number;
}

export interface SalesSummary {
  from: string;
  to: string;
  groupBy: SalesSummaryGroup;
  rows: SalesSummaryRow[];
  totals: Omit<SalesSummaryRow, 'key' | 'label' | 'level'>;
}

export const EXCEPTION_KINDS = [
  'no_ship_to_state',
  'tax_in_unregistered_state',
  'taxable_without_tax',
  'marketplace_sale',
  'tax_override',
  'provider_commit_failure',
  'tax_warning',
] as const;
export type SalesTaxExceptionKind = (typeof EXCEPTION_KINDS)[number];

export interface SalesTaxException {
  kind: SalesTaxExceptionKind;
  severity: 'error' | 'warning' | 'info';
  documentType: string;
  documentId: string | null;
  documentNumber: string | null;
  date: string | null;
  contactName: string | null;
  stateCode: string | null;
  amount: number | null;
  taxAmount: number | null;
  message: string;
}

export interface SalesTaxExceptionsReport {
  from: string;
  to: string;
  counts: Record<SalesTaxExceptionKind, number>;
  exceptions: SalesTaxException[];
}

export interface ExpiringCertificate {
  certificateId: string;
  partyId: string;
  customerName: string | null;
  certificateNumber: string | null;
  reason: string;
  form: string;
  blanket: boolean;
  states: string[];
  status: string;
  /** The earliest date the certificate stops covering one of its states. */
  expiresOn: string;
  expiryByState: Array<{ stateCode: string; expiresOn: string | null }>;
  daysLeft: number;
  expired: boolean;
  lastUsedOn: string | null;
}

export interface ExpiringCertificates {
  asOf: string;
  days: number;
  certificates: ExpiringCertificate[];
}

export interface MissingCertificate {
  documentType: string;
  documentId: string | null;
  documentNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  stateCode: string | null;
  saleDate: string;
  exemptSales: number;
  exemptReason: string | null;
  /** Streamlined Sales Tax: a complete certificate within 90 days of the sale protects the seller. */
  cureDeadline: string;
  pastDeadline: boolean;
  /** Days left to the deadline (negative once past). */
  daysLeft: number;
}

export interface MissingCertificates {
  asOf: string;
  certificates: MissingCertificate[];
  totals: { documents: number; exemptSales: number; pastDeadline: number };
}

export type ReconciliationStatus = 'ok' | 'missing_commit' | 'not_committed' | 'commit_failed' | 'ledger_mismatch' | 'no_ledger';

export interface ReconciliationDocument {
  documentType: string;
  documentId: string;
  documentNumber: string | null;
  date: string;
  engine: string | null;
  engineRef: string | null;
  committedAt: string | null;
  providerTax: number;
  ledgerTax: number;
  difference: number;
  status: ReconciliationStatus;
  severity: 'ok' | 'info' | 'error';
  message: string | null;
}

export interface ReconciliationPeriod {
  /** `YYYY-MM`. */
  period: string;
  documents: number;
  committed: number;
  uncommitted: number;
  providerTax: number;
  ledgerTax: number;
  difference: number;
  problems: number;
}

export interface ProviderReconciliation {
  engine: string;
  applicable: boolean;
  from: string;
  to: string;
  periods: ReconciliationPeriod[];
  documents: ReconciliationDocument[];
  notes: string[];
}

// ============================================================================
// Nexus
// ============================================================================

export type NexusStatus = 'below' | 'approaching' | 'exceeded';
export type NexusAlert = 'register' | 'watch' | 'registered' | 'ok';
export type NexusUnverified = 'marketplace' | 'collection_start' | 'window' | 'base' | 'effective_date' | 'transaction_test';
export type NexusTransactionTest = 'none' | 'or' | 'and';
export type NexusBase = 'gross' | 'retail' | 'taxable';
export type NexusWindow =
  | 'previous_or_current_calendar_year'
  | 'previous_calendar_year'
  | 'rolling_12_months'
  | 'rolling_four_quarters'
  | 'ct_october_september';

export interface NexusPeriod {
  /** `binding` periods decide the status; a `look_ahead` period is in progress and only warns. */
  role: 'binding' | 'look_ahead';
  label: string;
  from: string;
  to: string;
  salesTotal: number;
  transactionCount: number;
  percentOfThreshold: number;
  exceeded: boolean;
  exceededOn?: string;
}

export interface NexusRow {
  stateCode: string;
  stateName: string;
  applicable: boolean;
  ruleEffectiveFrom: string;
  salesTotal: number;
  transactionCount: number;
  thresholdSales: number | null;
  thresholdTransactions: number | null;
  /** 0 or more; 100 means the threshold is reached. */
  percentOfThreshold: number;
  status: NexusStatus;
  exceededOn?: string;
  collectFrom?: string;
  collectFromVerified: boolean;
  window: { from: string; to: string };
  periods: NexusPeriod[];
  pending?: { exceededOn: string; testDate: string; collectFrom: string };
  unverified: NexusUnverified[];
  registered: boolean;
  alert: NexusAlert;
  agencyId: string | null;
  agencyStatus: string | null;
  base: NexusBase;
  comparison: 'gte' | 'gt';
  test: NexusTransactionTest;
  sourceUrl: string;
  ruleNotes: string | null;
}

export interface NexusOverview {
  asOf: string;
  rows: NexusRow[];
  summary: { exceededUnregistered: number; approaching: number; exceededRegistered: number; monitored: number };
}

export interface NexusMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Sales of the rule's base (negative with credit memos). */
  sales: number;
  gross: number;
  taxable: number;
  transactions: number;
  marketplaceSales: number;
}

export interface NexusDetail extends NexusRow {
  rule: {
    effectiveFrom: string;
    salesThreshold: number | null;
    transactionThreshold: number | null;
    test: NexusTransactionTest;
    comparison: 'gte' | 'gt';
    base: NexusBase;
    window: NexusWindow;
    marketplaceSalesCount: boolean;
  };
  monthly: NexusMonth[];
}

// ============================================================================
// API
// ============================================================================

const RETURNS = '/tax-returns';
const REPORTS = '/sales-tax/reports';
const NEXUS = '/sales-tax/nexus';

export const salesTaxCenterApi = {
  // -- Periods and overview ---------------------------------------------------
  getPeriods: async (filter: PeriodsFilter = {}) =>
    (await weldbooksApi.get<Envelope<PeriodsResponse>>(`${RETURNS}/periods${buildQuery({ ...filter })}`)).data,
  getOverview: async () => (await weldbooksApi.get<Envelope<SalesTaxOverview>>(`${RETURNS}/overview`)).data,

  // -- Returns -----------------------------------------------------------------
  listReturns: (filter: ReturnsFilter = {}) =>
    weldbooksApi.get<CursorPage<TaxReturn>>(`${RETURNS}${buildQuery({ ...filter })}`),
  createReturn: async (input: CreateReturnInput) => (await weldbooksApi.post<Envelope<TaxReturn>>(RETURNS, input)).data,
  getReturn: async (id: string) => (await weldbooksApi.get<Envelope<TaxReturnDetail>>(`${RETURNS}/${id}`)).data,
  updateReturn: async (id: string, input: UpdateReturnInput) =>
    (await weldbooksApi.patch<Envelope<TaxReturn>>(`${RETURNS}/${id}`, input)).data,
  deleteReturn: (id: string) => weldbooksApi.delete<void>(`${RETURNS}/${id}`),
  calculateReturn: async (id: string) => (await weldbooksApi.post<Envelope<TaxReturn>>(`${RETURNS}/${id}/calculate`)).data,
  reviewReturn: async (id: string) => (await weldbooksApi.post<Envelope<TaxReturn>>(`${RETURNS}/${id}/review`)).data,
  listReturnDocuments: (id: string, cursor?: string, limit = 100) =>
    weldbooksApi.get<CursorPage<ReturnDocument>>(`${RETURNS}/${id}/documents${buildQuery({ cursor, limit })}`),
  getPreFileCheck: async (id: string) => (await weldbooksApi.get<Envelope<PreFileCheck>>(`${RETURNS}/${id}/pre-file-check`)).data,
  getLiabilityCheck: async (id: string) =>
    (await weldbooksApi.get<Envelope<LiabilityCheck>>(`${RETURNS}/${id}/liability-check`)).data,
  getExceptions: async (id: string) => (await weldbooksApi.get<Envelope<ReturnExceptions>>(`${RETURNS}/${id}/exceptions`)).data,
  exportReturn: (id: string) => weldbooksApi.getBlob(`${RETURNS}/${id}/export?format=csv`),
  fileReturn: async (id: string, input: FileReturnInput) =>
    (await weldbooksApi.post<Envelope<FileReturnResult>>(`${RETURNS}/${id}/file`, input)).data,
  payReturn: async (id: string, input: PaymentInput) =>
    (await weldbooksApi.post<Envelope<PaymentResult>>(`${RETURNS}/${id}/payment`, input)).data,
  amendReturn: async (id: string) => (await weldbooksApi.post<Envelope<AmendResult>>(`${RETURNS}/${id}/amend`)).data,
  carryForward: async (id: string, taxLineIds?: string[]) =>
    (await weldbooksApi.post<Envelope<CarryForwardResult>>(`${RETURNS}/${id}/carry-forward`, taxLineIds ? { taxLineIds } : {})).data,

  // -- Reports ------------------------------------------------------------------
  getLiabilityReport: async (asOf?: string) =>
    (await weldbooksApi.get<Envelope<LiabilityReport>>(`${REPORTS}/liability${buildQuery({ asOf })}`)).data,
  getSalesSummary: async (params: { from?: string; to?: string; groupBy?: SalesSummaryGroup }) =>
    (await weldbooksApi.get<Envelope<SalesSummary>>(`${REPORTS}/sales-summary${buildQuery({ ...params })}`)).data,
  getExceptionsReport: async (params: { from?: string; to?: string }) =>
    (await weldbooksApi.get<Envelope<SalesTaxExceptionsReport>>(`${REPORTS}/exceptions${buildQuery({ ...params })}`)).data,
  getExpiringCertificates: async (days?: number) =>
    (await weldbooksApi.get<Envelope<ExpiringCertificates>>(`${REPORTS}/certificates/expiring${buildQuery({ days })}`)).data,
  getMissingCertificates: async (params: { from?: string; to?: string }) =>
    (await weldbooksApi.get<Envelope<MissingCertificates>>(`${REPORTS}/certificates/missing${buildQuery({ ...params })}`)).data,
  getProviderReconciliation: async (params: { from?: string; to?: string; all?: boolean }) =>
    (
      await weldbooksApi.get<Envelope<ProviderReconciliation>>(
        `${REPORTS}/provider-reconciliation${buildQuery({ from: params.from, to: params.to, all: params.all ? 1 : undefined })}`,
      )
    ).data,

  // -- Nexus --------------------------------------------------------------------
  getNexusOverview: async (asOf?: string) =>
    (await weldbooksApi.get<Envelope<NexusOverview>>(`${NEXUS}${buildQuery({ asOf })}`)).data,
  getNexusDetail: async (stateCode: string, asOf?: string) =>
    (await weldbooksApi.get<Envelope<NexusDetail>>(`${NEXUS}/${encodeURIComponent(stateCode)}${buildQuery({ asOf })}`)).data,
};
