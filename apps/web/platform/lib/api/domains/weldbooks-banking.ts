/**
 * WeldBooks US banking client: bank account details (type, routing and account
 * number), statement import with explicit CSV formats, matching of bank lines to
 * payments and deposits, bank deposits from Undeposited Funds, and statement
 * reconciliation. Talks to books-api through the same `weldbooksApi` transport
 * as `accountingApi`; shapes mirror the routes in
 * `apps/workers/books-api/src/routes/{bank-accounts,bank-transactions,
 * bank-deposits,bank-reconciliations}`.
 */
import { weldbooksApi } from '../weldbooks-client';
import type { BankAccount, BankTransaction } from './weldbooks';

// ============================================================================
// Envelopes
// ============================================================================

export interface Envelope<T> {
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

/** An error thrown by `weldbooksApi` (its class isn't exported): status, parsed body and error code. */
export interface WeldbooksRequestError extends Error {
  status: number;
  body: unknown;
  code: string | null;
}

export function isWeldbooksRequestError(err: unknown): err is WeldbooksRequestError {
  return err instanceof Error && typeof (err as { status?: unknown }).status === 'number';
}

/** The `details` object of an error response, when it carries one. */
export function errorDetails(err: unknown): Record<string, unknown> | null {
  if (!isWeldbooksRequestError(err)) return null;
  const body = err.body as { error?: { details?: unknown } } | null;
  const details = body?.error?.details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
}

// ============================================================================
// Bank accounts
// ============================================================================

export const BANK_ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'money_market', 'line_of_credit'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

/** Credit cards and lines of credit are liabilities: the balance is what is owed. */
export function isLiabilityAccountType(type: string | null | undefined): boolean {
  return type === 'credit_card' || type === 'line_of_credit';
}

export type CsvDateFormat = 'MDY' | 'DMY' | 'YMD';
export type CsvNegativeStyle = 'minus' | 'parentheses' | 'debit_credit_columns' | 'trailing_minus';
/** A CSV column: header text (when the file has a header row) or a zero-based index. */
export type CsvColumnRef = string | number;
export type CsvDelimiter = ',' | ';' | '\t' | '|';

export interface CsvFormat {
  dateFormat: CsvDateFormat;
  decimalSeparator: '.' | ',';
  thousandsSeparator: ',' | '.' | ' ' | '';
  negativeStyle: CsvNegativeStyle;
  columns: {
    date: CsvColumnRef;
    description: CsvColumnRef;
    amount?: CsvColumnRef;
    debit?: CsvColumnRef;
    credit?: CsvColumnRef;
    checkNumber?: CsvColumnRef;
    payee?: CsvColumnRef;
    reference?: CsvColumnRef;
  };
  hasHeader: boolean;
  skipRows: number;
  delimiter?: CsvDelimiter;
}

interface BankAccountUsFields {
  accountType?: BankAccountType | null;
  routingNumber?: string | null;
  /** The last four characters of the stored account number. */
  accountNumberLast4?: string | null;
  hasAccountNumber?: boolean;
  nextCheckNumber?: number | null;
  /** Remembered import settings; `csv` is the confirmed CSV layout. */
  importSettings?: { csv?: CsvFormat } & Record<string, unknown> | null;
}

/** A bank account as the US banking screens read it. */
export type UsBankAccount = BankAccount & BankAccountUsFields;

export interface SaveBankAccountInput {
  name: string;
  iban?: string;
  bic?: string;
  bankName?: string;
  accountHolderName?: string;
  currency?: string;
  ledgerAccountId?: string;
  isDefault?: boolean;
  autoReconcile?: boolean;
  accountType?: BankAccountType;
  nextCheckNumber?: number;
  routingNumber?: string | null;
  /** Write-only; `null` removes the stored number. */
  accountNumber?: string | null;
  /** Create: set false to link an existing ledger account later instead of creating one. */
  createLedgerAccount?: boolean;
  importSettings?: { csv?: CsvFormat };
}

export interface CreatedBankAccount extends UsBankAccount {
  ledgerAccount?: { id: string; code: string; name: string; created: boolean };
}

export interface RevealedAccountNumber {
  accountNumber: string;
  routingNumber: string | null;
  accountNumberLast4: string | null;
}

// ============================================================================
// Statement import
// ============================================================================

export type BankFileFormat = 'mt940' | 'camt053' | 'csv' | 'ofx' | 'qfx' | 'qbo' | 'bai2';

export interface CsvFormatProposal {
  format: CsvFormat;
  headers: string[];
  sampleRows: string[][];
  /** True when the date order could not be told from the data; the user must confirm it. */
  dateOrderAmbiguous: boolean;
  warnings: string[];
}

export interface ParsedStatementLine {
  date: string;
  valueDate?: string;
  description: string;
  /** Signed from the account holder's side: money in positive, money out negative. */
  amount: number;
  runningBalance?: number;
  counterpartyName?: string;
  reference?: string;
  checkNumber?: string;
  externalId?: string;
}

export interface StatementAccountInfo {
  accountNumberLast4?: string;
  routingNumber?: string;
  accountType?: string;
  currency?: string;
}

export type ImportProblemCode = 'ACCOUNT_MISMATCH' | 'CURRENCY_MISMATCH';

export interface ImportProblem {
  code: ImportProblemCode;
  message: string;
  details: Record<string, unknown>;
}

export interface ImportPreviewInput {
  bankAccountId?: string;
  content: string;
  fileName?: string;
  format?: BankFileFormat;
  csvFormat?: CsvFormat;
  sampleSize?: number;
}

export interface ImportPreview {
  format: BankFileFormat;
  needsCsvFormat: boolean;
  proposal?: CsvFormatProposal;
  account?: StatementAccountInfo;
  accounts?: StatementAccountInfo[];
  currency?: string;
  dateRange?: { from: string; to: string };
  openingBalance?: number;
  closingBalance?: number;
  totalParsed?: number;
  /** Lines already in the bank account; null when no bank account was given. */
  duplicates?: number | null;
  problem?: ImportProblem | null;
  errors?: Array<{ line?: number; message: string }>;
  sample?: ParsedStatementLine[];
}

export interface ImportStatementInput {
  bankAccountId: string;
  fileName: string;
  content: string;
  format?: BankFileFormat;
  csvFormat?: CsvFormat;
  rememberCsvFormat?: boolean;
  ignoreAccountMismatch?: boolean;
}

export interface ImportStatementResult {
  batchId: string;
  format: BankFileFormat;
  totalParsed: number;
  imported: number;
  duplicates: number;
  autoReconciled: number;
  errors: Array<{ line?: number; message: string }>;
  dateRange: { from: string; to: string } | null;
  closingBalance: number | null;
  currency: string | null;
  csvFormatRemembered: boolean;
  warning: { code: ImportProblemCode; message: string } | null;
}

// ============================================================================
// Bank lines and matching
// ============================================================================

export type BankLineSource = 'import' | 'feed' | 'manual';

/** A bank transaction with the fields US banking added. */
export type BankLine = BankTransaction & {
  checkNumber?: string | null;
  source?: BankLineSource | null;
  depositId?: string | null;
  reconciledPaymentId?: string | null;
};

export interface BankLineFilters {
  bankAccountId?: string;
  status?: string;
  from?: string;
  to?: string;
  search?: string;
  checkNumber?: string;
  source?: BankLineSource;
  depositId?: string;
  page?: number;
  pageSize?: number;
}

export type BankLinePage = CursorPage<BankLine>;

export type SuggestionType = 'invoice' | 'bill' | 'payment' | 'deposit';

export interface MatchSuggestion {
  type: SuggestionType;
  id: string;
  number: string | null;
  contactName: string | null;
  amount: string | number;
  /** 0 to 1. */
  confidence: number;
  reasons: string[];
}

// ============================================================================
// Payments (deposit target)
// ============================================================================

export interface RecordInvoicePaymentWithTarget {
  amount: string;
  date: string;
  paymentMethod: string;
  checkNumber?: string;
  reference?: string;
  /** Naming a bank account debits it directly; leave out to let checks and cash wait in Undeposited Funds. */
  bankAccountId?: string;
}

// ============================================================================
// Deposits
// ============================================================================

export interface UndepositedPayment {
  paymentId: string;
  date: string;
  paymentMethod: string | null;
  checkNumber: string | null;
  reference: string | null;
  currency: string | null;
  paymentAmount: string;
  /** What sits in Undeposited Funds for it, in the entity's base currency. */
  amount: number;
  contactId: string;
  contactName: string | null;
  journalEntryId: string;
}

export interface BankDeposit {
  id: string;
  bankAccountId: string;
  date: string;
  amount: string;
  currency: string;
  memo: string | null;
  status: 'posted' | 'void';
  journalEntryId: string | null;
  bankTransactionId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface DepositPaymentRow {
  id: string;
  date: string;
  amount: string;
  currency: string | null;
  paymentMethod: string | null;
  checkNumber: string | null;
  reference: string | null;
  contactId: string;
  contactName: string | null;
  invoiceId: string | null;
}

export interface DepositOtherLineView {
  accountId: string;
  amount: number;
  description?: string | null;
  accountCode: string | null;
  accountName: string | null;
}

export interface BankDepositDetail extends BankDeposit {
  bankAccountName: string | null;
  journalEntryNumber: string | null;
  payments: DepositPaymentRow[];
  otherLines: DepositOtherLineView[];
}

export interface DepositOtherLineInput {
  accountId: string;
  /** Positive adds to the deposit, negative is cash back. */
  amount: number;
  description?: string;
}

export interface CreateDepositInput {
  bankAccountId: string;
  /** `YYYY-MM-DD` */
  date: string;
  paymentIds: string[];
  otherLines?: DepositOtherLineInput[];
  memo?: string;
}

export interface DepositFilters {
  bankAccountId?: string;
  status?: 'posted' | 'void';
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

// ============================================================================
// Statement reconciliation
// ============================================================================

export type ReconciliationStatus = 'in_progress' | 'completed' | 'undone';

export interface ReconciliationLine {
  id: string;
  journalEntryId: string;
  entryNumber: string | null;
  date: string;
  description: string | null;
  /** Always positive; the list it sits in says which way the money went. */
  amount: number;
  contactId: string | null;
  contactName: string | null;
  reference: string | null;
  sourceType: string | null;
  document: {
    type: string;
    id: string | null;
    number: string | null;
    checkNumber: string | null;
    method: string | null;
  } | null;
  cleared: boolean;
}

interface LineGroupTotals {
  count: number;
  total: number;
  clearedCount: number;
  clearedTotal: number;
}

export interface ReconciliationView {
  id: string;
  bankAccountId: string;
  bankAccountName: string | null;
  ledgerAccountId: string;
  ledger: { code: string; name: string; type: string };
  /** A card's balance is what is owed, and its signs flip. */
  accountKind: 'bank' | 'credit_card';
  status: ReconciliationStatus;
  statementDate: string;
  beginningBalance: string;
  statementEndingBalance: string;
  clearedBalance: string;
  difference: string;
  clearedLineIds: string[];
  /** Debit lines: deposits and credits on a bank account, payments to a card. */
  inflows: ReconciliationLine[];
  /** Credit lines: checks and payments on a bank account, charges on a card. */
  outflows: ReconciliationLine[];
  totals: { inflows: LineGroupTotals; outflows: LineGroupTotals };
  /** Pairs of an entry and its reversal that net to zero and are cleared automatically. */
  nettedLineCount: number;
  adjustmentJournalEntryId: string | null;
  completedAt: string | null;
  completedBy: string | null;
  undoneAt: string | null;
  undoneBy: string | null;
}

export interface ReconciliationHistoryRow {
  id: string;
  bankAccountId: string;
  ledgerAccountId: string;
  statementDate: string;
  beginningBalance: string;
  statementEndingBalance: string;
  clearedBalance: string | null;
  difference: string | null;
  status: ReconciliationStatus;
  adjustmentJournalEntryId: string | null;
  completedAt: string | null;
  completedBy: string | null;
  undoneAt: string | null;
  createdAt: string;
  hasReport: boolean;
}

export interface ReconciliationHistoryFilters {
  bankAccountId?: string;
  status?: ReconciliationStatus;
  page?: number;
  pageSize?: number;
}

export interface StartReconciliationInput {
  bankAccountId: string;
  /** `YYYY-MM-DD` */
  statementDate: string;
  statementEndingBalance: number;
  /** Only used for the first reconciliation of an account. */
  beginningBalance?: number;
}

export interface SaveReconciliationProgressInput {
  clearedLineIds?: string[];
  statementDate?: string;
  statementEndingBalance?: number;
}

export interface CompleteReconciliationInput {
  clearedLineIds?: string[];
  adjustment?: { accountId: string; memo?: string };
}

interface ReportTotals {
  count: number;
  total: number;
}

export interface ReportLine {
  id: string;
  date: string;
  entryNumber: string | null;
  description: string | null;
  amount: number;
  contactName: string | null;
  checkNumber: string | null;
  documentType: string | null;
  documentNumber: string | null;
}

export interface ReportGroup extends ReportTotals {
  items: ReportLine[];
}

export interface ReconciliationReport {
  /** Status of the reconciliation, as stored with the report. */
  status?: ReconciliationStatus;
  /** True while the reconciliation is open: a live preview, not a stored snapshot. */
  preview?: boolean;
  version: number;
  bankAccountId: string;
  bankAccountName: string | null;
  ledgerAccount: { id: string; code: string; name: string };
  accountKind: 'bank' | 'credit_card';
  statementDate: string;
  summary: {
    beginningBalance: number;
    clearedInflows: ReportTotals;
    clearedOutflows: ReportTotals;
    clearedBalance: number;
    statementEndingBalance: number;
    difference: number;
    unclearedInflows: ReportTotals;
    unclearedOutflows: ReportTotals;
    registerBalanceAtStatementDate: number;
    unclearedAfterStatementInflows: ReportTotals;
    unclearedAfterStatementOutflows: ReportTotals;
    registerBalanceToday: number;
  };
  clearedInflows: ReportGroup;
  clearedOutflows: ReportGroup;
  unclearedInflows: ReportGroup;
  unclearedOutflows: ReportGroup;
  unclearedAfterStatementInflows: ReportGroup;
  unclearedAfterStatementOutflows: ReportGroup;
  adjustment: {
    journalEntryId: string | null;
    amount: number;
    accountId: string;
    accountName: string | null;
    memo: string | null;
  } | null;
}

// ============================================================================
// API
// ============================================================================

export const bankingApi = {
  // Bank accounts
  listBankAccounts: (params?: { accountType?: BankAccountType; isActive?: boolean }) =>
    weldbooksApi.get<Envelope<UsBankAccount[]>>(`/bank-accounts${buildQuery(params ?? {})}`),
  getBankAccount: (id: string) => weldbooksApi.get<Envelope<UsBankAccount>>(`/bank-accounts/${id}`),
  createBankAccount: (data: SaveBankAccountInput) =>
    weldbooksApi.post<Envelope<CreatedBankAccount>>('/bank-accounts', data),
  updateBankAccount: (id: string, data: Partial<SaveBankAccountInput>) =>
    weldbooksApi.patch<Envelope<UsBankAccount>>(`/bank-accounts/${id}`, data),
  revealAccountNumber: (id: string, reason?: string) =>
    weldbooksApi.post<Envelope<RevealedAccountNumber>>(`/bank-accounts/${id}/reveal-account-number`, { reason }),

  // Statement import
  previewImport: (data: ImportPreviewInput) =>
    weldbooksApi.post<Envelope<ImportPreview>>('/bank-transactions/import/preview', data),
  importStatement: (data: ImportStatementInput) =>
    weldbooksApi.post<Envelope<ImportStatementResult>>('/bank-transactions/import', data),

  // Bank lines and matching
  listBankLines: (params?: BankLineFilters) =>
    weldbooksApi.get<BankLinePage>(`/bank-transactions${buildQuery({ ...params })}`),
  getSuggestions: (id: string) => weldbooksApi.get<Envelope<MatchSuggestion[]>>(`/bank-transactions/${id}/suggestions`),
  matchPayment: (id: string, paymentId: string) =>
    weldbooksApi.post<Envelope<{ id: string; status: string; paymentId: string; journalEntryId: string | null }>>(
      `/bank-transactions/${id}/match-payment`,
      { paymentId },
    ),
  matchDeposit: (id: string, depositId: string) =>
    weldbooksApi.post<Envelope<{ id: string; status: string; depositId: string; journalEntryId: string | null }>>(
      `/bank-transactions/${id}/match-deposit`,
      { depositId },
    ),

  // Payments
  recordInvoicePayment: (invoiceId: string, data: RecordInvoicePaymentWithTarget) =>
    weldbooksApi.post<Envelope<unknown>>(`/invoices/${invoiceId}/record-payment`, data),

  // Deposits
  listUndeposited: () => weldbooksApi.get<CursorPage<UndepositedPayment>>('/bank-deposits/undeposited'),
  listDeposits: (params?: DepositFilters) =>
    weldbooksApi.get<CursorPage<BankDeposit>>(`/bank-deposits${buildQuery({ ...params })}`),
  getDeposit: (id: string) => weldbooksApi.get<Envelope<BankDepositDetail>>(`/bank-deposits/${id}`),
  createDeposit: (data: CreateDepositInput) =>
    weldbooksApi.post<Envelope<{ id: string; journalEntryId: string | null; amount: string }>>('/bank-deposits', data),
  updateDepositMemo: (id: string, memo: string | null) =>
    weldbooksApi.patch<Envelope<BankDeposit>>(`/bank-deposits/${id}`, { memo }),
  voidDeposit: (id: string) => weldbooksApi.delete<void>(`/bank-deposits/${id}`),

  // Statement reconciliation
  listReconciliations: (params?: ReconciliationHistoryFilters) =>
    weldbooksApi.get<CursorPage<ReconciliationHistoryRow>>(`/bank-reconciliations${buildQuery({ ...params })}`),
  startReconciliation: (data: StartReconciliationInput) =>
    weldbooksApi.post<Envelope<ReconciliationView>>('/bank-reconciliations', data),
  getReconciliation: (id: string) => weldbooksApi.get<Envelope<ReconciliationView>>(`/bank-reconciliations/${id}`),
  saveReconciliationProgress: (id: string, data: SaveReconciliationProgressInput) =>
    weldbooksApi.patch<Envelope<ReconciliationView>>(`/bank-reconciliations/${id}`, data),
  completeReconciliation: (id: string, data: CompleteReconciliationInput) =>
    weldbooksApi.post<Envelope<ReconciliationView>>(`/bank-reconciliations/${id}/complete`, data),
  undoReconciliation: (id: string) =>
    weldbooksApi.post<Envelope<ReconciliationView>>(`/bank-reconciliations/${id}/undo`),
  discardReconciliation: (id: string) => weldbooksApi.delete<void>(`/bank-reconciliations/${id}`),
  getReconciliationReport: (id: string) =>
    weldbooksApi.get<Envelope<ReconciliationReport>>(`/bank-reconciliations/${id}/report`),
};
