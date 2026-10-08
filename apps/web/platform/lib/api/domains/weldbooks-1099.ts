/**
 * WeldBooks 1099 client: the yearly review, filings with their recipient
 * lines, the IRIS upload files, recipient copy layouts, TIN matching, Form
 * 945, vendor tax data (reveal, reveal log, bank verification) and online W-9
 * requests. Talks to books-api through the same `weldbooksApi` transport as
 * `accountingApi`; shapes mirror `apps/workers/books-api/src/routes/{form-1099,
 * w9-requests,public-w9,accounting-contacts}` and `services/form-1099/*`.
 *
 * Full TINs and account numbers only ever come back from the reveal calls and
 * the IRIS / TIN-matching file calls. Never put those responses in the query
 * cache: the hooks in `use-weldbooks-1099-queries.ts` call them as one-shot
 * actions.
 */
import { weldbooksApi } from '../weldbooks-client';
import { apiUrl } from '../public-env';
import type { Form1099Type } from '@/lib/weldbooks/form-1099';

// ============================================================================
// Shared shapes
// ============================================================================

export type { Form1099Type };

export type TinType = 'ein' | 'ssn' | 'itin';

export type W9FederalClassification =
  | 'individual'
  | 'c_corporation'
  | 's_corporation'
  | 'partnership'
  | 'trust_estate'
  | 'llc'
  | 'other';

export type LlcTaxClassification = 'C' | 'S' | 'P';

export type TinMatchStatus = 'match' | 'mismatch' | 'not_issued' | 'invalid' | 'pending';

export interface PostalAddressView {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  county?: string;
}

/** `{ data }` of a single resource. */
interface DataResponse<T> {
  data: T;
}

/** `{ data, pagination }` of a list. */
interface ListResponse<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

// ============================================================================
// Vendor tax data on a contact
// ============================================================================

export interface VendorW9 {
  legalName?: string;
  businessName?: string;
  federalTaxClassification?: W9FederalClassification;
  llcTaxClassification?: LlcTaxClassification;
  exemptPayeeCode?: string;
  fatcaCode?: string;
  receivedAt?: string;
  /** The accounting document holding the scan. */
  documentId?: string;
  signedName?: string;
  source?: 'upload' | 'online';
  isAttorney?: boolean;
}

/** The tax fields `GET /api/accounting-contacts` adds to a contact. Never a full TIN or account number. */
export interface VendorTaxView {
  taxUse?: 'business' | 'personal' | null;
  is1099Vendor?: boolean | null;
  default1099Form?: Form1099Type | null;
  default1099Box?: string | null;
  tinType?: TinType | null;
  tinLast4?: string | null;
  tinMasked?: string | null;
  hasTin?: boolean;
  w9?: VendorW9 | null;
  backupWithholding?: boolean | null;
  tinMatchStatus?: TinMatchStatus | null;
  tinMatchedAt?: string | null;
  form1099EDeliveryConsentAt?: string | null;
  achRoutingNumber?: string | null;
  achAccountLast4?: string | null;
  achAccountType?: 'checking' | 'savings' | null;
  hasAchAccount?: boolean;
  bankDetailsChangedAt?: string | null;
  bankDetailsVerifiedAt?: string | null;
  bankDetailsVerifiedBy?: string | null;
  /** Payment runs hold the vendor until the bank details are verified. */
  bankDetailsNeedVerification?: boolean;
}

/**
 * The tax fields a contact create or update accepts. `tin` and
 * `achAccountNumber` are write-only: a blank value (or leaving the key out)
 * keeps the stored one, `null` removes it.
 */
export interface VendorTaxPayload {
  taxUse?: 'business' | 'personal' | null;
  is1099Vendor?: boolean;
  default1099Form?: Form1099Type | null;
  default1099Box?: string | null;
  tinType?: TinType | null;
  tin?: string | null;
  w9?: VendorW9 | null;
  backupWithholding?: boolean;
  /** `true` = consent given now, `false` = withdrawn. */
  form1099EDeliveryConsentAt?: boolean | null;
  achRoutingNumber?: string | null;
  achAccountNumber?: string | null;
  achAccountType?: 'checking' | 'savings' | null;
}

