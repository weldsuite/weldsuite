/**
 * WeldBooks fixed assets, payroll journal import, fiscal-period calendar and
 * the US tax due-date calendar. Talks to books-api through the same
 * `weldbooksApi` transport as `accountingApi`; shapes mirror
 * `apps/workers/books-api/src/routes/{fixed-assets,payroll,fiscal-periods,tax-calendar}`
 * and their services.
 *
 * Money conventions follow the server: rows read from the database
 * (assets, books, stored depreciation rows, payroll imports) carry money as
 * strings (`"1200.00"`); the computed reports and schedules carry JS numbers.
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
// Fixed assets: vocabulary
// ============================================================================

/** The MACRS property classes with tables (GDS). */
export const MACRS_CLASSES = ['3', '5', '7', '10', '15', '20', '25', '27.5', '39'] as const;
export type MacrsClass = (typeof MACRS_CLASSES)[number];

export const DEPRECIATION_METHODS = [
  'straight_line',
  'declining_balance',
  'macrs_gds',
  'macrs_ads',
  'expensed',
  'none',
] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export const CONVENTIONS = ['half_year', 'mid_quarter', 'mid_month', 'full_month'] as const;
export type DepreciationConvention = (typeof CONVENTIONS)[number];

export const BOOK_KINDS = ['book', 'federal', 'state'] as const;
export type BookKind = (typeof BOOK_KINDS)[number];

