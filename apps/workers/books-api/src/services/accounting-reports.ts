/**
 * Report builders: turn ledger totals into the JSON the report routes return.
 *
 * Every report is built from a `Ledger` (accrual or cash, see
 * accounting-reports-basis.ts) and a list of columns. A single-period report
 * has one column (`current`), a comparative one two (`current`, `prior`), a
 * split one a column per month or quarter plus `total`. Each row carries
 * `values` by column key; comparative rows also carry `delta`. The scalar
 * fields older clients read (`balance`, `totalRevenue`, ...) are the primary
 * column: `current`, else `total`.
 */

import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { addDays, diffDays } from '@weldsuite/books-domain/us-compliance/dates';
import {
  parseReportDate,
  type AggregateRow,
  type Ledger,
  type LedgerAccount,
  type LedgerRange,
} from './accounting-reports-basis';
import type { DateRange, ReportColumn } from './accounting-report-periods';
import { roundMoney } from './accounting-posting';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export interface Delta {
  amount: string;
  percent: number | null;
}

export interface ValueSet {
  values: Record<string, string>;
  delta?: Delta;
}

export const money = (value: number): string => {
  const rounded = roundMoney(value);
  return (Math.abs(rounded) < 0.005 ? 0 : rounded).toFixed(2);
};

export function deltaOf(current: number, prior: number): Delta {
  return {
    amount: money(current - prior),
    percent: Math.abs(prior) < 0.005 ? null : Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10,
  };
}

export function columnRange(column: ReportColumn): LedgerRange {
  return {
    from: column.from ? parseReportDate(column.from, 'start') : null,
    to: parseReportDate(column.to, 'end'),
  };
}

/** The column scalar fields describe: `current`, else `total`, else the first. */
export function primaryColumn(columns: ReportColumn[]): ReportColumn {
  return columns.find((c) => c.key === 'current') ?? columns.find((c) => c.key === 'total') ?? columns[0];
}

export function isComparison(columns: ReportColumn[]): boolean {
  return columns.length === 2 && columns[1].key === 'prior';
}