export interface RevealedTin {
  /** The TIN with its dashes: `12-3456789` or `123-45-6789`. */
  tin: string;
  tinType: TinType | null;
}

export interface RevealedAchAccount {
  achAccountNumber: string;
  achRoutingNumber: string | null;
  achAccountType: 'checking' | 'savings' | null;
}

export interface TaxIdReveal {
  id: string;
  createdAt: string;
  entityId: string | null;
  /** party | form_1099_line */
  subjectType: string;
  subjectId: string;
  /** tin | ach_account_number */
  field: string;
  revealedBy: string;
  reason: string | null;
}

export const vendorTaxApi = {
  /** Contacts with their tax fields; `is1099Vendor: true` keeps only the vendors flagged for 1099 reporting. */
  listContacts: (
    params: {
      role?: 'customer' | 'supplier' | 'both' | 'none';
      search?: string;
      is1099Vendor?: boolean;
      page?: number;
      pageSize?: number;
    } = {},
  ) => weldbooksApi.get<ListResponse<VendorTaxContact>>(`/accounting-contacts${buildQuery(params)}`),
  /** One-shot: the caller keeps the result in component state only. */
  revealTin: (id: string, reason?: string) =>
    weldbooksApi.post<DataResponse<RevealedTin>>(`/accounting-contacts/${id}/reveal-tin`, reason ? { reason } : {}),
  /** One-shot: the caller keeps the result in component state only. */
  revealAchAccount: (id: string, reason?: string) =>
    weldbooksApi.post<DataResponse<RevealedAchAccount>>(
      `/accounting-contacts/${id}/reveal-ach-account`,
      reason ? { reason } : {},
    ),
  listReveals: (id: string) => weldbooksApi.get<ListResponse<TaxIdReveal>>(`/accounting-contacts/${id}/tax-id-reveals`),
  verifyBankDetails: (id: string) =>
    weldbooksApi.post<DataResponse<VendorTaxContact>>(`/accounting-contacts/${id}/verify-bank-details`),
};

/** A contact row as the 1099 vendor list needs it. */
export interface VendorTaxContact extends VendorTaxView {
  id: string;
  name: string;
  role?: string | null;
  email?: string | null;
  billingAddress?: PostalAddressView | null;
}

// ============================================================================
// Review (yearly computation)
// ============================================================================

export type Form1099VendorStatus =
  | 'included'
  | 'below_threshold'
  | 'excluded_corporation'
  | 'needs_tin'
  | 'needs_address'
  | 'not_1099_vendor';

export type BoxAmounts = Partial<Record<string, number>>;

export interface Form1099VendorRow {
  partyId: string;
  name: string;
  /** W-9 line 1 when received, else the contact name. */
  legalName: string;
  status: Form1099VendorStatus;
  reasons: string[];
  forms: Form1099Type[];
  /** Boxes that go on the form. */
  boxes: BoxAmounts;
  /** Every box total before thresholds and the corporation rule. */
  totals: BoxAmounts;
  aboveThreshold: boolean;
  isCorporation: boolean;
  isAttorney: boolean;
  tinType: TinType | null;
  tinLast4: string | null;
  tinMasked: string | null;
  hasTin: boolean;
  tinMatchStatus: TinMatchStatus | null;
  tinMatchedAt: string | null;
  backupWithholding: boolean;
  suggestBackupWithholding: boolean;
  addressComplete: boolean;
  address: PostalAddressView | null;
  hasW9: boolean;
  eDeliveryConsent: boolean;
  excluded: { cardOrNetwork: number; creditCardAccount: number; payroll: number; omittedBox: number };
  unmappedAmount: number;
  adjustmentCount: number;
  paymentCount: number;
  bankTransactionCount: number;
}

export interface Form1099Deadlines {
  taxYear: number;
  nec: { recipient: string; irs: string };
  misc: { recipient: string; recipientBoxes8And10: string; irsPaper: string; irsElectronic: string };
  form945: string;
}

