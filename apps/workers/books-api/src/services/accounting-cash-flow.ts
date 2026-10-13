/**
 * Cash flow report, built from the ledger.
 *
 * The cash accounts are every asset account with subtype `bank` or `cash` plus
 * the GL account behind each bank account. A journal entry that moves one of
 * them is a cash movement; the other lines of the entry say what the money was
 * for (direct method), so the report is grouped by the counterpart account:
 *
 *   operating   customer receipts, supplier payments, direct expenses, taxes,
 *               payroll, other
 *   investing   fixed assets
 *   financing   equity, loans
 *
 * Nothing is read from the bank statement import: a payment recorded in the
 * books, a bank-cost journal or a credit-note refund is in the report whether
 * or not a statement line was imported for it. Moves between two cash accounts
 * cancel out. `openingBalance + net = closingBalance` always holds, and the
 * closing balance is the cash line of the balance sheet on the same day.
 *
 * Amounts are in the entity's base currency (journal lines always are).
 * Outflows are positive amounts of money that left; `net` = inflows - outflows.
 */

import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { parseReportDate } from './accounting-reports-basis';
import type { DateRange } from './accounting-report-periods';
import { BOOKED_STATUSES, roundMoney } from './accounting-posting';

export type CashFlowActivity = 'operating' | 'investing' | 'financing';

export type CashFlowCategory =
  | 'customer_receipts'
  | 'supplier_payments'
  | 'operating_expenses'
  | 'taxes'
  | 'payroll'
  | 'other_operating'
  | 'fixed_assets'
  | 'equity'
  | 'loans';

export const CASH_FLOW_CATEGORIES: ReadonlyArray<{ category: CashFlowCategory; activity: CashFlowActivity }> = [
  { category: 'customer_receipts', activity: 'operating' },
  { category: 'supplier_payments', activity: 'operating' },
  { category: 'operating_expenses', activity: 'operating' },
  { category: 'taxes', activity: 'operating' },
  { category: 'payroll', activity: 'operating' },
  { category: 'other_operating', activity: 'operating' },
  { category: 'fixed_assets', activity: 'investing' },
  { category: 'equity', activity: 'financing' },
  { category: 'loans', activity: 'financing' },
];

const ACTIVITIES: CashFlowActivity[] = ['operating', 'investing', 'financing'];

export interface CashFlowFigures {
  inflows: string;
  outflows: string;
  net: string;
}

export interface CashFlowMonth extends CashFlowFigures {
  /** `YYYY-MM` */
  month: string;
}

export interface CashFlowCategoryRow extends CashFlowFigures {
  category: CashFlowCategory;
}

export interface CashFlowActivityBlock extends CashFlowFigures {
  activity: CashFlowActivity;
  categories: CashFlowCategoryRow[];
}

export interface CashFlowAccountBalance {
  accountId: string;
  accountCode: string;
  accountName: string;
  openingBalance: string;
  closingBalance: string;
  net: string;
}

export interface CashFlowResult {
  period: DateRange;
  /** Cash and bank balance before the first day of the period. */
  openingBalance: string;
  /** Cash and bank balance at the end of the last day: opening + net. */
  closingBalance: string;
  monthly: CashFlowMonth[];
  totals: CashFlowFigures;
  activities: CashFlowActivityBlock[];
  cashAccounts: CashFlowAccountBalance[];
}

export interface CounterpartAccount {
  type: string;
  subtype: string | null;
  name: string;
  systemRole?: string | null;
}

const TAX_SUBTYPE = /^(tax|tax_payable|tax_expense)$/i;
const TAX_ROLE = /(?:^tax_|tax_payable|sales_tax|use_tax|vat|backup_withholding)/i;
const FIXED_ASSET_SUBTYPE = /^(fixed_assets?|intangible_assets?|property_plant_equipment)$/i;
const LOAN_SUBTYPE = /^(long_term_liability|loan|loans|notes_payable|mortgage)$/i;
const LOAN_NAME = /lening|loan|mortgage|hypotheek|borrowing/i;
const NON_OPERATING_INCOME_SUBTYPE = /^(other_income|interest_income)$/i;

/** What a counterpart account says the money was for. */
export function classifyCounterpart(account: CounterpartAccount): CashFlowCategory {
  const subtype = account.subtype ?? '';
  const role = account.systemRole ?? '';

  if (/^payroll/i.test(role) || /^payroll$/i.test(subtype)) return 'payroll';
  if (TAX_SUBTYPE.test(subtype) || TAX_ROLE.test(role)) return 'taxes';
  if (account.type === 'equity') return 'equity';
  if (account.type === 'asset' && FIXED_ASSET_SUBTYPE.test(subtype)) return 'fixed_assets';
  if (account.type === 'liability' && (LOAN_SUBTYPE.test(subtype) || LOAN_NAME.test(account.name))) return 'loans';

  if (account.type === 'revenue') {
    return NON_OPERATING_INCOME_SUBTYPE.test(subtype) ? 'other_operating' : 'customer_receipts';
  }
  if (account.type === 'expense') return 'operating_expenses';
  if (subtype === 'accounts_receivable' || role === 'accounts_receivable' || role === 'undeposited_funds') {
    return 'customer_receipts';
  }
  if (
    subtype === 'accounts_payable' ||
    role === 'accounts_payable' ||
    subtype === 'inventory' ||
    subtype === 'prepaid_expense'
  ) {
    return 'supplier_payments';
  }
  return 'other_operating';
}