export const ASSET_STATUSES = ['active', 'fully_depreciated', 'disposed'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export interface DepreciationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/** An issue found while a book was built, tied to the book it concerns. */
export interface BookIssue extends DepreciationIssue {
  book: BookKind;
  stateCode: string | null;
}

export interface DepreciationBasis {
  cost: number;
  businessUsePercent: number;
  /** Cost times business use. */
  baseCost: number;
  salvage: number;
  section179: number;
  bonus: number;
  /** What the method spreads over the years. */
  depreciableBasis: number;
  /** Everything deducted over the life: section 179, bonus and the yearly amounts. */
  totalDepreciable: number;
}

export interface DepreciationRow {
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Everything deducted in the period. */
  amount: number;
  /** The yearly amount without section 179 and bonus. */
  regular: number;
  section179: number;
  bonus: number;
  accumulated: number;
  remaining: number;
}

// ============================================================================
// Fixed assets: rows
// ============================================================================

export interface FixedAsset {
  id: string;
  createdAt: string;
  updatedAt: string;
  entityId: string;
  assetNumber: string | null;
  name: string;
  description: string | null;
  assetClass: string | null;
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
  acquisitionDate: string;
  placedInServiceDate: string;
  cost: string;
  salvageValue: string;
  businessUsePercent: string;
  billId: string | null;
  billItemId: string | null;
  status: AssetStatus;
  disposalDate: string | null;
  disposalProceeds: string | null;
  disposalJournalEntryId: string | null;
  classId: string | null;
  locationId: string | null;
  notes: string | null;
}

export interface FixedAssetBookSummary {
  id: string;
  book: BookKind;
  stateCode: string | null;
  method: DepreciationMethod;
  convention: DepreciationConvention;
  recoveryYears: string;
  postsToLedger: boolean;
}

/** A row of the register list: the asset, its books and what is posted to the ledger so far. */
export interface FixedAssetListItem extends FixedAsset {
  books: FixedAssetBookSummary[];
  accumulatedPosted: string;
  netBookValuePosted: string;
}

export interface FixedAssetBookSchedule {
  method: DepreciationMethod;
  convention: DepreciationConvention;
  recoveryYears: number;
  basis: DepreciationBasis;
  annual: DepreciationRow[];
  issues: DepreciationIssue[];
}

export interface FixedAssetBook {
  id: string;
  assetId: string;
  book: BookKind;
  stateCode: string | null;
  method: DepreciationMethod;
  convention: DepreciationConvention;
  recoveryYears: string;
  section179Amount: string;
  bonusPercent: string;
  depreciableBasis: string;
  postsToLedger: boolean;
}

export interface FixedAssetBookWithSchedule extends FixedAssetBook {
  schedule: FixedAssetBookSchedule;
}

/** One stored depreciation amount of the ledger book; `journalEntryId` is set once it is posted. */
export interface LedgerDepreciationRow {
  id: string;
  assetId: string;
  bookId: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
  accumulated: string;
  journalEntryId: string | null;
}

export interface FixedAssetDetail extends FixedAsset {
  books: FixedAssetBookWithSchedule[];
  ledgerRows: LedgerDepreciationRow[];
  accumulatedPosted: string;
  netBookValuePosted: string;
  issues: BookIssue[];
}

/** What create, update and from-bill-line return: the asset, its books and the issues found while building them. */
export interface FixedAssetWriteResult extends FixedAsset {
  books: FixedAssetBook[];
  issues: BookIssue[];
}

export interface FromBillLineSource {
  billId: string;
  billItemId: string;
  lineAccountId: string | null;
  lineAccountCode: string | null;
  /** The bill line already debited a fixed asset account. */
  capitalized: boolean;
  /** The line debited something else: its cost still has to be moved to the asset account. */
  reclassNeeded: boolean;
  reclassJournalEntryId: string | null;
}

export interface FromBillLineResult extends FixedAssetWriteResult {
  source: FromBillLineSource;
}

// ============================================================================
// Fixed assets: inputs
// ============================================================================

export interface BookInput {
  book: BookKind;
  stateCode?: string | null;
  method: DepreciationMethod;
  convention?: DepreciationConvention;
  recoveryYears: number;
  section179Amount?: number;
  /** 0 to 100. */
  bonusPercent?: number;
  postsToLedger?: boolean;
}

/** Every field but `name`, `acquisitionDate` and `cost` is optional: the server fills the defaults in. */
export interface CreateAssetInput {
  name: string;
  assetNumber?: string | null;
  description?: string | null;
  assetClass?: string | null;
  assetAccountId?: string | null;
  accumulatedDepreciationAccountId?: string | null;
  depreciationExpenseAccountId?: string | null;
  acquisitionDate: string;
  placedInServiceDate?: string;
  cost: number;
  salvageValue?: number;
  businessUsePercent?: number;
  listedProperty?: boolean;
  billId?: string | null;
  billItemId?: string | null;
  classId?: string | null;
  locationId?: string | null;
  notes?: string | null;
  usefulLifeYears?: number;
  section179Amount?: number;
  bonusPercent?: number;
  bonusReducedElection?: boolean;
  books?: BookInput[];
}

/** Financial fields answer 409 once depreciation is posted; the rest stay editable. */
export interface UpdateAssetInput {
  name?: string;
  assetNumber?: string | null;
  description?: string | null;
  assetClass?: string | null;
  assetAccountId?: string;
  accumulatedDepreciationAccountId?: string;
  depreciationExpenseAccountId?: string;
  acquisitionDate?: string;
  placedInServiceDate?: string;
  cost?: number;
  salvageValue?: number;
  businessUsePercent?: number;
  listedProperty?: boolean;
  classId?: string | null;
  locationId?: string | null;
  notes?: string | null;
  /** Replaces every book. */
  books?: BookInput[];
}

export interface FromBillLineInput extends Omit<CreateAssetInput, 'name' | 'acquisitionDate' | 'cost' | 'billId' | 'billItemId'> {
  billItemId: string;
  name?: string;
  acquisitionDate?: string;
  /** Overrides the cost taken from the bill line. */
  cost?: number;
  /** The line went to an expense account: post the entry that moves its cost to the asset account. */
  reclass?: boolean;
}

export interface AssetFilters {
  status?: string;
  assetClass?: string;
  search?: string;
  limit?: number;
  cursor?: string | null;
}

export interface DisposeInput {
  date: string;
  proceeds: number;
  depositAccountId?: string | null;
  gainLossAccountId?: string | null;
}

// ============================================================================
// Fixed assets: results and reports
// ============================================================================

export interface PostedPeriod {
  periodEnd: string;
  journalEntryId: string;
  entryNumber: string | null;
  amount: number;
  assets: number;
  /** An entry for exactly these rows existed already (a retry or a concurrent run). */
  alreadyPosted: boolean;
}

export interface TaxBookDisposal {
  book: string;
  stateCode: string | null;
  method: string;
  /** Depreciation taken on the book through the disposal year, section 179 and bonus included. */
  accumulated: number;
  /** The business-use share of the proceeds the gain is figured on. */
  proceeds: number;
  adjustedBasis: number;
  gainOrLoss: number;
  result: 'gain' | 'loss' | 'none';
  ordinaryRecapture: number;
  unrecapturedSection1250: number;
  remainingGain: number;
}

export interface DisposeResult {
  asset: FixedAsset;
  journalEntryId: string;
  entryNumber: string | null;
  proceeds: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  /** Proceeds less net book value; negative for a loss. */
  gainOrLoss: number;
  result: 'gain' | 'loss' | 'none';
  catchUp: PostedPeriod[];
  disposalMonthDepreciation: number;
  taxBooks: TaxBookDisposal[];
}

export interface SkippedPeriod {
  periodEnd: string;
  assets: number;
  amount: number;
  reason: string;
}

export interface DepreciationRunResult {
  through: string;
  posted: PostedPeriod[];
  skipped: SkippedPeriod[];
  fullyDepreciatedAssetIds: string[];
  totalPosted: number;
}

export interface RegisterLine {
  assetId: string;
  assetNumber: string | null;
  name: string;
  assetClass: string | null;
  status: string;
  placedInServiceDate: string;
  disposalDate: string | null;
  disposed: boolean;
  cost: number;
  method: string;
  convention: string;
  recoveryYears: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  accumulatedPosted?: number;
}

export interface RegisterReport {
  asOf: string;
  book: string;
  stateCode: string | null;
  accumulatedThrough: 'month_end' | 'fiscal_year_end';
  lines: RegisterLine[];
  totals: { cost: number; accumulatedDepreciation: number; netBookValue: number; accumulatedPosted?: number };
}

export interface RegisterParams {
  asOf?: string;
  book?: BookKind;
  stateCode?: string;
  includeDisposed?: boolean;
}

export interface MidQuarterAssetLine {
  assetId: string;
  assetNumber: string | null;
  name: string;
  placedInServiceDate: string;
  quarter: number;
  basis: number;
  counted: boolean;
  excludedReason: 'real_property' | 'disposed_in_same_year' | null;
  convention: string;
}

export interface MidQuarterReport {
  /** More than 40% of the year's basis was placed in service in the last quarter. */
  applies: boolean;
  totalBasis: number;
  lastQuarterBasis: number;
  /** 0 to 1. */
  lastQuarterShare: number;
  quarterBasis: [number, number, number, number];
  taxYear: number;
  start: string;
  end: string;
  /** The share of the year's basis in the last quarter above which the mid-quarter convention applies. */
  threshold: number;
  assets: MidQuarterAssetLine[];
}

export interface TaxDepreciationLine {
  assetId: string;
  assetNumber: string | null;
  name: string;
  assetClass: string | null;
  acquisitionDate: string;
  placedInServiceDate: string;
  disposalDate: string | null;
  placedInServiceThisYear: boolean;
  cost: number;
  businessUsePercent: number;
  method: string;
  convention: string;
  recoveryYears: number;
  depreciableBasis: number;
  section179: number;
  bonus: number;
  macrs: number;
  total: number;
  accumulated: number;
  listedProperty: boolean;
  issues: string[];
}

export interface Form4562 {
  part1: {
    totalCostOfSection179Property: number;
    limit: number | null;
    phaseOutThreshold: number | null;
    reduction: number;
    dollarLimit: number | null;
    elected: number;
    deduction: number;
  };
  part2: { bonus: number };
  part3: {
    priorYearAssets: number;
    currentYearAssets: Array<{
      recoveryYears: number;
      convention: string;
      method: string;
      count: number;
      basis: number;
      depreciation: number;
    }>;
    currentYearTotal: number;
  };
  listedProperty: Array<{ assetId: string; name: string; businessUsePercent: number; total: number }>;
  total: number;
}

export interface TaxDepreciationReport {
  taxYear: number;
  start: string;
  end: string;
  book: string;
  stateCode: string | null;
  lines: TaxDepreciationLine[];
  form4562: Form4562;
  midQuarter: MidQuarterReport;
}

export interface TaxDepreciationParams {
  taxYear?: number;
  book?: 'federal' | 'state';
  stateCode?: string;
}

export interface DeMinimisAdvice {
  amount: number;
  date: string;
  hasAfs: boolean;
  /** Per invoice or item; null when the date is before the rule. */
  threshold: number | null;
  applies: boolean;
  advice: 'expense' | 'capitalize';
  /** English text from the server; the UI composes its own from the fields above. */
  explanation: string;
}

export interface DeMinimisInput {
  amount: number;
  hasAfs: boolean;
  date?: string;
}

export const fixedAssetsApi = {
  list: (filters: AssetFilters = {}) =>
    weldbooksApi.get<CursorPage<FixedAssetListItem>>(`/fixed-assets${buildQuery({ ...filters })}`),
  get: (id: string) => weldbooksApi.get<Envelope<FixedAssetDetail>>(`/fixed-assets/${id}`),
  create: (input: CreateAssetInput) => weldbooksApi.post<Envelope<FixedAssetWriteResult>>('/fixed-assets', input),
  update: (id: string, input: UpdateAssetInput) =>
    weldbooksApi.patch<Envelope<FixedAssetWriteResult>>(`/fixed-assets/${id}`, input),
  /** 409 once depreciation has been posted: dispose of the asset instead. */
  remove: (id: string) => weldbooksApi.delete<void>(`/fixed-assets/${id}`),
  dispose: (id: string, input: DisposeInput) =>
    weldbooksApi.post<Envelope<DisposeResult>>(`/fixed-assets/${id}/dispose`, input),
  runDepreciation: (through: string) =>
    weldbooksApi.post<Envelope<DepreciationRunResult>>('/fixed-assets/depreciation/run', { through }),
  fromBillLine: (input: FromBillLineInput) =>
    weldbooksApi.post<Envelope<FromBillLineResult>>('/fixed-assets/from-bill-line', input),
  register: (params: RegisterParams = {}) =>
    weldbooksApi.get<Envelope<RegisterReport>>(`/fixed-assets/register${buildQuery({ ...params })}`),
  taxDepreciation: (params: TaxDepreciationParams = {}) =>
    weldbooksApi.get<Envelope<TaxDepreciationReport>>(`/fixed-assets/tax-depreciation${buildQuery({ ...params })}`),
  deMinimisCheck: (input: DeMinimisInput) =>
    weldbooksApi.post<Envelope<DeMinimisAdvice>>('/fixed-assets/de-minimis-check', input),
};

// ============================================================================
// Payroll journal import
// ============================================================================

export const PAYROLL_CATEGORY_KEYS = [
  'gross_wages',
  'employer_taxes',
  'employer_benefits',
  'reimbursements',
  'owners_draw',
  'employee_taxes',
  'employee_deductions',
  'payroll_liabilities',
  'net_pay',
] as const;
export type PayrollCategoryKey = (typeof PAYROLL_CATEGORY_KEYS)[number];

export interface PayrollCategory {
  key: PayrollCategoryKey;
  /** English label from the server; the UI prefers its own translation. */
  label: string;
  side: 'debit' | 'credit';
  required: boolean;
}

export type PayrollSource = 'csv' | 'gusto';
export type PayrollImportStatus = 'posted' | 'reversed';

export interface PayrollImport {
  id: string;
  createdAt: string;
  entityId: string;
  source: PayrollSource;
  connectionId: string | null;
  externalId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payDate: string;
  /** Category to amount, e.g. `{ gross_wages: 10000, net_pay: 7600 }` (GL imports: account label to net amount). */
  summary: Record<string, number> | null;
  status: PayrollImportStatus;
  journalEntryId: string | null;
  sourceFileName: string | null;
  createdBy: string | null;
}

export interface PayrollJournalLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string | null;
  credit: string | null;
  description: string | null;
}

