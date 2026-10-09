/**
 * Pure helpers behind the report pages: the query a toolbar state stands for,
 * the heading of a value column, and the row models of the financial
 * statements (built from the report JSON so the page, the tests and the
 * table renderer agree).
 */
import type {
  BalanceSheetReport,
  ProfitLossReport,
  ProfitLossSection,
  ReportAccountRow,
  ReportBasis,
  ReportColumn,
  ReportCompare,
  ReportDelta,
  ReportPeriods,
  ReportQuery,
  TrialBalanceReport,
  ValueSet,
} from '@/lib/weldbooks/report-types';

// ---------------------------------------------------------------------------
// Toolbar state
// ---------------------------------------------------------------------------

/** What the toolbar holds. An empty string means "the server's default". */
export interface ReportParams {
  from: string;
  to: string;
  asOf: string;
  basis: '' | ReportBasis;
  compare: '' | ReportCompare;
  periods: '' | ReportPeriods;
  classId: string;
  locationId: string;
}

export const EMPTY_REPORT_PARAMS: ReportParams = {
  from: '',
  to: '',
  asOf: '',
  basis: '',
  compare: '',
  periods: '',
  classId: '',
  locationId: '',
};

/** A comparison and a month or quarter split can't be combined: choosing one clears the other. */
export function applyParamsPatch(current: ReportParams, patch: Partial<ReportParams>): ReportParams {
  const next = { ...current, ...patch };
  if (patch.compare) next.periods = '';
  if (patch.periods) next.compare = '';
  return next;
}

/** The request the toolbar state stands for; empty values are left out. */
export function toReportQuery(params: ReportParams): ReportQuery {
  const query: ReportQuery = {};
  if (params.from) query.from = params.from;
  if (params.to) query.to = params.to;
  if (params.asOf) query.asOf = params.asOf;
  if (params.basis) query.basis = params.basis;
  if (params.compare) query.compare = params.compare;
  if (params.periods) query.periods = params.periods;
  if (params.classId) query.classId = params.classId;
  if (params.locationId) query.locationId = params.locationId;
  return query;
}

// ---------------------------------------------------------------------------
// Column headings
// ---------------------------------------------------------------------------

export interface HeadingLabels {
  total: string;
  /** `Q{n} {year}` */
  quarter: string;
  /** `P{n} {year}`: a period of a 52-53-week year */
  period: string;
}

export interface HeadingFormatters {
  formatDate: (value: string) => string;
  /** `YYYY-MM-01` to "March 2026" */
  formatMonth: (value: string) => string;
}

/** Heading of a value column: month, quarter, period or the date range it covers. */
export function columnHeading(column: ReportColumn, labels: HeadingLabels, format: HeadingFormatters): string {
  if (column.key === 'total') return labels.total;
  if (/^\d{4}-\d{2}$/.test(column.key)) return format.formatMonth(`${column.key}-01`);
  const quarter = /^(\d{4})-Q([1-4])$/.exec(column.key);
  if (quarter) return labels.quarter.replace('{n}', quarter[2]).replace('{year}', quarter[1]);
  const period = /^(\d{4})-P(\d{1,2})$/.exec(column.key);
  if (period) return labels.period.replace('{n}', String(Number(period[2]))).replace('{year}', period[1]);
  if (column.from && column.from !== column.to) return `${format.formatDate(column.from)} – ${format.formatDate(column.to)}`;
  return format.formatDate(column.to);
}

/** True for the two-column layout of a comparison (`current` and `prior`). */
export function isComparing(columns: readonly ReportColumn[]): boolean {
  return columns.length === 2 && columns[1].key === 'prior';
}

// ---------------------------------------------------------------------------
// Row models
// ---------------------------------------------------------------------------

export type RowKind = 'section' | 'account' | 'subtotal' | 'total';

export interface ReportRowModel {
  key: string;
  kind: RowKind;
  label: string;
  code?: string | null;
  depth: number;
  values: Record<string, string>;
  delta?: ReportDelta;
  /** The chart account of the row: its label links to the account's ledger. Absent on calculated rows. */
  accountId?: string | null;
}

function section(key: string, label: string): ReportRowModel {
  return { key: `section-${key}`, kind: 'section', label, depth: 0, values: {} };
}

function accountRow(key: string, row: ReportAccountRow): ReportRowModel {
  return {
    key: `${key}-${row.accountId ?? row.accountSubtype ?? row.accountName}`,
    kind: 'account',
    label: row.accountName,
    code: row.accountCode || null,
    depth: 1,
    values: row.values,
    delta: row.delta,
    accountId: row.virtual ? null : row.accountId,
  };
}

function totalRow(key: string, kind: 'subtotal' | 'total', label: string, set: ValueSet): ReportRowModel {
  return { key: `${kind}-${key}`, kind, label, depth: 0, values: set.values, delta: set.delta };
}

export interface ProfitLossLabels {
  income: string;
  totalIncome: string;
  costOfGoodsSold: string;
  totalCostOfGoodsSold: string;
  grossProfit: string;
  expenses: string;
  totalExpenses: string;
  netOperatingIncome: string;
  otherIncome: string;
  totalOtherIncome: string;
  otherExpenses: string;
  totalOtherExpenses: string;
  netOtherIncome: string;
  netIncome: string;
}

