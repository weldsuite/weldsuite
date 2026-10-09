/**
 * Shapes of `GET /api/accounting-reports/*` (apps/workers/books-api,
 * services/accounting-reports.ts, accounting-report-export.ts and
 * accounting-tax-worksheet.ts). Amounts are decimal strings (`"1234.50"`).
 */

export type ReportBasis = 'accrual' | 'cash';
export type ReportCompare = 'prior_period' | 'prior_year';
export type ReportPeriods = 'months' | 'quarters';
export type ReportFormat = 'json' | 'csv' | 'print';

export interface DateRange {
  from: string;
  to: string;
}

export interface ReportColumn {
  key: string;
  label: string;
  /** Null on point-in-time columns (balance sheet): everything up to `to`. */
  from: string | null;
  to: string;
}

export interface ReportDelta {
  amount: string;
  /** Null when the prior amount is zero. */
  percent: number | null;
}

export interface ValueSet {
  values: Record<string, string>;
  /** Present on comparative reports. */
  delta?: ReportDelta;
}

/** Everything the financial report endpoints take. Empty values are left out of the request. */
export interface ReportQuery {
  basis?: ReportBasis;
  from?: string;
  to?: string;
  asOf?: string;
  compare?: ReportCompare;
  periods?: ReportPeriods;
  classId?: string;
  locationId?: string;
  /** General ledger. */
  accountId?: string;
  page?: number;
  pageSize?: number;
  /** Tax worksheet: the fiscal year, named for the calendar year it ends in. */
  year?: number;
  includeZero?: boolean;
}

export type ReportName =
  | 'profit-loss'
  | 'balance-sheet'
  | 'trial-balance'
  | 'general-ledger'
  | 'cash-flow'
  | 'aged-receivables'
  | 'aged-payables'
  | 'tax-worksheet';

// ---------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------

export type ProfitLossSection = 'income' | 'cost_of_goods_sold' | 'expense' | 'other_income' | 'other_expense';

export interface ReportAccountRow extends ValueSet {
  /** Null on a calculated row (retained earnings, net income). */
  accountId: string | null;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  normalSide: 'debit' | 'credit';
  /** Profit and loss: the block of the statement the account belongs to. */
  section?: ProfitLossSection;
  /** A computed row, not a chart account: no link to an account. */
  virtual?: boolean;
  totalDebit: string;
  totalCredit: string;
  balance: string;
}

export interface ProfitLossReport {
  basis: ReportBasis;
  period: DateRange;
  columns: ReportColumn[];
  revenue: ReportAccountRow[];
  expenses: ReportAccountRow[];
  totalRevenue: string;
  totalExpenses: string;
  netProfit: string;
  totals: Record<
    | 'income'
    | 'costOfGoodsSold'
    | 'grossProfit'
    | 'expenses'
    | 'netOperatingIncome'
    | 'otherIncome'
    | 'otherExpenses'
    | 'netOtherIncome'
    | 'totalRevenue'
    | 'totalExpenses'
    | 'netProfit',
    ValueSet
  >;
}