export interface PayrollImportDetail extends PayrollImport {
  lines: PayrollJournalLine[];
}

export interface PayrollImportFilters {
  status?: PayrollImportStatus;
  source?: PayrollSource;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string | null;
}

export const CSV_DATE_FORMATS = ['auto', 'mdy', 'dmy', 'iso'] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];

/** Which columns of a payroll summary export mean what. */
export interface SummaryColumns {
  payDate: string;
  grossWages: string;
  netPay: string;
  employerTaxes?: string;
  employeeTaxes?: string;
  employeeDeductions?: string;
  employerBenefits?: string;
  reimbursements?: string;
  ownersDraw?: string;
  periodStart?: string;
  periodEnd?: string;
  /** A column whose value tells two payrolls with the same date apart. */
  reference?: string;
}

export interface GlColumns {
  date: string;
  account: string;
  debit: string;
  credit: string;
  memo?: string;
}

export type AccountMapping = Partial<Record<PayrollCategoryKey, string>>;

export interface SummaryCsvMapping {
  shape: 'summary';
  columns: SummaryColumns;
  /** Payroll category to account id. */
  accounts: AccountMapping;
  dateFormat: CsvDateFormat;
}

export interface GlCsvMapping {
  shape: 'gl';
  columns: GlColumns;
  /** The export's account label (or number) to an account id; labels not listed are matched by code or name. */
  accounts: Record<string, string>;
  dateFormat: CsvDateFormat;
}