export interface Form1099Summary {
  taxYear: number;
  entityId: string;
  thresholds: {
    /** False when the IRS has not published the year yet: the last known amounts are carried forward. */
    published: boolean;
    general: number | null;
    royalty: number | null;
    fixed600: number | null;
    boxes: BoxAmounts | Record<string, number | null>;
  };
  deadlines: Form1099Deadlines;
  summary: Record<Form1099VendorStatus, number>;
  totals: { nec: number; misc: number; withheld: number };
  vendors: Form1099VendorRow[];
  warnings: string[];
}

export interface Form1099DeadlinesResponse extends Form1099Deadlines {
  eFile: {
    requiredFrom: number;
    waiverRequestDays: number;
    necWaiverDeadline: string;
    miscWaiverDeadline: string;
  };
}

export interface DrillDownDocumentRefs {
  payment: {
    id: string;
    date: string;
    method: string | null;
    checkNumber: string | null;
    reference: string | null;
    amount: string | number;
    backupWithholdingAmount: string | number | null;
  } | null;
  bill: { id: string; number: string | null; issueDate: string | null; reference: string | null } | null;
  billLine: {
    id: string;
    description: string | null;
    account: { id: string; code: string; name: string } | null;
  } | null;
  bankTransaction: {
    id: string;
    date: string;
    description: string | null;
    counterpartyName: string | null;
    checkNumber: string | null;
    amount: string | number;
  } | null;
}

export type BoxSource = 'line' | 'account' | 'vendor' | 'transaction' | 'adjustment' | 'withholding';

export interface Form1099Contribution extends DrillDownDocumentRefs {
  box: string;
  amount: number;
  boxSource: BoxSource;
  unapplied: boolean;
}

export type Form1099ExclusionReason = 'card_or_network_method' | 'credit_card_account' | 'paid_through_payroll' | 'omitted_box';

export interface Form1099Exclusion extends DrillDownDocumentRefs {
  reason: Form1099ExclusionReason;
  amount: number;
  paymentMethod: string | null;
}

export interface Form1099Unmapped extends DrillDownDocumentRefs {
  reason: 'no_box' | 'invalid_box';
  amount: number;
}

export interface Form1099VendorDetail {
  taxYear: number;
  vendor: Form1099VendorRow;
  contributions: Form1099Contribution[];
  exclusions: Form1099Exclusion[];
  unmapped: Form1099Unmapped[];
  adjustments: Array<{ partyId: string; box: string; amount: number; reason: string; by?: string; applied: true }>;
  warnings: string[];
}

export interface Form945Summary {
  taxYear: number;
  backupWithholding: number;
  totalTaxes: number;
  months: Array<{ month: number; amount: number; depositDue: string }>;
  byVendor: Array<{ partyId: string; amount: number; paymentIds: string[]; name: string | null }>;
  dueDate: string;
}

// ============================================================================
// Filings
// ============================================================================

export type Form1099FilingStatus = 'draft' | 'reviewed' | 'generated' | 'filed' | 'corrected';

export type Form1099LineStatus = 'included' | 'excluded' | 'needs_tin' | 'needs_address' | 'filed';

export interface Form1099Filing {
  id: string;
  entityId: string;
  taxYear: number;
  formType: Form1099Type;
  status: Form1099FilingStatus;
  generatedAt: string | null;
  filedAt: string | null;
  confirmationNumber: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  lineCount: number;
  totals: { amount: number; withheld: number };
  statusCounts: Record<string, number>;
}

export interface Form1099LineAdjustment {
  box: string;
  amount: number;
  reason: string;
  by?: string;
  at?: string;
}

export interface Form1099LineRecipient {
  name: string;
  businessName?: string;
  address?: PostalAddressView;
  tinType?: TinType;
  tinLast4?: string;
  accountNumber?: string;
}

export interface Form1099StateHint {
  state: string;
  cfsfCode: string | null;
  direct: string;
  verified: boolean;
  note: string | null;
  needsDirectFiling: boolean;
}

