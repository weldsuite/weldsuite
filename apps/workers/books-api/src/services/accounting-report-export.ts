/**
 * Export of the financial reports: a flat table per report, rendered as CSV
 * or as a print-ready document the platform turns into a PDF client-side.
 *
 * Each report builder (accounting-reports.ts, accounting-tax-worksheet.ts)
 * returns its JSON; the `…Table` functions here lay that JSON out as rows and
 * value columns, so every report exports the same way.
 */

import type {
  AccountRow,
  AgedReport,
  BalanceSheetReport,
  GeneralLedgerReport,
  ProfitLossReport,
  TrialBalanceReport,
  ValueSet,
} from './accounting-reports';
import type { ReportColumn } from './accounting-report-periods';

export interface ReportTableColumn {
  key: string;
  label: string;
  /** Right-aligned number column. */
  numeric: boolean;
}

export type ReportRowKind = 'section' | 'account' | 'subtotal' | 'total' | 'note';

export interface ReportTableRow {
  kind: ReportRowKind;
  depth: number;
  label: string;
  code?: string | null;
  values: Record<string, string | number | null>;
}

export interface ReportTable {
  report: string;
  title: string;
  /** Rows carry an account/line code worth its own column. */
  hasCode: boolean;
  columns: ReportTableColumn[];
  rows: ReportTableRow[];
  notes: string[];
}

export interface ReportMeta {
  entityName: string;
  basis?: string | null;
  /** Human-readable period, e.g. `2026-07-01 to 2026-07-31` or `As of 2026-07-31`. */
  periodLabel: string;
  currency: string;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** A text a spreadsheet would run as a formula gets a leading quote. */
function neutralize(value: string): string {
  const risky = /^[=+@\t\r]/.test(value) || (/^-/.test(value) && !/^-?\d+(\.\d+)?$/.test(value));
  return risky ? `'${value}` : value;
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvText(value: string): string {
  return quote(neutralize(value));
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? String(value) : csvText(value);
}

export function toCsv(table: ReportTable, meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(csvText(table.title));
  lines.push(csvText(meta.entityName));
  if (meta.basis) lines.push(csvText(`Basis: ${meta.basis === 'cash' ? 'Cash' : 'Accrual'}`));
  lines.push(csvText(meta.periodLabel));
  lines.push(csvText(`Amounts in ${meta.currency}`));
  lines.push('');

  const header = [...(table.hasCode ? ['Code'] : []), 'Name', ...table.columns.map((c) => c.label)];
  lines.push(header.map(csvText).join(','));

  for (const row of table.rows) {
    const indent = '  '.repeat(row.depth);
    const cells = [
      ...(table.hasCode ? [csvCell(row.code ?? '')] : []),
      // The guard goes on the label itself: the indent in front would hide it.
      quote(`${indent}${neutralize(row.label)}`),
      ...table.columns.map((c) => csvCell(row.values[c.key] ?? null)),
    ];
    lines.push(cells.join(','));
  }

  if (table.notes.length > 0) {
    lines.push('');
    for (const note of table.notes) lines.push(csvText(note));
  }
  // UTF-8 byte order mark so Excel reads accents correctly; CRLF per RFC 4180.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    },
  });
}

// ---------------------------------------------------------------------------
// Print document
// ---------------------------------------------------------------------------

export interface PrintEntity {
  name: string;
  legalName: string | null;
  dba: string | null;
  address: unknown;
  /** The business tax ID as printed on documents (EIN, VAT number); never an SSN. */
  taxId: string | null;
  jurisdictionCode: string;
  locale: string;
  timezone: string | null;
}