export type CsvMapping = SummaryCsvMapping | GlCsvMapping;

export interface CsvImportInput {
  csv: string;
  /** Omitted: the entity's saved CSV mapping. */
  mapping?: CsvMapping;
  saveMapping?: boolean;
  periodStart?: string | null;
  periodEnd?: string | null;
  sourceFileName?: string | null;
  /** Mixed into the identity of each payroll; use it to import a payroll again after reversing it. */
  batchLabel?: string | null;
  dryRun?: boolean;
}

export interface ImportedPayroll {
  /** Null for a dry run. */
  importId: string | null;
  payDate: string;
  journalEntryId: string | null;
  entryNumber: string | null;
  summary: Record<string, number>;
  totalDebit: number;
  lines: Array<{ accountId: string; debit: number; credit: number; description?: string | null }>;
}

export interface CsvImportResult {
  shape: 'summary' | 'gl';
  dryRun: boolean;
  imports: ImportedPayroll[];
  /** Payrolls already imported: nothing was posted for them. */
  duplicates: Array<{ payDate: string; importId: string; status: string }>;
  /** Payrolls that could not be posted (a locked period, a missing account). */
  failed: Array<{ payDate: string; error: string }>;
}

export interface CsvProblem {
  row: number;
  message: string;
}

/**
 * The per-row problems of a rejected CSV (a 400 with `error.details.problems`),
 * or null when the failure is something else.
 */