export function activityOf(category: CashFlowCategory): CashFlowActivity {
  return CASH_FLOW_CATEGORIES.find((c) => c.category === category)!.activity;
}

const money = (value: number): string => {
  const rounded = roundMoney(value);
  return (Math.abs(rounded) < 0.005 ? 0 : rounded).toFixed(2);
};

/** Ids of the cash and bank ledger accounts of an entity. */
export async function cashAccountsOf(db: Database, entityId: string) {
  const { accounts, bankAccounts } = schema;
  const linked = await db
    .select({ id: bankAccounts.ledgerAccountId })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.entityId, entityId), isNull(bankAccounts.deletedAt)));
  const linkedIds = new Set(linked.map((r) => r.id).filter((id): id is string => Boolean(id)));

  const rows = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.entityId, entityId), isNull(accounts.deletedAt)));
  return rows.filter((a) => a.type === 'asset' && (a.subtype === 'bank' || a.subtype === 'cash' || linkedIds.has(a.id)));
}

interface Bucket {
  inflows: number;
  outflows: number;
}

function add(bucket: Bucket, amount: number) {
  if (amount > 0) bucket.inflows += amount;
  else bucket.outflows -= amount;
}

function figures(bucket: Bucket): CashFlowFigures {
  return {
    inflows: money(bucket.inflows),
    outflows: money(bucket.outflows),
    net: money(bucket.inflows - bucket.outflows),
  };
}

function emptyCashFlow(range: DateRange): CashFlowResult {
  return {
    period: range,
    openingBalance: '0.00',
    closingBalance: '0.00',
    monthly: [],
    totals: { inflows: '0.00', outflows: '0.00', net: '0.00' },
    activities: ACTIVITIES.map((activity) => ({
      activity,
      inflows: '0.00',
      outflows: '0.00',
      net: '0.00',
      categories: CASH_FLOW_CATEGORIES.filter((c) => c.activity === activity).map((c) => ({
        category: c.category,
        inflows: '0.00',
        outflows: '0.00',
        net: '0.00',
      })),
    })),
    cashAccounts: [],
  };
}

/** Type, subtype, name and system role of the given (counterpart) accounts, read in chunks. */
async function loadCounterpartInfo(db: Database, accountIds: string[]): Promise<Map<string, CounterpartAccount>> {
  const { accounts } = schema;
  const accountInfo = new Map<string, CounterpartAccount>();
  for (let i = 0; i < accountIds.length; i += 400) {
    const rows = await db
      .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name, metadata: accounts.metadata })
      .from(accounts)
      .where(inArray(accounts.id, accountIds.slice(i, i + 400)));
    for (const a of rows) {
      accountInfo.set(a.id, {
        type: a.type,
        subtype: a.subtype,
        name: a.name,
        systemRole: (a.metadata as { systemRole?: string } | null)?.systemRole ?? null,
      });
    }
  }
  return accountInfo;
}

interface EntryCounterparts {
  date: Date;
  lines: Array<{ accountId: string; amount: number }>;
}

/** The non-cash lines of each entry, keyed by entry id. */
function groupCounterpartLines(
  lineRows: Array<{ entryId: string; date: Date; accountId: string; debit: string; credit: string }>,
  cashIds: string[],
): Map<string, EntryCounterparts> {
  const byEntry = new Map<string, EntryCounterparts>();
  for (const r of lineRows) {
    if (cashIds.includes(r.accountId)) continue;
    const entry = byEntry.get(r.entryId) ?? { date: r.date, lines: [] };
    // Positive: the line pays cash in (credit), negative: it takes cash out (debit).
    entry.lines.push({ accountId: r.accountId, amount: Number(r.credit) - Number(r.debit) });
    byEntry.set(r.entryId, entry);
  }
  return byEntry;
}

function bucketOf<K>(buckets: Map<K, Bucket>, key: K): Bucket {
  return buckets.get(key) ?? buckets.set(key, { inflows: 0, outflows: 0 }).get(key)!;
}

/** Net amount per category of one entry. */
function netPerCategory(entry: EntryCounterparts, accountInfo: Map<string, CounterpartAccount>) {
  // One entry, one category: opposite lines of the same category net off (a payment discount against the receivable).
  const perCategory = new Map<CashFlowCategory, number>();
  for (const line of entry.lines) {
    const info = accountInfo.get(line.accountId);
    const category = info ? classifyCounterpart(info) : 'other_operating';
    perCategory.set(category, (perCategory.get(category) ?? 0) + line.amount);
  }
  return perCategory;
}