export function buildPrintDocument(table: ReportTable, meta: ReportMeta, entity: PrintEntity, generatedAt = new Date()) {
  return {
    kind: 'report' as const,
    report: table.report,
    title: table.title,
    paper: entity.jurisdictionCode === 'US' ? ('letter' as const) : ('a4' as const),
    entity,
    basis: meta.basis ?? null,
    periodLabel: meta.periodLabel,
    currency: meta.currency,
    generatedAt: generatedAt.toISOString(),
    table,
  };
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

const BASIS_LABEL: Record<string, string> = { cash: 'Cash basis', accrual: 'Accrual basis' };

function valueColumns(columns: ReportColumn[], withDelta: boolean): ReportTableColumn[] {
  const out: ReportTableColumn[] = columns.map((c) => ({ key: c.key, label: c.label, numeric: true }));
  if (withDelta) {
    out.push({ key: 'delta', label: 'Change', numeric: true }, { key: 'deltaPercent', label: 'Change %', numeric: true });
  }
  return out;
}

function withDeltaValues(set: ValueSet | { values: Record<string, string>; delta?: ValueSet['delta'] }) {
  const values: Record<string, string | number | null> = { ...set.values };
  if (set.delta) {
    values.delta = set.delta.amount;
    values.deltaPercent = set.delta.percent === null ? null : `${set.delta.percent}%`;
  }
  return values;
}

const hasDelta = (columns: ReportColumn[]) => columns.length === 2 && columns[1].key === 'prior';

function accountLine(row: AccountRow, depth = 1): ReportTableRow {
  return { kind: 'account', depth, label: row.accountName, code: row.accountCode || null, values: withDeltaValues(row) };
}

function totalLine(kind: 'subtotal' | 'total', label: string, set: ValueSet, depth = 0): ReportTableRow {
  return { kind, depth, label, values: withDeltaValues(set) };
}

function sectionLine(label: string): ReportTableRow {
  return { kind: 'section', depth: 0, label, values: {} };
}

export function basisLabel(basis: string | null | undefined): string | null {
  return basis ? (BASIS_LABEL[basis] ?? basis) : null;
}

// ---------------------------------------------------------------------------
// Tables per report
// ---------------------------------------------------------------------------

export function profitLossTable(report: ProfitLossReport): ReportTable {
  const rows: ReportTableRow[] = [];
  const all = [...report.revenue, ...report.expenses];
  const block = (label: string, section: string, totalLabel: string, total: ValueSet) => {
    const members = all.filter((r) => r.section === section);
    if (members.length === 0 && section !== 'income' && section !== 'expense') return;
    rows.push(sectionLine(label), ...members.map((r) => accountLine(r)), totalLine('subtotal', totalLabel, total));
  };

  block('Income', 'income', 'Total income', report.totals.income);
  block('Cost of goods sold', 'cost_of_goods_sold', 'Total cost of goods sold', report.totals.costOfGoodsSold);
  if (all.some((r) => r.section === 'cost_of_goods_sold')) rows.push(totalLine('total', 'Gross profit', report.totals.grossProfit));
  block('Expenses', 'expense', 'Total expenses', report.totals.expenses);
  rows.push(totalLine('total', 'Net operating income', report.totals.netOperatingIncome));
  if (all.some((r) => r.section === 'other_income' || r.section === 'other_expense')) {
    block('Other income', 'other_income', 'Total other income', report.totals.otherIncome);
    block('Other expenses', 'other_expense', 'Total other expenses', report.totals.otherExpenses);
    rows.push(totalLine('total', 'Net other income', report.totals.netOtherIncome));
  }
  rows.push(totalLine('total', 'Net income', report.totals.netProfit));

  return {
    report: 'profit_loss',
    title: 'Profit and loss',
    hasCode: true,
    columns: valueColumns(report.columns, hasDelta(report.columns)),
    rows,
    notes: [],
  };
}

export function balanceSheetTable(report: BalanceSheetReport): ReportTable {
  const rows: ReportTableRow[] = [
    sectionLine('Assets'),
    ...report.assets.map((r) => accountLine(r)),
    totalLine('total', 'Total assets', report.totals.assets),
    sectionLine('Liabilities'),
    ...report.liabilities.map((r) => accountLine(r)),
    totalLine('subtotal', 'Total liabilities', report.totals.liabilities),
    sectionLine('Equity'),
    ...report.equity.map((r) => accountLine(r)),
    totalLine('subtotal', 'Total equity', report.totals.equity),
    totalLine('total', 'Total liabilities and equity', report.totals.liabilitiesAndEquity),
  ];
  const notes = report.isBalanced ? [] : [`Assets and liabilities plus equity differ by ${report.difference}.`];
  return {
    report: 'balance_sheet',
    title: 'Balance sheet',
    hasCode: true,
    columns: valueColumns(report.columns, hasDelta(report.columns)),
    rows,
    notes,
  };
}

export function trialBalanceTable(report: TrialBalanceReport): ReportTable {
  const comparison = hasDelta(report.columns);
  const columns: ReportTableColumn[] = comparison
    ? valueColumns(report.columns, true)
    : [
        { key: 'debit', label: 'Debit', numeric: true },
        { key: 'credit', label: 'Credit', numeric: true },
      ];
  const rows: ReportTableRow[] = report.accounts.map((a) => ({
    kind: 'account' as const,
    depth: 0,
    label: a.accountName,
    code: a.accountCode || null,
    values: comparison ? withDeltaValues(a) : { debit: a.debitBalance, credit: a.creditBalance },
  }));
  if (!comparison) {
    const debit = report.accounts.reduce((t, a) => t + Number(a.debitBalance), 0);
    const credit = report.accounts.reduce((t, a) => t + Number(a.creditBalance), 0);
    rows.push({ kind: 'total', depth: 0, label: 'Total', values: { debit: debit.toFixed(2), credit: credit.toFixed(2) } });
  }
  return { report: 'trial_balance', title: 'Trial balance', hasCode: true, columns, rows, notes: [] };
}

export function generalLedgerTable(report: GeneralLedgerReport): ReportTable {
  const columns: ReportTableColumn[] = [
    { key: 'date', label: 'Date', numeric: false },
    { key: 'entry', label: 'Entry', numeric: false },
    { key: 'debit', label: 'Debit', numeric: true },
    { key: 'credit', label: 'Credit', numeric: true },
    { key: 'balance', label: 'Balance', numeric: true },
  ];
  const rows: ReportTableRow[] = [
    { kind: 'section', depth: 0, label: 'Opening balance', values: { balance: report.openingBalance } },
    ...report.lines.map((l) => ({
      kind: 'account' as const,
      depth: 0,
      label: l.description ?? '',
      values: {
        date: new Date(l.entryDate).toISOString().slice(0, 10),
        entry: l.entryNumber ?? '',
        debit: l.debit,
        credit: l.credit,
        balance: l.runningBalance,
      },
    })),
    {
      kind: 'total',
      depth: 0,
      label: 'Closing balance',
      values: { debit: report.totalDebit, credit: report.totalCredit, balance: report.closingBalance },
    },
  ];
  return {
    report: 'general_ledger',
    title: `General ledger: ${report.account.code} ${report.account.name}`.trim(),
    hasCode: false,
    columns,
    rows,
    notes: report.pagination.hasMore ? ['Only the lines of the requested page are listed.'] : [],
  };
}

export function cashFlowTable(report: {
  monthly: Array<{ month: string; inflows: string; outflows: string; net: string }>;
  totals: { inflows: string; outflows: string; net: string };
}): ReportTable {
  return {
    report: 'cash_flow',
    title: 'Cash flow',
    hasCode: false,
    columns: [
      { key: 'inflows', label: 'Inflows', numeric: true },
      { key: 'outflows', label: 'Outflows', numeric: true },
      { key: 'net', label: 'Net', numeric: true },
    ],
    rows: [
      ...report.monthly.map((m) => ({
        kind: 'account' as const,
        depth: 0,
        label: m.month,
        values: { inflows: m.inflows, outflows: m.outflows, net: m.net },
      })),
      { kind: 'total', depth: 0, label: 'Total', values: { ...report.totals } },
    ],
    notes: [],
  };
}

export function revenueByCustomerTable(report: {
  customers: Array<{ contactName: string | null; contactId: string; totalRevenue: string }>;
  grandTotal: string;
}): ReportTable {
  return {
    report: 'revenue_by_customer',
    title: 'Revenue by customer',
    hasCode: false,
    columns: [{ key: 'revenue', label: 'Revenue', numeric: true }],
    rows: [
      ...report.customers.map((c) => ({
        kind: 'account' as const,
        depth: 0,
        label: c.contactName ?? c.contactId,
        values: { revenue: c.totalRevenue },
      })),
      { kind: 'total', depth: 0, label: 'Total', values: { revenue: report.grandTotal } },
    ],
    notes: [],
  };
}

export function expenseByCategoryTable(report: {
  categories: Array<{ accountCode: string; accountName: string; totalExpense: string }>;
  grandTotal: string;
}): ReportTable {
  return {
    report: 'expense_by_category',
    title: 'Expenses by category',
    hasCode: true,
    columns: [{ key: 'expense', label: 'Expense', numeric: true }],
    rows: [
      ...report.categories.map((c) => ({
        kind: 'account' as const,
        depth: 0,
        label: c.accountName,
        code: c.accountCode,
        values: { expense: c.totalExpense },
      })),
      { kind: 'total', depth: 0, label: 'Total', values: { expense: report.grandTotal } },
    ],
    notes: [],
  };
}

export function agedTable(report: AgedReport, kind: 'receivables' | 'payables'): ReportTable {
  const buckets = ['current', '1-30', '31-60', '61-90', '90+'] as const;
  return {
    report: kind === 'receivables' ? 'aged_receivables' : 'aged_payables',
    title: kind === 'receivables' ? 'Aged receivables' : 'Aged payables',
    hasCode: false,
    columns: [...buckets.map((b) => ({ key: b, label: b === 'current' ? 'Current' : `${b} days`, numeric: true })), { key: 'total', label: 'Total', numeric: true }],
    rows: [
      ...report.contacts.map((c) => ({
        kind: 'account' as const,
        depth: 0,
        label: c.contactName ?? c.contactId,
        values: { current: c.current, '1-30': c['1-30'], '31-60': c['31-60'], '61-90': c['61-90'], '90+': c['90+'], total: c.total },
      })),
      {
        kind: 'total',
        depth: 0,
        label: 'Total',
        values: {
          ...Object.fromEntries(buckets.map((b) => [b, report.buckets[b].total])),
          total: report.total,
        },
      },
    ],
    notes: [`Open documents as of ${report.asOf}.`],
  };
}