export function csvProblemsFromError(err: unknown): CsvProblem[] | null {
  const body = err && typeof err === 'object' ? (err as { body?: unknown }).body : undefined;
  const details = (body as { error?: { details?: { problems?: unknown } } } | undefined)?.error?.details;
  const problems = details?.problems;
  if (!Array.isArray(problems)) return null;
  const result: CsvProblem[] = [];
  for (const item of problems) {
    if (item && typeof item === 'object' && typeof (item as CsvProblem).row === 'number' && typeof (item as CsvProblem).message === 'string') {
      result.push({ row: (item as CsvProblem).row, message: (item as CsvProblem).message });
    }
  }
  return result.length > 0 ? result : null;
}

export type GustoEnvironment = 'production' | 'demo';
export type PayrollConnectionStatus = 'active' | 'error' | 'disconnected';

/** A Gusto connection as the API shows it: never the access token, only whether one is stored. */
export interface PayrollConnection {
  id: string;
  createdAt: string;
  updatedAt: string;
  entityId: string;
  provider: 'gusto';
  providerCompanyId: string | null;
  accountMapping: Record<string, string> | null;
  status: PayrollConnectionStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  hasCredentials: boolean;
  environment: GustoEnvironment | null;
}

export interface CreateGustoConnectionInput {
  provider: 'gusto';
  accessToken: string;
  companyId: string;
  environment?: GustoEnvironment;
  accountMapping?: AccountMapping;
}