/** The latest date any column reaches. */
export function latestDate(columns: ReportColumn[]): Date {
  return columns.map((c) => columnRange(c).to).reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

type TotalsByColumn = Map<string, Map<string, { debit: number; credit: number }>>;

async function totalsByColumn(
  ledger: Ledger,
  columns: ReportColumn[],
  opts: { accountTypes?: string[] },
): Promise<TotalsByColumn> {
  const entries = await Promise.all(
    columns.map(async (column) => {
      const rows = await ledger.aggregate(columnRange(column), opts);
      return [column.key, new Map(rows.map((r) => [r.accountId, { debit: r.debit, credit: r.credit }]))] as const;
    }),
  );
  return new Map(entries);
}

function naturalBalance(account: LedgerAccount, totals: { debit: number; credit: number } | undefined): number {
  if (!totals) return 0;
  return account.normalSide === 'debit' ? totals.debit - totals.credit : totals.credit - totals.debit;
}

function valueSet(columns: ReportColumn[], amounts: Record<string, number>): ValueSet {
  const set: ValueSet = { values: Object.fromEntries(columns.map((c) => [c.key, money(amounts[c.key] ?? 0)])) };
  if (isComparison(columns)) set.delta = deltaOf(amounts.current ?? 0, amounts.prior ?? 0);
  return set;
}

export interface AccountRow {
  accountId: string | null;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  normalSide: 'debit' | 'credit';
  /** Profit & loss: which block of the statement the account belongs to. */
  section?: ProfitLossSection;
  /** A computed row (retained earnings, net income), not a chart account. */
  virtual?: boolean;
  totalDebit: string;
  totalCredit: string;
  balance: string;
  values: Record<string, string>;
  delta?: Delta;
}

function accountRow(
  account: Pick<LedgerAccount, 'id' | 'code' | 'name' | 'type' | 'subtype' | 'normalSide'>,
  columns: ReportColumn[],
  totals: TotalsByColumn,
  balanceOf: (t: { debit: number; credit: number } | undefined) => number,
): AccountRow {
  const primary = primaryColumn(columns);
  const own = totals.get(primary.key)?.get(account.id);
  const amounts = Object.fromEntries(columns.map((c) => [c.key, balanceOf(totals.get(c.key)?.get(account.id))]));
  const set = valueSet(columns, amounts);
  return {
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    accountType: account.type,
    accountSubtype: account.subtype,
    normalSide: account.normalSide,
    totalDebit: money(own?.debit ?? 0),
    totalCredit: money(own?.credit ?? 0),
    balance: money(amounts[primary.key]),
    ...set,
  };
}

function accountIdsOf(totals: TotalsByColumn): string[] {
  const ids = new Set<string>();
  for (const byAccount of totals.values()) for (const id of byAccount.keys()) ids.add(id);
  return [...ids];
}

function byCode(a: { code: string; name: string }, b: { code: string; name: string }) {
  return a.code.localeCompare(b.code, 'en', { numeric: true }) || a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Profit & loss
// ---------------------------------------------------------------------------

export type ProfitLossSection = 'income' | 'cost_of_goods_sold' | 'expense' | 'other_income' | 'other_expense';

const COGS_SUBTYPE = /^cost_of_(goods_sold|sales)$|^cogs$/i;
/** Income below the operating line: other and interest income. Expenses below it: other expense and income tax. */
const OTHER_INCOME_SUBTYPE = /^(other_income|interest_income)$/i;
const OTHER_EXPENSE_SUBTYPE = /^(other_expense|tax_expense)$/i;

export function profitLossSection(account: Pick<LedgerAccount, 'type' | 'subtype'>): ProfitLossSection {
  const subtype = account.subtype ?? '';
  if (account.type === 'revenue') return OTHER_INCOME_SUBTYPE.test(subtype) ? 'other_income' : 'income';
  if (COGS_SUBTYPE.test(subtype)) return 'cost_of_goods_sold';
  return OTHER_EXPENSE_SUBTYPE.test(subtype) ? 'other_expense' : 'expense';
}

export interface ProfitLossReport {
  basis: string;
  period: DateRange;
  columns: ReportColumn[];
  revenue: AccountRow[];
  expenses: AccountRow[];
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

export async function buildProfitLoss(ledger: Ledger, columns: ReportColumn[], period: DateRange): Promise<ProfitLossReport> {
  const totals = await totalsByColumn(ledger, columns, { accountTypes: ['revenue', 'expense'] });
  const accounts = accountIdsOf(totals)
    .map((id) => ledger.accounts.get(id))
    .filter((a): a is LedgerAccount => Boolean(a))
    .sort(byCode);

  const balanceOf = (account: LedgerAccount) => (t: { debit: number; credit: number } | undefined) =>
    account.type === 'revenue' ? (t ? t.credit - t.debit : 0) : t ? t.debit - t.credit : 0;

  const rows = accounts.map((account) => ({
    ...accountRow(account, columns, totals, balanceOf(account)),
    section: profitLossSection(account),
  }));

  const sum = (sections: ProfitLossSection[]): Record<string, number> =>
    Object.fromEntries(
      columns.map((c) => [
        c.key,
        rows.filter((r) => sections.includes(r.section)).reduce((total, r) => total + Number(r.values[c.key]), 0),
      ]),
    );
  const diff = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(columns.map((c) => [c.key, a[c.key] - b[c.key]]));
  const add = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(columns.map((c) => [c.key, a[c.key] + b[c.key]]));

  const income = sum(['income']);
  const cogs = sum(['cost_of_goods_sold']);
  const expenses = sum(['expense']);
  const otherIncome = sum(['other_income']);
  const otherExpenses = sum(['other_expense']);
  const grossProfit = diff(income, cogs);
  const netOperating = diff(grossProfit, expenses);
  const netOther = diff(otherIncome, otherExpenses);
  const totalRevenue = add(income, otherIncome);
  const totalExpenses = add(add(cogs, expenses), otherExpenses);
  const netProfit = diff(totalRevenue, totalExpenses);

  const primary = primaryColumn(columns).key;
  return {
    basis: ledger.basis,
    period,
    columns,
    revenue: rows.filter((r) => r.accountType === 'revenue'),
    expenses: rows.filter((r) => r.accountType === 'expense'),
    totalRevenue: money(totalRevenue[primary]),
    totalExpenses: money(totalExpenses[primary]),
    netProfit: money(netProfit[primary]),
    totals: {
      income: valueSet(columns, income),
      costOfGoodsSold: valueSet(columns, cogs),
      grossProfit: valueSet(columns, grossProfit),
      expenses: valueSet(columns, expenses),
      netOperatingIncome: valueSet(columns, netOperating),
      otherIncome: valueSet(columns, otherIncome),
      otherExpenses: valueSet(columns, otherExpenses),
      netOtherIncome: valueSet(columns, netOther),
      totalRevenue: valueSet(columns, totalRevenue),
      totalExpenses: valueSet(columns, totalExpenses),
      netProfit: valueSet(columns, netProfit),
    },
  };
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

export interface BalanceSheetReport {
  basis: string;
  asOf: string;
  columns: ReportColumn[];
  assets: AccountRow[];
  liabilities: AccountRow[];
  equity: AccountRow[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  totalLiabilitiesAndEquity: string;
  /** Assets minus liabilities and equity; not zero when something was booked on accounts the basis leaves out. */
  difference: string;
  isBalanced: boolean;
  totals: Record<'assets' | 'liabilities' | 'equity' | 'liabilitiesAndEquity', ValueSet>;
}

/**
 * Balance sheet as of each column's end. Profit and loss that was never
 * closed to equity shows as two calculated equity rows (earlier fiscal years,
 * this fiscal year), so the sheet balances without a closing entry.
 */
export async function buildBalanceSheet(
  ledger: Ledger,
  columns: ReportColumn[],
  fiscalYearStartOf: (date: string) => string,
): Promise<BalanceSheetReport> {
  const totals = await totalsByColumn(ledger, columns, { accountTypes: ['asset', 'liability', 'equity'] });

  const earnings = await Promise.all(
    columns.map(async (column) => {
      const yearStart = fiscalYearStartOf(column.to);
      // Income minus expense: revenue is credit-positive, expense debit-negative.
      const earningsOf = (rows: AggregateRow[]) => rows.reduce((total, r) => total + (r.credit - r.debit), 0);
      const [prior, current] = await Promise.all([
        ledger.aggregate({ from: null, to: parseReportDate(addDays(yearStart, -1), 'end') }, { accountTypes: ['revenue', 'expense'] }),
        ledger.aggregate({ from: parseReportDate(yearStart, 'start'), to: parseReportDate(column.to, 'end') }, { accountTypes: ['revenue', 'expense'] }),
      ]);
      return { key: column.key, prior: earningsOf(prior), current: earningsOf(current) };
    }),
  );

  const accounts = accountIdsOf(totals)
    .map((id) => ledger.accounts.get(id))
    .filter((a): a is LedgerAccount => Boolean(a))
    .sort(byCode);
  const balanceOf = (account: LedgerAccount) => (t: { debit: number; credit: number } | undefined) => naturalBalance(account, t);
  const rows = accounts.map((account) => accountRow(account, columns, totals, balanceOf(account)));

  const calculated = (
    name: string,
    subtype: string,
    pick: (e: { prior: number; current: number }) => number,
  ): AccountRow => {
    const amounts = Object.fromEntries(columns.map((c) => [c.key, pick(earnings.find((e) => e.key === c.key)!)]));
    const set = valueSet(columns, amounts);
    const primary = primaryColumn(columns).key;
    return {
      accountId: null,
      accountCode: '',
      accountName: name,
      accountType: 'equity',
      accountSubtype: subtype,
      normalSide: 'credit',
      virtual: true,
      totalDebit: '0.00',
      totalCredit: money(amounts[primary]),
      balance: money(amounts[primary]),
      ...set,
    };
  };

  const assets = rows.filter((r) => r.accountType === 'asset');
  const liabilities = rows.filter((r) => r.accountType === 'liability');
  const equity = [
    ...rows.filter((r) => r.accountType === 'equity'),
    calculated('Retained earnings (earlier years)', 'calculated_retained_earnings', (e) => e.prior),
    calculated('Net income (this fiscal year)', 'calculated_net_income', (e) => e.current),
  ];

  const sumRows = (list: AccountRow[]) =>
    Object.fromEntries(columns.map((c) => [c.key, list.reduce((total, r) => total + Number(r.values[c.key]), 0)]));
  const totalAssets = sumRows(assets);
  const totalLiabilities = sumRows(liabilities);
  const totalEquity = sumRows(equity);
  const liabilitiesAndEquity = Object.fromEntries(columns.map((c) => [c.key, totalLiabilities[c.key] + totalEquity[c.key]]));

  const primary = primaryColumn(columns);
  const difference = totalAssets[primary.key] - liabilitiesAndEquity[primary.key];
  return {
    basis: ledger.basis,
    asOf: primary.to,
    columns,
    assets,
    liabilities,
    equity,
    totalAssets: money(totalAssets[primary.key]),
    totalLiabilities: money(totalLiabilities[primary.key]),
    totalEquity: money(totalEquity[primary.key]),
    totalLiabilitiesAndEquity: money(liabilitiesAndEquity[primary.key]),
    difference: money(difference),
    isBalanced: Math.abs(difference) < 0.01,
    totals: {
      assets: valueSet(columns, totalAssets),
      liabilities: valueSet(columns, totalLiabilities),
      equity: valueSet(columns, totalEquity),
      liabilitiesAndEquity: valueSet(columns, liabilitiesAndEquity),
    },
  };
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  totalDebit: string;
  totalCredit: string;
  /** Net debit balance of the period (0.00 when the account ends in credit). */
  debitBalance: string;
  creditBalance: string;
  /** Net balance, debit positive, by column. */
  values: Record<string, string>;
  delta?: Delta;
}

export interface TrialBalanceReport {
  basis: string;
  period: DateRange;
  columns: ReportColumn[];
  accounts: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  isBalanced: boolean;
}

export async function buildTrialBalance(ledger: Ledger, columns: ReportColumn[], period: DateRange): Promise<TrialBalanceReport> {
  const totals = await totalsByColumn(ledger, columns, {});
  const accounts = accountIdsOf(totals)
    .map((id) => ledger.accounts.get(id))
    .filter((a): a is LedgerAccount => Boolean(a))
    .sort(byCode);
  const primary = primaryColumn(columns);

  const rows: TrialBalanceRow[] = accounts.map((account) => {
    const own = totals.get(primary.key)?.get(account.id);
    const net = (own?.debit ?? 0) - (own?.credit ?? 0);
    const amounts = Object.fromEntries(
      columns.map((c) => {
        const t = totals.get(c.key)?.get(account.id);
        return [c.key, (t?.debit ?? 0) - (t?.credit ?? 0)];
      }),
    );
    return {
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      totalDebit: money(own?.debit ?? 0),
      totalCredit: money(own?.credit ?? 0),
      debitBalance: money(net > 0 ? net : 0),
      creditBalance: money(net < 0 ? -net : 0),
      ...valueSet(columns, amounts),
    };
  });

  const totalDebit = rows.reduce((total, r) => total + Number(r.totalDebit), 0);
  const totalCredit = rows.reduce((total, r) => total + Number(r.totalCredit), 0);
  return {
    basis: ledger.basis,
    period,
    columns,
    accounts: rows,
    totalDebit: money(totalDebit),
    totalCredit: money(totalCredit),
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  };
}

// ---------------------------------------------------------------------------
// General ledger
// ---------------------------------------------------------------------------

export interface GeneralLedgerReport {
  basis: string;
  account: { id: string; code: string; name: string; normalSide: 'debit' | 'credit' };
  period: DateRange;
  /** Debit minus credit before the period. `runningBalance` of the lines follows the same sign. */
  openingBalance: string;
  closingBalance: string;
  totalDebit: string;
  totalCredit: string;
  lines: Array<{
    id: string;
    journalEntryId: string | null;
    entryNumber: string | null;
    entryDate: Date;
    entryStatus: string;
    description: string | null;
    sourceType: string | null;
    contactId: string | null;
    paymentId: string | null;
    debit: string;
    credit: string;
    runningBalance: string;
  }>;
  pagination: { page: number; pageSize: number; totalCount: number; totalPages: number; hasMore: boolean };
}

export async function buildGeneralLedger(
  ledger: Ledger,
  accountId: string,
  period: DateRange,
  paging: { page: number; pageSize: number },
): Promise<GeneralLedgerReport | null> {
  const account = ledger.accounts.get(accountId);
  if (!account) return null;

  const range: LedgerRange = { from: parseReportDate(period.from, 'start'), to: parseReportDate(period.to, 'end') };
  const before = await ledger.aggregate(
    { from: null, to: new Date(range.from!.getTime() - 1) },
    { accountIds: [accountId] },
  );
  const opening = before.reduce((total, r) => total + r.debit - r.credit, 0);
  const all = await ledger.accountLines(accountId, range);

  let running = opening;
  const withBalance = all.map((line) => {
    running = roundMoney(running + line.debit - line.credit);
    return { line, running };
  });
  const totalDebit = all.reduce((total, l) => total + l.debit, 0);
  const totalCredit = all.reduce((total, l) => total + l.credit, 0);

  const { page, pageSize } = paging;
  const totalCount = all.length;
  const totalPages = Math.ceil(totalCount / pageSize);
  const slice = withBalance.slice((page - 1) * pageSize, page * pageSize);

  return {
    basis: ledger.basis,
    account: { id: account.id, code: account.code, name: account.name, normalSide: account.normalSide },
    period,
    openingBalance: money(opening),
    closingBalance: money(opening + totalDebit - totalCredit),
    totalDebit: money(totalDebit),
    totalCredit: money(totalCredit),
    lines: slice.map(({ line, running: balance }) => ({
      id: line.id,
      journalEntryId: line.journalEntryId,
      entryNumber: line.entryNumber,
      entryDate: line.entryDate,
      entryStatus: line.entryStatus,
      description: line.description,
      sourceType: line.sourceType,
      contactId: line.contactId,
      paymentId: line.paymentId ?? null,
      debit: money(line.debit),
      credit: money(line.credit),
      runningBalance: money(balance),
    })),
    pagination: { page, pageSize, totalCount, totalPages, hasMore: page < totalPages },
  };
}

// ---------------------------------------------------------------------------
// Revenue by customer, expense by category
// ---------------------------------------------------------------------------

export async function buildRevenueByCustomer(db: Database, ledger: Ledger, range: LedgerRange) {
  const rows = await ledger.aggregate(range, { accountTypes: ['revenue'], byContact: true });
  const byContact = new Map<string, number>();
  for (const r of rows) {
    if (!r.contactId) continue;
    byContact.set(r.contactId, (byContact.get(r.contactId) ?? 0) + r.credit - r.debit);
  }
  const ids = [...byContact.keys()];
  const names = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 400) {
    const parties = await db
      .select({ id: schema.parties.id, displayName: schema.parties.displayName })
      .from(schema.parties)
      .where(inArray(schema.parties.id, ids.slice(i, i + 400)));
    for (const p of parties) names.set(p.id, p.displayName);
  }
  const customers = [...byContact.entries()]
    .map(([contactId, total]) => ({ contactId, contactName: names.get(contactId) ?? null, totalRevenue: money(total) }))
    .sort((a, b) => Number(b.totalRevenue) - Number(a.totalRevenue));
  const grandTotal = [...byContact.values()].reduce((total, v) => total + v, 0);
  return { customers, grandTotal: money(grandTotal) };
}

export async function buildExpenseByCategory(ledger: Ledger, range: LedgerRange) {
  const rows = await ledger.aggregate(range, { accountTypes: ['expense'] });
  const categories = rows
    .map((r) => {
      const account = ledger.accounts.get(r.accountId)!;
      return { accountId: r.accountId, accountCode: account.code, accountName: account.name, totalExpense: money(r.debit - r.credit) };
    })
    .sort((a, b) => Number(b.totalExpense) - Number(a.totalExpense));
  const grandTotal = rows.reduce((total, r) => total + r.debit - r.credit, 0);
  return { categories, grandTotal: money(grandTotal) };
}

// ---------------------------------------------------------------------------
// Aged receivables and payables
// ---------------------------------------------------------------------------

const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof BUCKETS)[number];

function bucketOf(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return '1-30';
  if (daysPastDue <= 60) return '31-60';
  if (daysPastDue <= 90) return '61-90';
  return '90+';
}

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

export interface AgedReport {
  asOf: string;
  buckets: Record<AgingBucket, { total: string; count: number }>;
  total: string;
  contacts: Array<{ contactId: string; contactName: string | null; total: string } & Record<AgingBucket, string>>;
  documents: AgedDocument[];
}

const NOT_OPEN_STATUSES = ['draft', 'cancelled', 'void', 'paid', 'uncollectible', 'written_off'];

/** Open invoices (receivables) or bills (payables) aged by due date as of a day. */
export async function buildAgedReport(
  db: Database,
  entityId: string,
  kind: 'receivables' | 'payables',
  asOf: string,
): Promise<AgedReport> {
  const documents: AgedDocument[] = [];
  const toDay = (d: Date) => d.toISOString().slice(0, 10);

  if (kind === 'receivables') {
    const { invoices } = schema;
    const rows = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.entityId, entityId),
          isNull(invoices.deletedAt),
          notInArray(invoices.status, NOT_OPEN_STATUSES),
          notInArray(invoices.type, ['proforma']),
          sql`${invoices.balanceDue}::numeric <> 0`,
        ),
      )
      .orderBy(invoices.dueDate);
    for (const r of rows) {
      const sign = r.type === 'credit_note' ? -1 : 1;
      const days = diffDays(toDay(r.dueDate), asOf);
      documents.push({
        id: r.id,
        number: r.invoiceNumber,
        contactId: r.contactId,
        contactName: r.contactName,
        issueDate: toDay(r.issueDate),
        dueDate: toDay(r.dueDate),
        daysPastDue: days,
        bucket: bucketOf(days),
        balance: money(sign * Number.parseFloat(r.balanceDue ?? '0')),
      });
    }
  } else {
    const { bills } = schema;
    const rows = await db
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.entityId, entityId),
          isNull(bills.deletedAt),
          notInArray(bills.status, NOT_OPEN_STATUSES),
          sql`${bills.balanceDue}::numeric <> 0`,
        ),
      )
      .orderBy(bills.dueDate);
    for (const r of rows) {
      const sign = r.type === 'credit_note' ? -1 : 1;
      const days = diffDays(toDay(r.dueDate), asOf);
      documents.push({
        id: r.id,
        number: r.billNumber,
        contactId: r.contactId,
        contactName: r.contactName,
        issueDate: toDay(r.issueDate),
        dueDate: toDay(r.dueDate),
        daysPastDue: days,
        bucket: bucketOf(days),
        balance: money(sign * Number.parseFloat(r.balanceDue ?? '0')),
      });
    }
  }

  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, { total: 0, count: 0 }])) as Record<AgingBucket, { total: number; count: number }>;
  const contacts = new Map<string, { contactId: string; contactName: string | null; total: number } & Record<AgingBucket, number>>();
  for (const d of documents) {
    const amount = Number(d.balance);
    buckets[d.bucket].total += amount;
    buckets[d.bucket].count += 1;
    const contact =
      contacts.get(d.contactId) ??
      { contactId: d.contactId, contactName: d.contactName, total: 0, current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    contact[d.bucket] += amount;
    contact.total += amount;
    contacts.set(d.contactId, contact);
  }

  return {
    asOf,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, { total: money(buckets[b].total), count: buckets[b].count }])) as AgedReport['buckets'],
    total: money(BUCKETS.reduce((total, b) => total + buckets[b].total, 0)),
    contacts: [...contacts.values()]
      .sort((a, b) => (a.contactName ?? '').localeCompare(b.contactName ?? ''))
      .map((c) => ({
        contactId: c.contactId,
        contactName: c.contactName,
        total: money(c.total),
        current: money(c.current),
        '1-30': money(c['1-30']),
        '31-60': money(c['31-60']),
        '61-90': money(c['61-90']),
        '90+': money(c['90+']),
      })),
    documents,
  };
}