export interface BalanceSheetReport {
  basis: ReportBasis;
  asOf: string;
  columns: ReportColumn[];
  assets: ReportAccountRow[];
  liabilities: ReportAccountRow[];
  equity: ReportAccountRow[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  totalLiabilitiesAndEquity: string;
  difference: string;
  isBalanced: boolean;
  totals: Record<'assets' | 'liabilities' | 'equity' | 'liabilitiesAndEquity', ValueSet>;
}

export interface TrialBalanceRow extends ValueSet {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  totalDebit: string;
  totalCredit: string;
  debitBalance: string;
  creditBalance: string;
}

export interface TrialBalanceReport {
  basis: ReportBasis;
  period: DateRange;
  columns: ReportColumn[];
  accounts: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  isBalanced: boolean;
}

export interface GeneralLedgerLine {
  id: string;
  journalEntryId: string | null;
  entryNumber: string | null;
  entryDate: string;
  entryStatus: string;
  description: string | null;
  sourceType: string | null;
  contactId: string | null;
  paymentId: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
}

export interface GeneralLedgerReport {
  basis: ReportBasis;
  account: { id: string; code: string; name: string; normalSide: 'debit' | 'credit' };
  period: DateRange;
  /** Debit minus credit before the period. */
  openingBalance: string;
  closingBalance: string;
  totalDebit: string;
  totalCredit: string;
  lines: GeneralLedgerLine[];
  pagination: { page: number; pageSize: number; totalCount: number; totalPages: number; hasMore: boolean };
}

export interface CashFlowMonth {
  /** `YYYY-MM` */
  month: string;
  inflows: string;
  outflows: string;
  net: string;
}

export interface CashFlowTotals {
  inflows: string;
  outflows: string;
  net: string;
}

export interface CashFlowReport {
  period: DateRange;
  monthly: CashFlowMonth[];
  totals: CashFlowTotals;
  /** Present with `compare`. */
  comparison?: {
    mode: ReportCompare;
    period: DateRange;
    monthly: CashFlowMonth[];
    totals: CashFlowTotals;
    delta: Record<keyof CashFlowTotals, ReportDelta>;
  };
}

// ---------------------------------------------------------------------------
// Aging
// ---------------------------------------------------------------------------

export const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgedDocument {
  id: string;
  number: string | null;
  contactId: string;
  contactName: string | null;
  issueDate: string;
  dueDate: string;
  daysPastDue: number;
  bucket: AgingBucket;
  /** Signed: credit notes reduce what is open. */
  balance: string;
}

export type AgedContact = { contactId: string; contactName: string | null; total: string } & Record<AgingBucket, string>;

/**
 * Aged receivables answer each bucket as `{ total, count }`; aged payables as
 * the plain total with the counts in `bucketCounts`.
 */
export interface AgedReport {
  asOf: string;
  buckets: Record<AgingBucket, string | { total: string; count: number }>;
  bucketCounts?: Record<AgingBucket, number>;
  total: string;
  contacts: AgedContact[];
  documents: AgedDocument[];
}

// ---------------------------------------------------------------------------
// Tax worksheet (US)
// ---------------------------------------------------------------------------

export type TaxLineSectionKey =
  | 'income'
  | 'other_income'
  | 'cogs'
  | 'deduction'
  | 'other_deduction'
  | 'not_deductible'
  | 'balance_sheet'
  | 'equity';

export interface TaxWorksheetAccount {
  accountId: string;
  code: string;
  name: string;
  type: string;
  amount: string;
  /** Balance sheet accounts: the balance at the start of the fiscal year. */
  beginningAmount?: string;
}

export interface TaxWorksheetLine {
  code: string;
  line: string;
  label: string;
  section: TaxLineSectionKey;
  /** The side `amount` is positive on. */
  side: 'credit' | 'debit';
  amount: string;
  beginningAmount?: string;
  /** Only part of the book amount counts (meals: 50). */
  deductiblePercent?: number;
  deductibleAmount?: string;
  nonDeductibleAmount?: string;
  /** Where the non-deductible part is reported, when the form has such a line. */
  nonDeductibleLine?: string;
  accounts: TaxWorksheetAccount[];
}

export interface TaxWorksheetSection {
  key: TaxLineSectionKey;
  label: string;
  lines: TaxWorksheetLine[];
  /** Null where the lines mix assets and liabilities. */
  total: string | null;
}

export interface TaxWorksheetUnmapped {
  accountId: string;
  code: string;
  name: string;
  type: string;
  taxLine: string | null;
  /** `none`: no line. `other_form`: a line of another return. `unknown_line`: a line the catalog doesn't have. */
  reason: 'none' | 'other_form' | 'unknown_line';
  amount: string;
  beginningAmount?: string;
}

export interface TaxWorksheet {
  form: string;
  formLabel: string;
  taxYear: number;
  basis: ReportBasis;
  period: DateRange;
  entity: { id: string; name: string; legalName: string | null; entityType: string | null; taxClassification: string | null };
  sections: TaxWorksheetSection[];
  unmapped: TaxWorksheetUnmapped[];
  summary: {
    netIncomePerBooks: string;
    totalIncome: string;
    totalOtherIncome: string;
    totalCostOfGoodsSold: string;
    totalDeductions: string;
    netIncomeFromLines: string;
    notDeductibleTotal: string;
    unmappedNetIncome: string;
    reconciles: boolean;
  };
}

// ---------------------------------------------------------------------------
// Print document (`format=print`)
// ---------------------------------------------------------------------------

export type PrintRowKind = 'section' | 'account' | 'subtotal' | 'total' | 'note';

export interface PrintTableColumn {
  key: string;
  label: string;
  /** Right-aligned number column. */
  numeric: boolean;
}

export interface PrintTableRow {
  kind: PrintRowKind;
  depth: number;
  label: string;
  code?: string | null;
  values: Record<string, string | number | null>;
}

export interface PrintTable {
  report: string;
  title: string;
  /** Rows carry a code worth its own column. */
  hasCode: boolean;
  columns: PrintTableColumn[];
  rows: PrintTableRow[];
  notes: string[];
}

export interface PrintEntity {
  name: string;
  legalName: string | null;
  dba: string | null;
  address: unknown;
  /** Business tax ID as printed on documents (an EIN, a VAT number); never an SSN. */
  taxId: string | null;
  jurisdictionCode: string;
  locale: string;
  timezone: string | null;
}

export interface ReportPrintDocument {
  kind: 'report';
  report: string;
  title: string;
  paper: 'letter' | 'a4';
  entity: PrintEntity;
  basis: ReportBasis | null;
  periodLabel: string;
  currency: string;
  generatedAt: string;
  table: PrintTable;
}