export interface GustoSyncInput {
  from?: string;
  to?: string;
}

export interface GustoSyncResult {
  from: string;
  to: string;
  fetched: number;
  imported: Array<{ externalId: string; payDate: string; importId: string; journalEntryId: string }>;
  skipped: Array<{ externalId: string | null; payDate: string | null; reason: string }>;
  failed: Array<{ externalId: string; payDate: string; error: string }>;
}

export const payrollApi = {
  listImports: (filters: PayrollImportFilters = {}) =>
    weldbooksApi.get<CursorPage<PayrollImport>>(`/payroll/imports${buildQuery({ ...filters })}`),
  getImport: (id: string) => weldbooksApi.get<Envelope<PayrollImportDetail>>(`/payroll/imports/${id}`),
  /** Reverses the payroll's entry (default date: the pay date); the import stays as `reversed`. */
  reverseImport: (id: string, date?: string) =>
    weldbooksApi.delete<Envelope<PayrollImport>>(`/payroll/imports/${id}${buildQuery({ date })}`),
  importCsv: (input: CsvImportInput) => weldbooksApi.post<Envelope<CsvImportResult>>('/payroll/imports/csv', input),
  listCategories: () => weldbooksApi.get<Envelope<PayrollCategory[]>>('/payroll/categories'),
  getCsvMapping: () => weldbooksApi.get<Envelope<CsvMapping | null>>('/payroll/csv-mapping'),
  saveCsvMapping: (mapping: CsvMapping) => weldbooksApi.put<Envelope<CsvMapping>>('/payroll/csv-mapping', mapping),
  listConnections: () => weldbooksApi.get<CursorPage<PayrollConnection>>('/payroll/connections'),
  createConnection: (input: CreateGustoConnectionInput) =>
    weldbooksApi.post<Envelope<PayrollConnection>>('/payroll/connections', input),
  setConnectionMapping: (id: string, accountMapping: AccountMapping) =>
    weldbooksApi.put<Envelope<PayrollConnection>>(`/payroll/connections/${id}/mapping`, { accountMapping }),
  syncConnection: (id: string, input: GustoSyncInput = {}) =>
    weldbooksApi.post<Envelope<GustoSyncResult>>(`/payroll/connections/${id}/sync`, input),
  disconnect: (id: string) => weldbooksApi.delete<void>(`/payroll/connections/${id}`),
};

// ============================================================================
// Fiscal-period calendar
// ============================================================================

export type PlannedPeriodType = 'month' | 'period' | 'quarter' | 'year';

export interface PlannedFiscalPeriod {
  name: string;
  type: PlannedPeriodType;
  startDate: string;
  endDate: string;
  /** 1-12 for months and periods, 1-4 for quarters, null for the year. */
  number: number | null;
  /** Length in weeks for 4-4-5 periods, null otherwise. */
  weeks: number | null;
  /** The id of the stored period with the same dates and type, if there is one. */
  existingId: string | null;
}

export interface FiscalCalendar {
  entityId: string;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  /** `month`: calendar months. `fifty_two_fifty_three`: 4-4-5 week periods. */
  kind: 'month' | 'fifty_two_fifty_three';
  /** 52 or 53 for a 52-53-week year, null for a month-based one. */
  weeks: number | null;
  periods: PlannedFiscalPeriod[];
}