/** Inflows and outflows per category, per month and in total. */
function accumulateCashMovements(
  byEntry: Map<string, EntryCounterparts>,
  accountInfo: Map<string, CounterpartAccount>,
) {
  const categoryTotals = new Map<CashFlowCategory, Bucket>();
  const monthTotals = new Map<string, Bucket>();
  const total: Bucket = { inflows: 0, outflows: 0 };
  for (const entry of byEntry.values()) {
    const month = entry.date.toISOString().slice(0, 7);
    for (const [category, amount] of netPerCategory(entry, accountInfo)) {
      const rounded = roundMoney(amount);
      if (Math.abs(rounded) < 0.005) continue;
      add(bucketOf(categoryTotals, category), rounded);
      add(bucketOf(monthTotals, month), rounded);
      add(total, rounded);
    }
  }
  return { categoryTotals, monthTotals, total };
}

function buildActivityBlocks(categoryTotals: Map<CashFlowCategory, Bucket>): CashFlowActivityBlock[] {
  return ACTIVITIES.map((activity) => {
    const categories = CASH_FLOW_CATEGORIES.filter((c) => c.activity === activity).map((c) => ({
      category: c.category,
      ...figures(categoryTotals.get(c.category) ?? { inflows: 0, outflows: 0 }),
    }));
    const block: Bucket = { inflows: 0, outflows: 0 };
    for (const c of CASH_FLOW_CATEGORIES.filter((x) => x.activity === activity)) {
      const t = categoryTotals.get(c.category);
      if (t) {
        block.inflows += t.inflows;
        block.outflows += t.outflows;
      }
    }
    return { activity, ...figures(block), categories };
  });
}

export async function buildCashFlow(db: Database, entityId: string, range: DateRange): Promise<CashFlowResult> {
  const { journalLines: jl, journalEntries: je } = schema;
  const from = parseReportDate(range.from, 'start');
  const to = parseReportDate(range.to, 'end');

  const cashAccounts = await cashAccountsOf(db, entityId);
  const cashIds = cashAccounts.map((a) => a.id);

  if (cashIds.length === 0) return emptyCashFlow(range);

  const booked = [
    eq(jl.entityId, entityId),
    isNull(jl.deletedAt),
    isNull(je.deletedAt),
    inArray(je.status, BOOKED_STATUSES),
  ];

  // Opening and closing balance per cash account, straight from the ledger.
  const balanceRows = await db
    .select({
      accountId: jl.accountId,
      opening: sql<string>`coalesce(sum(case when ${je.date} < ${from.toISOString()}::timestamp then ${jl.debit}::numeric - ${jl.credit}::numeric else 0 end), 0)`,
      closing: sql<string>`coalesce(sum(${jl.debit}::numeric - ${jl.credit}::numeric), 0)`,
    })
    .from(jl)
    .innerJoin(je, eq(jl.journalEntryId, je.id))
    .where(and(...booked, inArray(jl.accountId, cashIds), lte(je.date, to)))
    .groupBy(jl.accountId);
  const balances = new Map(balanceRows.map((r) => [r.accountId, { opening: Number(r.opening), closing: Number(r.closing) }]));

  // Every line of every entry in the period that moves a cash account.
  const cashIdList = sql.join(cashIds.map((id) => sql`${id}`), sql`, `);
  const lineRows = await db
    .select({
      entryId: je.id,
      date: je.date,
      accountId: jl.accountId,
      debit: sql<string>`coalesce(sum(${jl.debit}::numeric), 0)`,
      credit: sql<string>`coalesce(sum(${jl.credit}::numeric), 0)`,
    })
    .from(jl)
    .innerJoin(je, eq(jl.journalEntryId, je.id))
    .where(
      and(
        ...booked,
        gte(je.date, from),
        lte(je.date, to),
        sql`exists (select 1 from ${jl} as cash_line where cash_line.journal_entry_id = ${je.id} and cash_line.deleted_at is null and cash_line.account_id in (${cashIdList}))`,
      ),
    )
    .groupBy(je.id, je.date, jl.accountId);

  const counterpartIds = [...new Set(lineRows.map((r) => r.accountId).filter((id) => !cashIds.includes(id)))];
  const accountInfo = await loadCounterpartInfo(db, counterpartIds);
  const byEntry = groupCounterpartLines(lineRows, cashIds);
  const { categoryTotals, monthTotals, total } = accumulateCashMovements(byEntry, accountInfo);
  const activities = buildActivityBlocks(categoryTotals);

  const opening = [...balances.values()].reduce((sum, b) => sum + b.opening, 0);
  const closing = [...balances.values()].reduce((sum, b) => sum + b.closing, 0);

  return {
    period: range,
    openingBalance: money(opening),
    closingBalance: money(closing),
    monthly: [...monthTotals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({ month, ...figures(bucket) })),
    totals: figures(total),
    activities,
    cashAccounts: cashAccounts
      .map((a) => {
        const b = balances.get(a.id) ?? { opening: 0, closing: 0 };
        return {
          accountId: a.id,
          accountCode: a.code,
          accountName: a.name,
          openingBalance: money(b.opening),
          closingBalance: money(b.closing),
          net: money(b.closing - b.opening),
        };
      })
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode, 'en', { numeric: true })),
  };
}