export interface Form1099FilingLine {
  id: string;
  filingId: string;
  partyId: string;
  partyName: string | null;
  recipient: Form1099LineRecipient | null;
  hasTin: boolean;
  /** Box code to amount, for this form's boxes. */
  boxes: Record<string, number>;
  adjustments: Form1099LineAdjustment[] | null;
  federalWithheld: string | null;
  stateCode: string | null;
  stateIdNumber: string | null;
  stateIncome: string | null;
  stateWithheld: string | null;
  status: Form1099LineStatus;
  excludedReason: string | null;
  isCorrected: boolean;
  correctionOfLineId: string | null;
  deliveryMethod: 'print' | 'email' | null;
  deliveredAt: string | null;
  superseded: boolean;
  pendingCorrection: boolean;
  stateHint: Form1099StateHint | null;
}

export interface Form1099FilingDetail {
  filing: Form1099Filing;
  lines: Form1099FilingLine[];
}

export interface CreateFilingResult extends Form1099FilingDetail {
  warnings: string[];
}

export interface RefreshFilingResult extends Form1099FilingDetail {
  refresh: { warnings: string[]; updated: number; added: number };
}

export interface ReviewFilingResult extends Form1099FilingDetail {
  unresolved: Array<{ lineId: string; partyId: string; name: string | null; status: string }>;
}

export interface CorrectLineResult extends Form1099FilingDetail {
  correctionLineId: string;
}

export interface DeliveredResult extends Form1099FilingDetail {
  deliveredAt: string;
  deliveryMethod: 'print' | 'email';
}

export interface LinePatch {
  adjustments?: Array<{ box: string; amount: number; reason: string }>;
  status?: 'included' | 'excluded';
  excludedReason?: string | null;
  stateCode?: string | null;
  stateIdNumber?: string | null;
  stateIncome?: number | null;
  stateWithheld?: number | null;
  /** Only on a correction that has not been filed yet. */
  boxes?: Record<string, number>;
}

export interface CorrectLineInput {
  boxes: Record<string, number>;
  reason: string;
  /** Take the recipient's name, address and TIN from the vendor again. */
  refreshRecipient?: boolean;
}

/** A generated file: the IRIS upload CSV (full TINs) or an IRS TIN matching file. */
export interface GeneratedFile {
  filename: string;
  content: string;
  recordCount: number;
  warnings?: string[];
}

export interface IrisFilesResult {
  files: GeneratedFile[];
  taxYear: number;
  formType: Form1099Type;
  correctionsOnly: boolean;
}

// ============================================================================
// Recipient copies (layout data for the PDF renderer)
// ============================================================================

export type Form1099Copy = 'B' | '1' | '2' | 'C';

export const FORM_1099_COPIES: readonly Form1099Copy[] = ['B', '1', '2', 'C'];

export type PdfFieldKind = 'text' | 'amount' | 'tin' | 'checkbox';

export interface Form1099PdfField {
  id: string;
  label: string;
  value: string;
  kind: PdfFieldKind;
  x: number;
  y: number;
  width: number;
  height: number;
  align: 'left' | 'right';
  multiline?: boolean;
  checked?: boolean;
  box?: string;
}

export interface Form1099PdfTextBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  lineHeight: number;
  bold?: boolean;
  paragraphs: string[];
  paragraphGap?: number;
}

export interface Form1099PdfCopy {
  form: Form1099Type;
  copy: Form1099Copy;
  taxYear: number;
  page: { width: number; height: number; unit: 'pt'; origin: 'top-left' };
  title: string;
  copyLabel: string;
  labelFontSize: number;
  valueFontSize: number;
  fields: Form1099PdfField[];
  blocks: Form1099PdfTextBlock[];
  footer: string;
}

export interface FormCopiesResult {
  taxYear: number;
  formType: Form1099Type;
  lineId: string;
  /** The recipient's TIN, truncated to its last four digits. */
  recipientTin: string;
  copies: Form1099PdfCopy[];
  warnings: string[];
}

// ============================================================================
// TIN matching
// ============================================================================