export interface FiscalCalendarParams {
  fiscalYear: number;
  includeQuarters?: boolean;
  includeYear?: boolean;
}

export interface GeneratedFiscalPeriod {
  id: string;
  name: string;
  type: string;
  startDate: string;
  endDate: string;
  status: string;
}

export interface GenerateFiscalPeriodsResult {
  entityId: string;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  kind: 'month' | 'fifty_two_fifty_three';
  weeks: number | null;
  created: GeneratedFiscalPeriod[];
  skipped: Array<{ name: string; startDate: string; endDate: string }>;
}

export const fiscalCalendarApi = {
  calendar: (params: FiscalCalendarParams) =>
    weldbooksApi.get<Envelope<FiscalCalendar>>(
      `/fiscal-periods/calendar${buildQuery({
        fiscalYear: params.fiscalYear,
        includeQuarters: params.includeQuarters ? 'true' : undefined,
        includeYear: params.includeYear ? 'true' : undefined,
      })}`,
    ),
  generate: (params: FiscalCalendarParams) =>
    weldbooksApi.post<Envelope<GenerateFiscalPeriodsResult>>('/fiscal-periods/generate', params),
};

// ============================================================================
// Tax due-date calendar (US)
// ============================================================================

export type TaxDeadlineKind =
  | 'income_tax_return'
  | 'income_tax_extended_return'
  | 'estimated_tax'
  | 'information_return'
  | 'payroll'
  | 'sales_tax';

export interface TaxDeadline {
  /** Stable id for completion tracking. */
  key: string;
  kind: TaxDeadlineKind;
  /** English title from the calendar rules. */
  title: string;
  /** The date to meet: the statutory date moved to the next business day. */
  dueDate: string;
  /** The statutory date before moving. */
  nominalDate: string;
  /** Form or filing, e.g. `f1120s`, `1040es`, `1099_nec`, `941`, `sales_tax`. */
  form: string;
  taxYear?: number;
  periodStart?: string;
  periodEnd?: string;
  agencyId?: string;
  stateCode?: string | null;
  extensionForm?: string;
  /** Shown for information; not something the entity files with a return of its own (payroll items). */
  informational?: boolean;
  note?: string;
  completed: boolean;
  completedAt: string | null;
  completedBy: string | null;
  completionNotes: string | null;
  /** `manual`: marked done by a user. `return`: the sales tax return is filed. */
  completionSource: 'manual' | 'return' | null;
  /** Sales tax deadlines: the return of the period, when one exists. */
  returnId: string | null;
  returnStatus: string | null;
  daysUntilDue: number;
  overdue: boolean;
}

export interface TaxCalendar {
  /** False for entities outside the US. */
  supported: boolean;
  year: number;
  today: string;
  /** Income tax return form of the entity (`sch_c`, `f1065`, `f1120s`, `f1120`, `f990`). */
  form: string | null;
  facts: { hasPayroll: boolean; files1099: boolean; hasBackupWithholding: boolean; agencies: number } | null;
  items: TaxDeadline[];
  message?: string;
}

export interface CompleteDeadlineInput {
  deadlineKey: string;
  dueDate: string;
  notes?: string;
}

export interface DeadlineCompletion {
  id: string;
  deadlineKey: string;
  dueDate: string;
  completedBy: string | null;
  completedAt: string;
  notes: string | null;
}

export const taxCalendarApi = {
  get: (year?: number) => weldbooksApi.get<Envelope<TaxCalendar>>(`/tax-calendar${buildQuery({ year })}`),
  complete: (input: CompleteDeadlineInput) =>
    weldbooksApi.post<Envelope<DeadlineCompletion>>('/tax-calendar/complete', input),
  reopen: (deadlineKey: string) =>
    weldbooksApi.delete<void>(`/tax-calendar/complete/${encodeURIComponent(deadlineKey)}`),
};
