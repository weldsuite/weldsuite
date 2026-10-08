/**
 * WeldBooks US vendor payment runs client: check runs and ACH runs, dual
 * approval with verification holds, check printing data, voiding and
 * reissuing, the check register, NACHA files, Positive Pay files and the
 * check / ACH / Positive Pay settings of a bank account. Talks to books-api
 * through the same `weldbooksApi` transport as `accountingApi`; shapes mirror
 * `apps/workers/books-api/src/routes/payment-runs/*` and
 * `services/payment-runs/*`.
 *
 * The NACHA and Positive Pay responses carry the file as text. Vendor account
 * numbers are decrypted on the server for them and the reveal is logged, so
 * the hooks in `use-weldbooks-payment-runs-queries.ts` run them as one-shot
 * actions and never cache the content.
 */
import { weldbooksApi } from '../weldbooks-client';

// ============================================================================
// Envelopes
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

// ============================================================================
// Shared vocabulary
// ============================================================================

export const RUN_METHODS = ['check', 'ach'] as const;
export type RunMethod = (typeof RUN_METHODS)[number];

export const RUN_STATUSES = ['draft', 'pending_approval', 'approved', 'exported', 'completed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ACH_SEC_CODES = ['PPD', 'CCD', 'CCD+', 'CTX'] as const;
export type AchSecCode = (typeof ACH_SEC_CODES)[number];

export const HOLD_CODES = [
  'no_bank_details',
  'invalid_bank_details',
  'bank_details_changed',
  'prenote_required',
  'prenote_pending',
  'in_other_run',
  'backup_withholding',
] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

export type CheckStatus = 'to_print' | 'printed' | 'cleared' | 'voided';

export type PrenoteState = 'proven' | 'pending' | 'needed';

/** Why backup withholding applies to a vendor: no TIN on file, or flagged after an IRS B notice. */
export type BackupWithholdingReason = 'no_tin' | 'flagged';

// ============================================================================
// Payable bills (the new-run wizard)
// ============================================================================

export interface PayableBill {
  id: string;
  billNumber: string | null;
  reference: string | null;
  status: string;
  issueDate: string | null;
  dueDate: string;
  daysOverdue: number;
  currency: string | null;
  total: string | null;
  balanceDue: string | null;
  /** The draft or pending run that already holds the bill. */
  inOpenRunId: string | null;
}

export interface VendorAchReadiness {
  hasRouting: boolean;
  hasAccount: boolean;
  hasAccountType: boolean;
  routingValid: boolean;
  last4: string | null;
  accountType: 'checking' | 'savings' | null;
  bankDetailsChangedAt: string | null;
  bankDetailsVerifiedAt: string | null;
  verified: boolean;
  holdActive: boolean;
  ready: boolean;
  prenote: PrenoteState;
  /** Payments wait for a manager to verify the changed bank details. */
  held: boolean;
}

export type PayableWithholding =
  | { applies: false }
  | { applies: true; reason: BackupWithholdingReason | null; rate: number; amount: string; net: string };

export interface PayableVendor {
  partyId: string;
  name: string;
  addressLines: string[];
  totalDue: string;
  /** Null when the vendor could not be read. */
  ach: VendorAchReadiness | null;
  /**
   * Backup withholding on what the vendor is owed in total: what would be kept back and what the vendor
   * would be paid. The run takes it out of the payment; it holds nobody.
   */
  backupWithholding: PayableWithholding;
  bills: PayableBill[];
}

export interface PayableBillsFilter {
  dueBefore?: string;
  partyId?: string;
  bankAccountId?: string;
}

// ============================================================================
// Runs
// ============================================================================

export interface PaymentRunSummary {
  id: string;
  bankAccountId: string;
  bankAccountName: string | null;
  method: RunMethod;
  status: RunStatus;
  /** YYYY-MM-DD */
  paymentDate: string;
  secCode: AchSecCode | null;
  sameDay: boolean;
  /** What the run will pay: vendors on hold are left out. */
  totalAmount: string;
  paymentCount: number;
  requiredApprovals: number;
  approvalCount: number;
  billCount: number;
  heldVendorCount: number;
  fileName: string | null;
  fileGeneratedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
}

export interface RunFilters {
  status?: RunStatus;
  method?: RunMethod;
  bankAccountId?: string;
  limit?: number;
  cursor?: string;
}

export interface HoldRelease {
  by: string;
  at: string;
  reason: string;
}

export interface RunHoldView {
  partyId: string;
  partyName: string;
  code: HoldCode;
  /** English text from the server; the UI prefers its own translation of the code. */
  message: string;
  released: HoldRelease | null;
  /** A hold on bank details is never released from the run: it clears when the vendor is verified. */
  releasable: boolean;
}

export interface RunVendorPayment {
  id: string;
  /** What the payment settles with the vendor's bills, before withholding. */
  amount: string;
  backupWithholdingAmount: string | null;
  /** What the bank was credited, the check is written for and the NACHA file pays. */
  netAmount: string;
  checkNumber: string | null;
  checkStatus: CheckStatus | null;
  deleted: boolean;
}

/** Backup withholding on a vendor's payment: kept back once the payment is made, a preview before that. */
export interface RunVendorWithholding {
  amount: string;
  /** What the vendor is paid. */
  net: string;
  reason: BackupWithholdingReason | null;
  rate: number;
}

export interface RunVendorView {
  partyId: string;
  name: string;
  /** What the vendor's bills in the run settle for, before backup withholding. */
  amount: string;
  billCount: number;
  held: boolean;
  backupWithholding: RunVendorWithholding | null;
  holds: Array<{
    code: HoldCode;
    message: string;
    releasable: boolean;
    released: HoldRelease | null;
    blocker: string | null;
  }>;
  payment: RunVendorPayment | null;
}

export interface RunApproval {
  userId: string;
  at: string;
}

export interface RunItemView {
  billId: string;
  billNumber: string | null;
  partyId: string;
  partyName: string;
  amount: string;
  billTotal: string | null;
  balanceDue: string | null;
  dueDate: string | null;
}

export interface RunHistoryEntry {
  action: string;
  userId: string | null;
  at: string;
  changes: Record<string, { old: unknown; new: unknown }> | null;
}

export interface PaymentRunDetail extends PaymentRunSummary {
  bankAccount: { id: string; name: string; accountNumberLast4: string | null } | null;
  /** Total of the vendors on hold, left out of `totalAmount`. */
  heldAmount: string;
  /** Backup withholding kept back from `totalAmount` (a preview until the payments are made). */
  withheldAmount: string;
  /** What leaves the bank: `totalAmount` less `withheldAmount`. */
  netAmount: string;
  approvals: RunApproval[];
  items: RunItemView[];
  vendors: RunVendorView[];
  holds: RunHoldView[];
  history: RunHistoryEntry[];
}

export interface RunItemInput {
  billId: string;
  amount: number;
}

export interface CreateRunInput {
  bankAccountId: string;
  method: RunMethod;
  /** YYYY-MM-DD */
  paymentDate: string;
  /** ACH. Leave out to pick per vendor. */
  secCode?: AchSecCode | null;
  sameDay?: boolean;
  items: RunItemInput[];
  /** Default 2 for ACH and 1 for checks. */
  requiredApprovals?: 1 | 2;
  notes?: string | null;
}

export type UpdateRunInput = Partial<Omit<CreateRunInput, 'method'>>;

export interface ApproveRunResult {
  run: PaymentRunDetail;
  approved: boolean;
  approvalCount: number;
  requiredApprovals: number;
  payments: Array<{
    paymentId: string;
    partyId: string;
    partyName: string;
    /** What the payment settles with the vendor's bills, before withholding. */
    amount: string;
    backupWithholdingAmount: string | null;
    /** What the bank is credited, the check is written for and the NACHA file pays. */
    netAmount: string;
    checkNumber: string | null;
    created: boolean;
  }>;
}

// ============================================================================
// Checks
// ============================================================================

export type FontName = 'helvetica' | 'courier' | 'micr';

export interface TextBox {
  x: number;
  y: number;
  width: number;
  align: 'left' | 'right' | 'center';
  fontSize: number;
  font: FontName;
  bold?: boolean;
  lineHeight?: number;
}

export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CheckFaceFields {
  payer: TextBox;
  bank: TextBox;
  checkNumber: TextBox;
  fractional: TextBox;
  dateLabel: TextBox;
  date: TextBox;
  payeeLabel: TextBox;
  payee: TextBox;
  payeeAddress: TextBox;
  amountBox: { x: number; y: number; width: number; height: number };
  amount: TextBox;
  amountWords: TextBox;
  dollarsLabel: TextBox;
  memoLabel: TextBox;
  memo: TextBox;
  signatureLine: LineSegment;
  voidAfter: TextBox;
  micrAuxOnUs: TextBox;
  micrTransit: TextBox;
  micrOnUs: TextBox;
}

export interface VoucherFields {
  payer: TextBox;
  title: TextBox;
  payee: TextBox;
  date: TextBox;
  checkNumber: TextBox;
  table: {
    x: number;
    y: number;
    width: number;
    height: number;
    rowHeight: number;
    maxRows: number;
    fontSize: number;
    columns: ReadonlyArray<{
      key: 'date' | 'reference' | 'description' | 'amount';
      x: number;
      width: number;
      align: 'left' | 'right';
    }>;
  };
  totalLabel: TextBox;
  total: TextBox;
}

export interface CheckFace {
  top: number;
  height: number;
  fields: CheckFaceFields;
}

export interface CheckVoucher {
  top: number;
  height: number;
  fields: VoucherFields;
}

export type CheckLayoutId = 'voucher_top' | 'voucher_middle' | 'voucher_bottom' | 'three_per_page';

export interface CheckLayout {
  id: CheckLayoutId;
  label: string;
  /** Letter in points, origin top-left. */
  page: { width: number; height: number };
  faces: CheckFace[];
  vouchers: CheckVoucher[];
}

export interface MicrFields {
  auxOnUs: string;
  transit: string;
  onUs: string;
}

export interface CheckPrintMicr {
  line: string;
  fields: MicrFields;
  /** The same fields with the E-13B symbols as the letters common MICR fonts use. */
  fieldsAsFontLetters: MicrFields;
}

export interface VoucherRow {
  date: string | null;
  reference: string | null;
  description: string | null;
  amount: string;
  billTotal: string | null;
  discount: string | null;
}

export interface CheckPrintItem {
  paymentId: string;
  checkNumber: string;
  checkStatus: CheckStatus;
  /** YYYY-MM-DD */
  date: string;
  /** MM/DD/YYYY, as printed. */
  dateDisplay: string;
  /** What the check is written for: the payment less any backup withholding. */
  amount: string;
  /** What the payment settles with the vendor's bills, before withholding. */
  grossAmount: string;
  backupWithholdingAmount: string | null;
  /** In words and in the amount box: both are the net amount. */
  amountInWords: string;
  /** "$**1,234.56" */
  courtesyAmount: string;
  payee: { partyId: string; name: string; addressLines: string[] };
  memo: string | null;
  fractionalRouting: string | null;
  /** The MICR line for blank check stock; null when the stock is preprinted. */
  micr: CheckPrintMicr | null;
  voucher: {
    rows: VoucherRow[];
    /** The bills' amounts added up, before withholding. */
    grossTotal: string;
    /** Backup withholding deducted on the stub; null when none. */
    backupWithholding: string | null;
    /** The amount of the check: `grossTotal` less the withholding. */
    total: string;
  };
}

export interface CheckPrintData {
  run: { id: string; status: string; paymentDate: string; bankAccountId: string };
  layout: CheckLayout;
  settings: {
    layout: CheckLayoutId;
    printMicr: boolean;
    signatureLineText: string | null;
    checkNumberWidth: number;
  };
  payer: { name: string; dba: string | null; addressLines: string[] };
  bank: { name: string | null; addressLines: string[]; accountNumberLast4: string | null };
  checks: CheckPrintItem[];
}

export interface MarkPrintedResult {
  run: PaymentRunDetail;
  printed: string[];
  alreadyPrinted: string[];
}

export interface VoidCheckInput {
  reason: string;
  reissue?: boolean;
  /** Date of the replacement check, YYYY-MM-DD; today when omitted. */
  date?: string;
}

export interface VoidCheckResult {
  /** `amount` is what the payment settles; `netAmount` what the check was written for. */
  voided: {
    paymentId: string;
    checkNumber: string | null;
    amount: string;
    backupWithholdingAmount: string | null;
    netAmount: string;
    partyId: string;
    runId: string | null;
  };
  replacement: {
    paymentId: string;
    checkNumber: string | null;
    amount: string;
    backupWithholdingAmount: string | null;
    netAmount: string;
    checkStatus: CheckStatus;
  } | null;
  run: unknown;
}

export interface CheckRegisterFilters {
  bankAccountId?: string;
  from?: string;
  to?: string;
  status?: CheckStatus;
  limit?: number;
  cursor?: string;
}

export interface CheckRegisterRow {
  paymentId: string;
  checkNumber: string | null;
  date: string;
  payeeId: string;
  payeeName: string;
  /** What the check is written for: the payment less any backup withholding. */
  amount: string;
  grossAmount: string;
  backupWithholdingAmount: string | null;
  status: CheckStatus;
  bankAccountId: string | null;
  runId: string | null;
  runStatus: string | null;
  printedAt: string | null;
  voidedAt: string | null;
  reference: string | null;
  notes: string | null;
}

export interface CheckRegisterPage {
  data: CheckRegisterRow[];
  summary: Partial<Record<CheckStatus, { count: number; total: string }>>;
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

// ============================================================================
// Files
// ============================================================================

export interface NachaSummary {
  runId: string;
  fileName: string;
  fileDate: string;
  effectiveEntryDate: string;
  fileIdModifier: string;
  sameDay: boolean;
  balanced: boolean;
  paymentCount: number;
  prenoteCount: number;
  batchCount: number;
  recordCount: number;
  blockCount: number;
  entryHash: string;
  /** Dollars. */
  totalCredit: string;
  totalDebit: string;
  originator: {
    immediateDestination: string;
    immediateDestinationName: string;
    immediateOrigin: string;
    immediateOriginName: string;
    companyName: string;
    companyIdentification: string;
    odfiRoutingNumber: string;
  };
  payments: Array<{
    paymentId: string;
    partyId: string;
    name: string;
    /** What is credited to the vendor: the payment less any backup withholding. */
    amount: string;
    /** What the payment settles with the vendor's bills. */
    grossAmount: string;
    backupWithholdingAmount: string | null;
    secCode: AchSecCode;
    accountLast4: string | null;
    traceNumber: string | null;
  }>;
  prenotes: Array<{ partyId: string; name: string; traceNumber: string | null }>;
  warnings: Array<{ code: string; message: string; paymentId?: string }>;
}

export interface NachaFileResult {
  fileName: string;
  content: string;
  summary: NachaSummary;
}

export interface FileIssue {
  severity?: 'error' | 'warning';
  code: string;
  message: string;
  paymentId?: string;
  checkNumber?: string;
  field?: string;
}

export interface PositivePayFormatInfo {
  id: string;
  label: string;
  kind: 'csv' | 'fixed';
  documentation: 'generic' | 'third_party' | 'none';
  /** The preset is a starting point the company must match to the bank's own specification. */
  needsBankSpec: boolean;
  note: string;
  sourceUrl?: string;
}

export interface PositivePayFilters {
  bankAccountId: string;
  from?: string;
  to?: string;
  format?: string;
}

export interface PositivePayFileResult {
  fileName: string;
  content: string;
  format: string;
  counts: {
    records: number;
    issued: number;
    voided: number;
    /** Dollars. */
    totalIssued: string;
    totalVoided: string;
  };
  warnings: Array<{ code: string; message: string; checkNumber?: string }>;
}

// ============================================================================
// Bank account settings
// ============================================================================

export interface CheckAlignment {
  dx?: number;
  dy?: number;
  micrDx?: number;
  micrDy?: number;
}

export interface CheckSettings {
  layout: CheckLayoutId;
  alignment: CheckAlignment;
  /** Blank check stock: the MICR line is part of what is printed. */
  printMicr: boolean;
  micrLayout: 'business' | 'personal';
  checkNumberWidth: number;
  bankName: string | null;
  bankAddressLines: string[];
  fractionalNumerator: string | null;
  signatureLineText: string | null;
}

export interface AchSettings {
  immediateDestination: string | null;
  immediateDestinationName: string | null;
  immediateOrigin: string | null;
  immediateOriginName: string | null;
  companyName: string | null;
  companyIdentification: string | null;
  odfiRoutingNumber: string | null;
  balanced: boolean;
  offsetBankAccountId: string | null;
  defaultSecCode: AchSecCode;
  sameDayAllowed: boolean;
  entryDescription: string | null;
  holdWindowDays: number;
  requirePrenotes: boolean;
}

export interface EffectiveAch {
  immediateDestination: string | null;
  immediateDestinationName: string;
  immediateOrigin: string | null;
  immediateOriginName: string;
  companyName: string;
  companyIdentification: string | null;
  odfiRoutingNumber: string | null;
}

export interface Readiness {
  ready: boolean;
  missing: string[];
}

export interface BankPaymentSettings {
  bankAccountId: string;
  bankAccountName: string;
  bankName: string | null;
  routingNumber: string | null;
  accountNumberLast4: string | null;
  hasAccountNumber: boolean;
  nextCheckNumber: number | null;
  highestCheckNumberUsed: number | null;
  checkSettings: CheckSettings;
  achSettings: AchSettings;
  effectiveAch: EffectiveAch;
  positivePayFormat: string;
  readiness: { checks: Readiness; ach: Readiness; positivePay: Readiness };
  layouts: ReadonlyArray<{ id: CheckLayoutId; label: string; description: string }>;
  positivePayFormats: readonly PositivePayFormatInfo[];
}

/**
 * What `PUT /settings/:bankAccountId` takes: only the sections and keys sent
 * change, and `null` clears one. `achSettings.ein` is write-only: it becomes
 * the company identification ("1" + EIN).
 */
export interface UpdatePaymentSettingsInput {
  nextCheckNumber?: number | null;
  checkSettings?: Partial<{
    layout: CheckLayoutId;
    alignment: CheckAlignment;
    printMicr: boolean;
    micrLayout: 'business' | 'personal';
    checkNumberWidth: number;
    bankName: string | null;
    bankAddressLines: string[];
    fractionalNumerator: string | null;
    signatureLineText: string | null;
  }>;
  achSettings?: Partial<Omit<AchSettings, 'holdWindowDays'>> & { ein?: string; holdWindowDays?: number };
  positivePayFormat?: string | null;
}

// ============================================================================
// Client
// ============================================================================

export const paymentRunsApi = {
  // Runs
  listRuns: (params?: RunFilters) => weldbooksApi.get<CursorPage<PaymentRunSummary>>(`/payment-runs${buildQuery({ ...params })}`),
  getRun: (id: string) => weldbooksApi.get<Envelope<PaymentRunDetail>>(`/payment-runs/${id}`),
  listPayableBills: (params?: PayableBillsFilter) =>
    weldbooksApi.get<CursorPage<PayableVendor>>(`/payment-runs/payable-bills${buildQuery({ ...params })}`),
  createRun: (input: CreateRunInput) => weldbooksApi.post<Envelope<PaymentRunDetail>>('/payment-runs', input),
  updateRun: (id: string, input: UpdateRunInput) => weldbooksApi.patch<Envelope<PaymentRunDetail>>(`/payment-runs/${id}`, input),
  deleteRun: (id: string) => weldbooksApi.delete<void>(`/payment-runs/${id}`),
  submitRun: (id: string) => weldbooksApi.post<Envelope<PaymentRunDetail>>(`/payment-runs/${id}/submit`),
  approveRun: (id: string) => weldbooksApi.post<Envelope<ApproveRunResult>>(`/payment-runs/${id}/approve`),
  rejectRun: (id: string, reason: string) => weldbooksApi.post<Envelope<PaymentRunDetail>>(`/payment-runs/${id}/reject`, { reason }),
  cancelRun: (id: string) => weldbooksApi.post<Envelope<PaymentRunDetail>>(`/payment-runs/${id}/cancel`),
  releaseHold: (id: string, input: { partyId: string; reason?: string }) =>
    weldbooksApi.post<Envelope<PaymentRunDetail>>(`/payment-runs/${id}/release-hold`, input),
  completeRun: (id: string) => weldbooksApi.post<Envelope<PaymentRunDetail>>(`/payment-runs/${id}/complete`),

  // Checks
  getCheckPrintData: (id: string, all = false) =>
    weldbooksApi.get<Envelope<CheckPrintData>>(`/payment-runs/${id}/checks${all ? '?all=true' : ''}`),
  markChecksPrinted: (id: string, paymentIds: string[]) =>
    weldbooksApi.post<Envelope<MarkPrintedResult>>(`/payment-runs/${id}/checks/printed`, { paymentIds }),
  voidCheck: (paymentId: string, input: VoidCheckInput) =>
    weldbooksApi.post<Envelope<VoidCheckResult>>(`/payment-runs/checks/${paymentId}/void`, input),
  getCheckRegister: (params?: CheckRegisterFilters) =>
    weldbooksApi.get<CheckRegisterPage>(`/payment-runs/check-register${buildQuery({ ...params })}`),

  // Files
  getNachaFile: (id: string) => weldbooksApi.get<Envelope<NachaFileResult>>(`/payment-runs/${id}/nacha`),
  listPositivePayFormats: () => weldbooksApi.get<CursorPage<PositivePayFormatInfo>>('/payment-runs/positive-pay/formats'),
  getPositivePayFile: (params: PositivePayFilters) =>
    weldbooksApi.get<Envelope<PositivePayFileResult>>(`/payment-runs/positive-pay${buildQuery({ ...params })}`),

  // Settings
  getSettings: (bankAccountId: string) =>
    weldbooksApi.get<Envelope<BankPaymentSettings>>(`/payment-runs/settings/${bankAccountId}`),
  updateSettings: (bankAccountId: string, input: UpdatePaymentSettingsInput) =>
    weldbooksApi.put<Envelope<BankPaymentSettings>>(`/payment-runs/settings/${bankAccountId}`, input),
};