/**
 * The profit and loss statement as rows: income, cost of goods sold and gross
 * profit, expenses and net operating income, other income and expenses, net
 * income. Empty blocks below the operating line are left out.
 */
export function profitLossRows(report: ProfitLossReport, labels: ProfitLossLabels): ReportRowModel[] {
  const accounts = [...report.revenue, ...report.expenses];
  const members = (name: ProfitLossSection) => accounts.filter((a) => a.section === name);
  const rows: ReportRowModel[] = [];

  const block = (name: ProfitLossSection, title: string, totalLabel: string, total: ValueSet, always: boolean) => {
    const list = members(name);
    if (list.length === 0 && !always) return;
    rows.push(section(name, title), ...list.map((a) => accountRow(name, a)), totalRow(name, 'subtotal', totalLabel, total));
  };

  block('income', labels.income, labels.totalIncome, report.totals.income, true);
  block('cost_of_goods_sold', labels.costOfGoodsSold, labels.totalCostOfGoodsSold, report.totals.costOfGoodsSold, false);
  if (members('cost_of_goods_sold').length > 0) rows.push(totalRow('gross', 'total', labels.grossProfit, report.totals.grossProfit));
  block('expense', labels.expenses, labels.totalExpenses, report.totals.expenses, true);
  rows.push(totalRow('operating', 'total', labels.netOperatingIncome, report.totals.netOperatingIncome));
  if (members('other_income').length > 0 || members('other_expense').length > 0) {
    block('other_income', labels.otherIncome, labels.totalOtherIncome, report.totals.otherIncome, false);
    block('other_expense', labels.otherExpenses, labels.totalOtherExpenses, report.totals.otherExpenses, false);
    rows.push(totalRow('other', 'total', labels.netOtherIncome, report.totals.netOtherIncome));
  }
  rows.push(totalRow('net', 'total', labels.netIncome, report.totals.netProfit));
  return rows;
}

export interface BalanceSheetLabels {
  assets: string;
  totalAssets: string;
  liabilities: string;
  totalLiabilities: string;
  equity: string;
  totalEquity: string;
  totalLiabilitiesAndEquity: string;
  /** Names of the two calculated equity rows, by `accountSubtype`. */
  calculated: Record<string, string>;
}

/** The balance sheet as rows. The calculated equity rows carry no account link. */
export function balanceSheetRows(report: BalanceSheetReport, labels: BalanceSheetLabels): ReportRowModel[] {
  const named = (row: ReportAccountRow): ReportAccountRow =>
    row.virtual && row.accountSubtype && labels.calculated[row.accountSubtype]
      ? { ...row, accountName: labels.calculated[row.accountSubtype] }
      : row;
  return [
    section('assets', labels.assets),
    ...report.assets.map((a) => accountRow('asset', a)),
    totalRow('assets', 'total', labels.totalAssets, report.totals.assets),
    section('liabilities', labels.liabilities),
    ...report.liabilities.map((a) => accountRow('liability', a)),
    totalRow('liabilities', 'subtotal', labels.totalLiabilities, report.totals.liabilities),
    section('equity', labels.equity),
    ...report.equity.map((a) => accountRow('equity', named(a))),
    totalRow('equity', 'subtotal', labels.totalEquity, report.totals.equity),
    totalRow('liabilitiesAndEquity', 'total', labels.totalLiabilitiesAndEquity, report.totals.liabilitiesAndEquity),
  ];
}

/** The trial balance as rows with a Debit and a Credit column (a single period) or the comparison columns. */
export function trialBalanceRows(
  report: TrialBalanceReport,
  labels: { total: string },
): { rows: ReportRowModel[]; debitCredit: boolean } {
  const debitCredit = !isComparing(report.columns);
  const rows: ReportRowModel[] = report.accounts.map((a) => ({
    key: `account-${a.accountId}`,
    kind: 'account' as const,
    label: a.accountName,
    code: a.accountCode,
    depth: 0,
    values: debitCredit ? { debit: a.debitBalance, credit: a.creditBalance } : a.values,
    delta: debitCredit ? undefined : a.delta,
    accountId: a.accountId,
  }));
  if (debitCredit) {
    const sum = (key: 'debitBalance' | 'creditBalance') => report.accounts.reduce((total, a) => total + Number(a[key]), 0);
    rows.push({
      key: 'total',
      kind: 'total',
      label: labels.total,
      depth: 0,
      values: { debit: sum('debitBalance').toFixed(2), credit: sum('creditBalance').toFixed(2) },
    });
  }
  return { rows, debitCredit };
}

/** Aged reports answer a bucket as a plain total or as `{ total, count }`. */
export function bucketTotal(value: string | { total: string; count: number } | undefined): string {
  if (value === undefined) return '0.00';
  return typeof value === 'string' ? value : value.total;
}

export function bucketCount(
  value: string | { total: string; count: number } | undefined,
  counts: Record<string, number> | undefined,
  key: string,
): number | null {
  if (value !== undefined && typeof value !== 'string') return value.count;
  return counts?.[key] ?? null;
}