export interface TinMatchingFileResult {
  files: GeneratedFile[];
  recordCount: number;
  skipped: Array<{ partyId: string; reason: string; name: string | null }>;
}

export interface TinMatchingResultsSummary {
  updated: string[];
  byStatus: Record<string, number>;
  problems: Array<{
    partyId: string;
    name: string | null;
    status: string;
    backupWithholding: boolean;
    suggestion: string;
  }>;
  stale: Array<{ partyId: string; name: string | null }>;
  unknownAccounts: Array<{ line: number; accountNumber: string }>;
  ignored: Array<{ line: number; code: number; reason: string }>;
  unreadable: Array<{ line: number; text: string }>;
}

// ============================================================================
// API
// ============================================================================

export const form1099Api = {
  summary: (year: number) => weldbooksApi.get<DataResponse<Form1099Summary>>(`/form-1099/summary${buildQuery({ year })}`),
  vendorDetail: (partyId: string, year: number) =>
    weldbooksApi.get<DataResponse<Form1099VendorDetail>>(`/form-1099/vendors/${partyId}${buildQuery({ year })}`),
  deadlines: (year: number) =>
    weldbooksApi.get<DataResponse<Form1099DeadlinesResponse>>(`/form-1099/deadlines${buildQuery({ year })}`),
  form945: (year: number) => weldbooksApi.get<DataResponse<Form945Summary>>(`/form-1099/945${buildQuery({ year })}`),

  /** Full TINs: one-shot, written to the reveal log by the server. */
  tinMatchingFile: (params: { all?: boolean; partyIds?: string[] } = {}) =>
    weldbooksApi.get<DataResponse<TinMatchingFileResult>>(
      `/form-1099/tin-matching/file${buildQuery({ all: params.all ? true : undefined, partyIds: params.partyIds?.join(',') })}`,
    ),
  tinMatchingResults: (text: string) =>
    weldbooksApi.post<DataResponse<TinMatchingResultsSummary>>('/form-1099/tin-matching/results', { text }),

  listFilings: (params: { year?: number; formType?: Form1099Type; status?: Form1099FilingStatus } = {}) =>
    weldbooksApi.get<ListResponse<Form1099Filing>>(`/form-1099/filings${buildQuery(params)}`),
  createFiling: (input: { taxYear: number; formType: Form1099Type }) =>
    weldbooksApi.post<DataResponse<CreateFilingResult>>('/form-1099/filings', input),
  getFiling: (id: string) => weldbooksApi.get<DataResponse<Form1099FilingDetail>>(`/form-1099/filings/${id}`),
  updateFiling: (id: string, input: { notes: string | null }) =>
    weldbooksApi.patch<DataResponse<Form1099FilingDetail>>(`/form-1099/filings/${id}`, input),
  deleteFiling: (id: string) => weldbooksApi.delete<void>(`/form-1099/filings/${id}`),
  refreshFiling: (id: string) =>
    weldbooksApi.post<DataResponse<RefreshFilingResult>>(`/form-1099/filings/${id}/refresh`),
  updateLine: (filingId: string, lineId: string, patch: LinePatch) =>
    weldbooksApi.patch<DataResponse<Form1099FilingDetail>>(`/form-1099/filings/${filingId}/lines/${lineId}`, patch),
  reviewFiling: (id: string) =>
    weldbooksApi.post<DataResponse<ReviewFilingResult>>(`/form-1099/filings/${id}/review`),
  generateFiling: (id: string) =>
    weldbooksApi.post<DataResponse<Form1099FilingDetail>>(`/form-1099/filings/${id}/generate`),
  /** Full TINs: one-shot, written to the reveal log by the server. */
  irisFiles: (id: string, templateHeaders?: string[] | string) =>
    templateHeaders && templateHeaders.length > 0
      ? weldbooksApi.post<DataResponse<IrisFilesResult>>(`/form-1099/filings/${id}/iris-csv`, { templateHeaders })
      : weldbooksApi.get<DataResponse<IrisFilesResult>>(`/form-1099/filings/${id}/iris-csv`),
  copies: (filingId: string, lineId: string, copies?: readonly Form1099Copy[]) =>
    weldbooksApi.get<DataResponse<FormCopiesResult>>(
      `/form-1099/filings/${filingId}/lines/${lineId}/copies${buildQuery({ copies: copies?.join(',') })}`,
    ),
  markFiled: (id: string, input: { confirmationNumber: string; filedAt?: string }) =>
    weldbooksApi.post<DataResponse<Form1099FilingDetail>>(`/form-1099/filings/${id}/mark-filed`, input),
  correctLine: (filingId: string, lineId: string, input: CorrectLineInput) =>
    weldbooksApi.post<DataResponse<CorrectLineResult>>(`/form-1099/filings/${filingId}/lines/${lineId}/correct`, input),
  markDelivered: (filingId: string, lineId: string, method: 'print' | 'email') =>
    weldbooksApi.post<DataResponse<DeliveredResult>>(`/form-1099/filings/${filingId}/lines/${lineId}/delivered`, { method }),
};

// ============================================================================
// Online W-9
// ============================================================================

export type W9RequestStatus = 'pending' | 'completed' | 'expired' | 'cancelled';

export interface W9Request {
  id: string;
  entityId: string;
  partyId: string;
  email: string | null;
  status: W9RequestStatus;
  expiresAt: string;
  completedAt: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateW9RequestResult {
  request: W9Request;
  /** Shown once: the server keeps only the link's hash. */
  url: string;
  /** Always false: nothing is emailed yet, the user sends the link. */
  emailSent: boolean;
}

export const w9RequestsApi = {
  list: (params: { partyId?: string; status?: W9RequestStatus } = {}) =>
    weldbooksApi.get<ListResponse<W9Request>>(`/w9-requests${buildQuery(params)}`),
  create: (input: { partyId: string; email?: string; expiresInDays?: number }) =>
    weldbooksApi.post<DataResponse<CreateW9RequestResult>>('/w9-requests', input),
  cancel: (id: string) => weldbooksApi.post<DataResponse<W9Request>>(`/w9-requests/${id}/cancel`),
};

// ============================================================================
// Public W-9 form (no sign-in: the token in the link is the credential)
// ============================================================================

export interface PublicW9Request {
  payer: { name: string };
  vendor: { displayName: string };
  expiresAt: string;
}

export interface PublicW9Submission {
  legalName: string;
  businessName?: string;
  federalTaxClassification: W9FederalClassification;
  llcTaxClassification?: LlcTaxClassification;
  exemptPayeeCode?: string;
  fatcaCode?: string;
  address: { line1: string; line2?: string; city: string; state: string; postalCode: string };
  tinType: TinType;
  tin: string;
  signedName: string;
  certify: true;
}

/** Error of a public W-9 call. A 404 covers unknown, expired, completed and cancelled links alike. */
export class PublicW9Error extends Error {
  readonly status: number;
  /** Field errors by path (`address.postalCode`), when the server sent them. */
  readonly fieldErrors: Record<string, string[]>;

  constructor(message: string, status: number, fieldErrors: Record<string, string[]> = {}) {
    super(message);
    this.name = 'PublicW9Error';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

async function publicW9Request<T>(method: 'GET' | 'POST', token: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/public/w9/${encodeURIComponent(token)}`), {
    method,
    // No Authorization header and no cookies: the link is the only credential.
    credentials: 'omit',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (json as { error?: { message?: unknown; details?: { fieldErrors?: Record<string, string[]> } } } | null)?.error;
    throw new PublicW9Error(
      typeof error?.message === 'string' ? error.message : `Request failed with status ${response.status}`,
      response.status,
      error?.details?.fieldErrors ?? {},
    );
  }
  return (json as { data: T }).data;
}

export const publicW9Api = {
  load: (token: string) => publicW9Request<PublicW9Request>('GET', token),
  submit: (token: string, submission: PublicW9Submission) =>
    publicW9Request<{ completed: boolean }>('POST', token, submission),
};
