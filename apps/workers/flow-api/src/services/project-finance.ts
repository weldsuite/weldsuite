/**
 * Project finance: the database side of `/api/project-finance` and of the
 * weekly `finance_snapshot` sweep (design: weldflow-delivery-and-portfolio.md
 * "Finance and earned value"; ADR FLOW-019).
 *
 * WeldFlow keeps no ledger. Actual cost is read, read-only, from the modules
 * that record it, in the same tenant DB:
 *
 *  - time: approved and billed `time_entries` (their `cost`)
 *  - bills: posted `bill_items` tagged with the project (`line_total`, no tax;
 *    a credit note counts negative)
 *  - journal: lines of posted or reversed `journal_entries` on expense accounts
 *    (debit minus credit), so a reversal nets the entry to zero
 *  - purchase orders: received value of tagged lines (net of tax); the
 *    unreceived value of lines on approved, ordered and partial orders is
 *    committed
 *  - declarations: approved and paid `hr_declarations`
 *
 * Amounts are in the project's `budget_currency`. A tagged line in another
 * currency is left out and counted (`excluded`); with no `budget_currency`
 * nothing is excluded. The pure rules are in `@weldsuite/flow-domain/finance`
 * and mirrored in Rust, as are these queries.
 */

import { and, desc, eq, inArray, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { ProjectManualForecast } from '@weldsuite/db/schema/project-settings';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  CostLine,
  CostSource,
  FinanceFigures,
  FinancePercentages,
  FinanceRow,
  FinanceSettings,
  FinanceSnapshot,
  ManualForecast,
  ProjectFinance,
} from '@weldsuite/app-api-client/schemas/project-finance';
import {
  COMMITTED_PO_STATUSES,
  COUNTED_BILL_STATUSES,
  COUNTED_DECLARATION_STATUSES,
  COUNTED_JOURNAL_STATUSES,
  COUNTED_TIME_STATUSES,
  computeEvm,
  forecastAtCompletion,
  isoWeekKey,
  percentDone,
  percentOf,
  ratio,
  roundMoney,
  roundRatio,
  type EvmItem,
} from '@weldsuite/flow-domain/finance';

export type ProjectRow = typeof schema.projects.$inferSelect;

const tasks = schema.tasks;
const timeEntries = schema.timeEntries;
const bills = schema.bills;
const billItems = schema.billItems;
const journalLines = schema.journalLines;
const journalEntries = schema.journalEntries;
const poItems = schema.purchaseOrderItems;
const purchaseOrders = schema.purchaseOrders;
const declarations = schema.hrDeclarations;

/** `12.5` as the API shows money. */
export function moneyString(value: number): string {
  return roundMoney(value).toFixed(2);
}

function num(value: string | number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ms(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null;
}

/** A date frozen in a baseline snapshot (an ISO string), in milliseconds. */
function frozenMs(value: string | null | undefined): number | null {
  return value ? Date.parse(value) : null;
}

/** The currency the figures are in: the project's `budget_currency`, upper case; null when it has none. */
export function projectCurrency(project: Pick<ProjectRow, 'budgetCurrency'>): string | null {
  const raw = project.budgetCurrency?.trim();
  return raw ? raw.toUpperCase() : null;
}

/** SQL: the line's currency is the project's (always true when the project has none). */
function inCurrency(column: SQL | AnyColumn, currency: string | null): SQL {
  return currency === null ? sql`true` : sql`upper(coalesce(${column}, '')) = ${currency}`;
}

// ── Source totals ───────────────────────────────────────────────────────────

export interface SourceTotals {
  labour: Map<string | null, number>;
  bills: number;
  journal: number;
  purchaseReceived: number;
  committed: number;
  declarations: number;
  excluded: number;
}

/** The net value of a purchase order line, without tax. */
const poNet = sql`(${poItems.total} - coalesce(${poItems.taxAmount}, 0))`;
const poOrdered = sql`${poItems.quantityOrdered}`;
const poReceivedQty = sql`least(coalesce(${poItems.quantityReceived}, 0), ${poItems.quantityOrdered})`;
const poOpenQty = sql`greatest(${poItems.quantityOrdered} - coalesce(${poItems.quantityReceived}, 0), 0)`;
const poCommittedStatuses = sql.join(
  COMMITTED_PO_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

export async function sourceTotals(db: Database, projectId: string, currency: string | null): Promise<SourceTotals> {
  const billOk = inCurrency(bills.currency, currency);
  const journalOk = inCurrency(sql`coalesce(${schema.entities.baseCurrency}, '')`, currency);
  const poOk = inCurrency(purchaseOrders.currency, currency);
  const declOk = inCurrency(declarations.currency, currency);

  const [labourRows, billRow, journalRow, poRow, declRow] = await Promise.all([
    db
      .select({
        deliverableId: tasks.deliverableId,
        cost: sql<string>`coalesce(sum(coalesce(${timeEntries.cost}, 0)), 0)::text`,
      })
      .from(timeEntries)
      .leftJoin(tasks, and(eq(tasks.id, timeEntries.taskId), isNull(tasks.deletedAt)))
      .where(
        and(
          eq(timeEntries.projectId, projectId),
          isNull(timeEntries.deletedAt),
          inArray(timeEntries.status, [...COUNTED_TIME_STATUSES]),
        ),
      )
      .groupBy(tasks.deliverableId),
    db
      .select({
        total: sql<string>`coalesce(sum(case when ${bills.type} = 'credit_note' then -coalesce(${billItems.lineTotal}, 0) else coalesce(${billItems.lineTotal}, 0) end) filter (where ${billOk}), 0)::text`,
        excluded: sql<number>`count(*) filter (where not (${billOk}))`.mapWith(Number),
      })
      .from(billItems)
      .innerJoin(bills, eq(bills.id, billItems.billId))
      .where(
        and(
          eq(billItems.projectId, projectId),
          isNull(billItems.deletedAt),
          isNull(bills.deletedAt),
          inArray(bills.status, [...COUNTED_BILL_STATUSES]),
        ),
      ),
    db
      .select({
        total: sql<string>`coalesce(sum(coalesce(${journalLines.debit}, 0) - coalesce(${journalLines.credit}, 0)) filter (where ${journalOk}), 0)::text`,
        excluded: sql<number>`count(*) filter (where not (${journalOk}))`.mapWith(Number),
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, journalLines.accountId))
      .leftJoin(schema.entities, eq(schema.entities.id, journalLines.entityId))
      .where(
        and(
          eq(journalLines.projectId, projectId),
          isNull(journalLines.deletedAt),
          isNull(journalEntries.deletedAt),
          inArray(journalEntries.status, [...COUNTED_JOURNAL_STATUSES]),
          eq(schema.accounts.type, 'expense'),
        ),
      ),
    db
      .select({
        received: sql<string>`coalesce(sum(${poNet} * ${poReceivedQty}::numeric / ${poOrdered}) filter (where ${poOk} and ${purchaseOrders.status} <> 'cancelled'), 0)::text`,
        committed: sql<string>`coalesce(sum(${poNet} * ${poOpenQty}::numeric / ${poOrdered}) filter (where ${poOk} and ${purchaseOrders.status} in (${poCommittedStatuses})), 0)::text`,
        excluded: sql<number>`count(*) filter (where not (${poOk}))`.mapWith(Number),
      })
      .from(poItems)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, poItems.purchaseOrderId))
      .where(and(eq(poItems.projectId, projectId), isNull(purchaseOrders.deletedAt), sql`${poItems.quantityOrdered} > 0`)),
    db
      .select({
        total: sql<string>`coalesce(sum(${declarations.amount}) filter (where ${declOk}), 0)::text`,
        excluded: sql<number>`count(*) filter (where not (${declOk}))`.mapWith(Number),
      })
      .from(declarations)
      .where(and(eq(declarations.projectId, projectId), inArray(declarations.status, [...COUNTED_DECLARATION_STATUSES]))),
  ]);

  const labour = new Map<string | null, number>();
  for (const row of labourRows) labour.set(row.deliverableId ?? null, (labour.get(row.deliverableId ?? null) ?? 0) + num(row.cost));
  return {
    labour,
    bills: num(billRow[0]?.total),
    journal: num(journalRow[0]?.total),
    purchaseReceived: num(poRow[0]?.received),
    committed: num(poRow[0]?.committed),
    declarations: num(declRow[0]?.total),
    excluded: num(billRow[0]?.excluded) + num(journalRow[0]?.excluded) + num(poRow[0]?.excluded) + num(declRow[0]?.excluded),
  };
}

// ── The model ───────────────────────────────────────────────────────────────

export interface RowModel {
  id: string | null;
  code: string | null;
  title: string | null;
  plannedHours: number;
  percentDone: number;
  budget: number;
  labour: number;
  expenses: number;
  purchases: number;
  committed: number;
  earnedValue: number;
  plannedValue: number;
}

export interface FinanceModel {
  currency: string | null;
  budget: number | null;
  actual: number;
  committed: number;
  plannedValue: number;
  earnedValue: number;
  cpi: number | null;
  spi: number | null;
  forecast: number | null;
  forecastSource: 'manual' | 'cpi' | 'budget' | null;
  manual: ProjectManualForecast | null;
  bySource: Record<CostSource, number>;
  excluded: number;
  baseline: { id: string; version: number; createdAt: Date } | null;
  rows: RowModel[];
}

/** The `finance` settings of a project, with defaults. */
export function financeSettingsOf(project: Pick<ProjectRow, 'settings'>): {
  manualForecast: { amount: number | null; reason: string | null; setBy: string; setAt: string } | null;
  history: Array<{ amount: number | null; reason: string | null; setBy: string; setAt: string }>;
} {
  const finance = project.settings?.finance;
  return { manualForecast: finance?.manualForecast ?? null, history: finance?.history ?? [] };
}

/** Everything the finance figures of one project are built from, at `now`. */
export async function computeFinance(db: Database, project: ProjectRow, now: Date): Promise<FinanceModel> {
  const projectId = project.id;
  const currency = projectCurrency(project);
  const budget = project.budgetedAmount === null || project.budgetedAmount === undefined ? null : num(project.budgetedAmount);

  const [baselineRows, deliverables, taskRows, totals] = await Promise.all([
    db
      .select()
      .from(schema.projectBaselines)
      .where(eq(schema.projectBaselines.projectId, projectId))
      .orderBy(desc(schema.projectBaselines.version))
      .limit(1),
    db
      .select()
      .from(schema.projectDeliverables)
      .where(and(eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt)))
      .orderBy(schema.projectDeliverables.position, schema.projectDeliverables.number),
    db
      .select({ deliverableId: tasks.deliverableId, status: tasks.status, hours: tasks.estimatedHours })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt), sql`${tasks.status} <> 'cancelled'`))
      .orderBy(tasks.id),
    sourceTotals(db, projectId, currency),
  ]);
  const baseline = baselineRows[0] ?? null;
  const baselineDates = new Map((baseline?.snapshot.deliverables ?? []).map((d) => [d.id, d]));

  // Tasks per deliverable (null: none).
  const live = new Set(deliverables.map((d) => d.id));
  const byDeliverable = new Map<string | null, Array<{ done: boolean; hours: number | null }>>();
  for (const task of taskRows) {
    const key = task.deliverableId && live.has(task.deliverableId) ? task.deliverableId : null;
    const list = byDeliverable.get(key) ?? [];
    list.push({ done: task.status === 'done', hours: task.hours === null ? null : num(task.hours) });
    byDeliverable.set(key, list);
  }
  const hoursOf = (key: string | null) => (byDeliverable.get(key) ?? []).reduce((sum, t) => sum + (t.hours ?? 0), 0);

  const items: EvmItem[] = deliverables.map((d) => {
    const frozen = baselineDates.get(d.id);
    const start = frozen ? frozenMs(frozen.plannedStart) : ms(d.plannedStart);
    const end = frozen ? frozenMs(frozen.plannedEnd) : ms(d.plannedEnd);
    return {
      id: d.id,
      plannedHours: hoursOf(d.id),
      plannedStart: Number.isNaN(start) ? null : start,
      plannedEnd: Number.isNaN(end) ? null : end,
      percentDone: d.status === 'accepted' ? 1 : percentDone(byDeliverable.get(d.id) ?? []),
    };
  });
  // The work that belongs to no deliverable is an item of its own, or the whole project when there are none.
  const hasOther = byDeliverable.has(null) || deliverables.length === 0;
  if (hasOther) {
    items.push({
      id: null,
      plannedHours: hoursOf(null),
      plannedStart: null,
      plannedEnd: null,
      percentDone: percentDone(byDeliverable.get(null) ?? []),
    });
  }

  const goLive = baseline?.snapshot.goLive ? Date.parse(baseline.snapshot.goLive) : NaN;
  const spanEnd = Number.isNaN(goLive) ? ms(project.endDate) : goLive;
  const evm = computeEvm({ budget, items, spanStart: ms(project.startDate), spanEnd, now: now.getTime() });

  const unassignedExpenses = totals.journal + totals.declarations;
  const unassignedPurchases = totals.bills + totals.purchaseReceived;
  const labourTotal = [...totals.labour.values()].reduce((sum, v) => sum + v, 0);
  const actual = labourTotal + unassignedExpenses + unassignedPurchases;
  const cpi = ratio(evm.earnedValue, actual);
  const spi = ratio(evm.earnedValue, evm.plannedValue);
  const manualSetting = financeSettingsOf(project).manualForecast;
  const forecast = forecastAtCompletion({
    budget,
    actual,
    committed: totals.committed,
    cpi,
    manual: manualSetting?.amount ?? null,
  });

  const rowFor = (id: string | null, evmIndex: number): RowModel => {
    const d = id === null ? null : deliverables.find((x) => x.id === id);
    const result = evmIndex >= 0 ? evm.items[evmIndex] : null;
    return {
      id,
      code: d ? `D${d.number}` : null,
      title: d ? d.title : null,
      plannedHours: id === null ? hoursOf(null) : hoursOf(id),
      percentDone: Math.round((evmIndex >= 0 ? items[evmIndex].percentDone : 0) * 1000) / 10,
      budget: result?.budget ?? 0,
      labour: totals.labour.get(id) ?? 0,
      expenses: id === null ? unassignedExpenses : 0,
      purchases: id === null ? unassignedPurchases : 0,
      committed: id === null ? totals.committed : 0,
      earnedValue: result?.earnedValue ?? 0,
      plannedValue: result?.plannedValue ?? 0,
    };
  };
  const rows = items.map((item, index) => rowFor(item.id, index));
  // Costs with no deliverable still show when there is no unassigned work.
  const otherCosts = (totals.labour.get(null) ?? 0) + unassignedExpenses + unassignedPurchases + totals.committed;
  if (!hasOther && otherCosts > 0) rows.push(rowFor(null, -1));

  return {
    currency,
    budget,
    actual,
    committed: totals.committed,
    plannedValue: evm.plannedValue,
    earnedValue: evm.earnedValue,
    cpi,
    spi,
    forecast: forecast.amount,
    forecastSource: forecast.source,
    manual: manualSetting,
    bySource: {
      time: labourTotal,
      bill: totals.bills,
      journal: totals.journal,
      purchase_order: totals.purchaseReceived,
      declaration: totals.declarations,
    },
    excluded: totals.excluded,
    baseline: baseline ? { id: baseline.id, version: baseline.version, createdAt: baseline.createdAt } : null,
    rows,
  };
}

// ── Presenting ──────────────────────────────────────────────────────────────

function percentages(model: Pick<FinanceModel, 'budget' | 'actual' | 'committed' | 'plannedValue' | 'earnedValue' | 'forecast'>): FinancePercentages {
  const budget = model.budget;
  return {
    spent: percentOf(model.actual, budget),
    committed: percentOf(model.committed, budget),
    planned: percentOf(model.plannedValue, budget),
    earned: percentOf(model.earnedValue, budget),
    forecast: model.forecast === null ? null : percentOf(model.forecast, budget),
  };
}

function amount(value: number | null, visible: boolean): string | null {
  return visible && value !== null ? moneyString(value) : null;
}

export function presentManualForecast(
  value: ProjectManualForecast | null,
  visible: boolean,
): ManualForecast | null {
  return value ? { amount: amount(value.amount, visible), reason: visible ? value.reason : null, setBy: value.setBy, setAt: value.setAt } : null;
}

export function presentFinanceSettings(project: Pick<ProjectRow, 'settings'>, visible: boolean): FinanceSettings {
  const s = financeSettingsOf(project);
  return {
    manualForecast: presentManualForecast(s.manualForecast, visible),
    history: s.history.map((h) => presentManualForecast(h, visible) as ManualForecast),
  };
}

export function presentFinance(project: ProjectRow, model: FinanceModel, now: Date, visible: boolean): ProjectFinance {
  const figures: FinanceFigures = {
    budget: amount(model.budget, visible),
    actual: amount(model.actual, visible),
    committed: amount(model.committed, visible),
    plannedValue: amount(model.plannedValue, visible),
    earnedValue: amount(model.earnedValue, visible),
    forecast: amount(model.forecast, visible),
    variance: amount(model.forecast !== null && model.budget !== null ? model.forecast - model.budget : null, visible),
    cpi: roundRatio(model.cpi),
    spi: roundRatio(model.spi),
    forecastSource: model.forecastSource,
  };
  const rows: FinanceRow[] = model.rows.map((row) => {
    const rowActual = row.labour + row.expenses + row.purchases;
    const rowForecast = forecastAtCompletion({
      budget: row.budget,
      actual: rowActual,
      committed: row.committed,
      cpi: ratio(row.earnedValue, rowActual),
      manual: null,
    }).amount;
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      plannedHours: Math.round(row.plannedHours * 100) / 100,
      percentDone: row.percentDone,
      budget: amount(row.budget, visible),
      labour: amount(row.labour, visible),
      expenses: amount(row.expenses, visible),
      purchases: amount(row.purchases, visible),
      actual: amount(rowActual, visible),
      committed: amount(row.committed, visible),
      forecast: amount(rowForecast, visible),
      variance: amount(rowForecast === null ? null : rowForecast - row.budget, visible),
    };
  });
  return {
    projectId: project.id,
    currency: model.currency,
    canSeeAmounts: visible,
    asOf: now.toISOString(),
    baseline: model.baseline
      ? { id: model.baseline.id, version: model.baseline.version, createdAt: model.baseline.createdAt.toISOString() }
      : null,
    figures,
    percent: percentages(model),
    manualForecast: presentManualForecast(model.manual, visible),
    bySource: {
      time: amount(model.bySource.time, visible),
      bill: amount(model.bySource.bill, visible),
      journal: amount(model.bySource.journal, visible),
      purchase_order: amount(model.bySource.purchase_order, visible),
      declaration: amount(model.bySource.declaration, visible),
    },
    excludedLines: model.excluded,
    rows,
  };
}

// ── Snapshots ───────────────────────────────────────────────────────────────

type SnapshotRow = typeof schema.projectFinanceSnapshots.$inferSelect;

export function presentSnapshot(row: SnapshotRow, visible: boolean): FinanceSnapshot {
  const budget = row.budget === null ? null : num(row.budget);
  const forecast = row.forecast === null ? null : num(row.forecast);
  const model = {
    budget,
    actual: num(row.actualCost),
    committed: num(row.committed),
    plannedValue: num(row.plannedValue),
    earnedValue: num(row.earnedValue),
    forecast,
  };
  return {
    week: row.week,
    budget: amount(budget, visible),
    plannedValue: amount(model.plannedValue, visible),
    earnedValue: amount(model.earnedValue, visible),
    actualCost: amount(model.actual, visible),
    committed: amount(model.committed, visible),
    forecast: amount(forecast, visible),
    percent: percentages(model),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSnapshots(db: Database, projectId: string): Promise<SnapshotRow[]> {
  return db
    .select()
    .from(schema.projectFinanceSnapshots)
    .where(eq(schema.projectFinanceSnapshots.projectId, projectId))
    .orderBy(schema.projectFinanceSnapshots.week)
    .limit(520);
}

/** One snapshot per project per ISO week: written again, it replaces the week's. */
export async function upsertSnapshot(db: Database, project: ProjectRow, model: FinanceModel, now: Date): Promise<string> {
  const week = isoWeekKey(now.getTime());
  const values = {
    budget: model.budget === null ? null : moneyString(model.budget),
    plannedValue: moneyString(model.plannedValue),
    earnedValue: moneyString(model.earnedValue),
    actualCost: moneyString(model.actual),
    committed: moneyString(model.committed),
    forecast: model.forecast === null ? null : moneyString(model.forecast),
  };
  await db
    .insert(schema.projectFinanceSnapshots)
    .values({ id: generateId('pfs'), projectId: project.id, week, ...values, createdAt: now })
    .onConflictDoUpdate({
      target: [schema.projectFinanceSnapshots.projectId, schema.projectFinanceSnapshots.week],
      set: { ...values, createdAt: now },
    });
  return week;
}

// ── Cost lines ──────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` of a date column. */
function day(column: SQL | AnyColumn): SQL<string> {
  return sql<string>`to_char((${column})::date, 'YYYY-MM-DD')`;
}

export interface CostLineQuery {
  source?: CostSource;
  from?: string;
  to?: string;
  /** `<day>~<id>` of the last line of the previous page. */
  cursor?: string;
  limit: number;
}

export interface CostLinePage {
  lines: CostLine[];
  total: number;
  hasMore: boolean;
  cursor: string | null;
}

interface Window {
  date: SQL;
  uid: SQL;
}

/** The common window of a source's query: the date range and the keyset position after the cursor. */
function windowOf(w: Window, q: CostLineQuery): SQL[] {
  const conditions: SQL[] = [];
  if (q.from) conditions.push(sql`${w.date} >= ${q.from}`);
  if (q.to) conditions.push(sql`${w.date} <= ${q.to}`);
  return conditions;
}

function afterCursor(w: Window, cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const at = cursor.indexOf('~');
  if (at < 0) return undefined;
  const cursorDay = cursor.slice(0, at);
  const cursorId = cursor.slice(at + 1);
  return sql`(${w.date} < ${cursorDay} or (${w.date} = ${cursorDay} and ${w.uid} collate "C" < ${cursorId}::text collate "C"))`;
}

function compareLines(a: CostLine, b: CostLine): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.id < b.id) return 1;
  return a.id > b.id ? -1 : 0;
}

const SOURCES: readonly CostSource[] = ['time', 'bill', 'journal', 'purchase_order', 'declaration'];

/** What one source of cost lines contributes: its page of lines and how many lines it has in all. */
interface SourceLines {
  lines: CostLine[];
  count: number;
}

interface SourceQuery {
  db: Database;
  projectId: string;
  currency: string | null;
  q: CostLineQuery;
  fetchCount: number;
}

async function timeLines({ db, projectId, currency, q, fetchCount }: SourceQuery): Promise<SourceLines> {
  const lines: CostLine[] = [];
  const w: Window = { date: sql`to_char(max(${timeEntries.date}), 'YYYY-MM-DD')`, uid: sql`'time:' || to_char(${timeEntries.date}, 'IYYY"-W"IW')` };
  const weekKey = sql<string>`to_char(${timeEntries.date}, 'IYYY"-W"IW')`;
  const base = and(
    eq(timeEntries.projectId, projectId),
    isNull(timeEntries.deletedAt),
    inArray(timeEntries.status, [...COUNTED_TIME_STATUSES]),
  );
  const having: SQL[] = [];
  if (q.from) having.push(sql`${w.date} >= ${q.from}`);
  if (q.to) having.push(sql`${w.date} <= ${q.to}`);
  const cursorCondition = afterCursor({ date: w.date, uid: sql`'time:' || ${weekKey}` }, q.cursor);
  if (cursorCondition) having.push(cursorCondition);
  const rows = await db
    .select({
      week: weekKey,
      date: sql<string>`${w.date}`,
      cost: sql<string>`coalesce(sum(coalesce(${timeEntries.cost}, 0)), 0)::text`,
      minutes: sql<string>`coalesce(sum(${timeEntries.duration}), 0)::text`,
      people: sql<number>`count(distinct ${timeEntries.userId})`.mapWith(Number),
    })
    .from(timeEntries)
    .where(base)
    .groupBy(weekKey)
    .having(having.length ? and(...having) : undefined)
    .orderBy(sql`${w.date} desc`, sql`'time:' || ${weekKey} collate "C" desc`)
    .limit(fetchCount);
  for (const row of rows) {
    lines.push({
      id: `time:${row.week}`,
      source: 'time',
      date: row.date,
      title: row.week,
      reference: null,
      status: 'approved',
      amount: moneyString(num(row.cost)),
      committed: '0.00',
      hours: Math.round((num(row.minutes) / 60) * 100) / 100,
      people: row.people,
    });
  }
  const [count] = await db
    .select({ n: sql<number>`count(distinct to_char(${timeEntries.date}, 'IYYY-IW'))`.mapWith(Number) })
    .from(timeEntries)
    .where(
      and(
        base,
        ...(q.from ? [sql`${timeEntries.date} >= ${q.from}`] : []),
        ...(q.to ? [sql`${timeEntries.date} <= ${q.to}`] : []),
      ),
    );
  return { lines, count: count?.n ?? 0 };
}

async function billLines({ db, projectId, currency, q, fetchCount }: SourceQuery): Promise<SourceLines> {
  const billOk = inCurrency(bills.currency, currency);
  const lines: CostLine[] = [];
  const date = day(bills.issueDate);
  const uid = sql`'bill:' || ${billItems.id}`;
  const w = { date, uid };
  const where = and(
    eq(billItems.projectId, projectId),
    isNull(billItems.deletedAt),
    isNull(bills.deletedAt),
    inArray(bills.status, [...COUNTED_BILL_STATUSES]),
    billOk,
    ...windowOf(w, q),
  );
  const cursorCondition = afterCursor(w, q.cursor);
  const rows = await db
    .select({
      id: billItems.id,
      date,
      title: billItems.description,
      reference: bills.billNumber,
      status: bills.status,
      type: bills.type,
      amount: sql<string>`coalesce(${billItems.lineTotal}, 0)::text`,
    })
    .from(billItems)
    .innerJoin(bills, eq(bills.id, billItems.billId))
    .where(cursorCondition ? and(where, cursorCondition) : where)
    .orderBy(sql`${date} desc`, sql`${uid} collate "C" desc`)
    .limit(fetchCount);
  for (const row of rows) {
    const signed = row.type === 'credit_note' ? -num(row.amount) : num(row.amount);
    lines.push({ id: `bill:${row.id}`, source: 'bill', date: row.date, title: row.title, reference: row.reference, status: row.status, amount: moneyString(signed), committed: '0.00', hours: null, people: null });
  }
  const [count] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(billItems)
    .innerJoin(bills, eq(bills.id, billItems.billId))
    .where(where);
  return { lines, count: count?.n ?? 0 };
}

async function journalLineItems({ db, projectId, currency, q, fetchCount }: SourceQuery): Promise<SourceLines> {
  const journalOk = inCurrency(sql`coalesce(${schema.entities.baseCurrency}, '')`, currency);
  const lines: CostLine[] = [];
  const date = day(journalEntries.date);
  const uid = sql`'journal:' || ${journalLines.id}`;
  const w = { date, uid };
  const where = and(
    eq(journalLines.projectId, projectId),
    isNull(journalLines.deletedAt),
    isNull(journalEntries.deletedAt),
    inArray(journalEntries.status, [...COUNTED_JOURNAL_STATUSES]),
    eq(schema.accounts.type, 'expense'),
    journalOk,
    ...windowOf(w, q),
  );
  const cursorCondition = afterCursor(w, q.cursor);
  const joined = () =>
    db
      .select({
        id: journalLines.id,
        date,
        title: sql<string | null>`coalesce(${journalLines.description}, ${journalEntries.description})`,
        reference: journalEntries.entryNumber,
        status: journalEntries.status,
        amount: sql<string>`(coalesce(${journalLines.debit}, 0) - coalesce(${journalLines.credit}, 0))::text`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, journalLines.accountId))
      .leftJoin(schema.entities, eq(schema.entities.id, journalLines.entityId));
  const rows = await joined()
    .where(cursorCondition ? and(where, cursorCondition) : where)
    .orderBy(sql`${date} desc`, sql`${uid} collate "C" desc`)
    .limit(fetchCount);
  for (const row of rows) {
    lines.push({ id: `journal:${row.id}`, source: 'journal', date: row.date, title: row.title, reference: row.reference, status: row.status, amount: moneyString(num(row.amount)), committed: '0.00', hours: null, people: null });
  }
  const [count] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, journalLines.accountId))
    .leftJoin(schema.entities, eq(schema.entities.id, journalLines.entityId))
    .where(where);
  return { lines, count: count?.n ?? 0 };
}

async function purchaseOrderLines({ db, projectId, currency, q, fetchCount }: SourceQuery): Promise<SourceLines> {
  const poOk = inCurrency(purchaseOrders.currency, currency);
  const lines: CostLine[] = [];
  const date = day(sql`coalesce(${poItems.lastReceivedDate}, ${purchaseOrders.orderDate}, ${poItems.createdAt})`);
  const uid = sql`'purchase_order:' || ${poItems.id}`;
  const w = { date, uid };
  const received = sql<string>`(${poNet} * ${poReceivedQty}::numeric / ${poOrdered})::text`;
  const open = sql<string>`(case when ${purchaseOrders.status} in (${poCommittedStatuses}) then ${poNet} * ${poOpenQty}::numeric / ${poOrdered} else 0 end)::text`;
  const where = and(
    eq(poItems.projectId, projectId),
    isNull(purchaseOrders.deletedAt),
    sql`${poItems.quantityOrdered} > 0`,
    poOk,
    sql`(${purchaseOrders.status} <> 'cancelled' or ${purchaseOrders.status} in (${poCommittedStatuses}))`,
    ...windowOf(w, q),
  );
  const cursorCondition = afterCursor(w, q.cursor);
  const rows = await db
    .select({ id: poItems.id, date, title: poItems.name, reference: purchaseOrders.poNumber, status: purchaseOrders.status, received, open })
    .from(poItems)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, poItems.purchaseOrderId))
    .where(cursorCondition ? and(where, cursorCondition) : where)
    .orderBy(sql`${date} desc`, sql`${uid} collate "C" desc`)
    .limit(fetchCount);
  for (const row of rows) {
    lines.push({ id: `purchase_order:${row.id}`, source: 'purchase_order', date: row.date, title: row.title, reference: row.reference, status: row.status, amount: moneyString(num(row.received)), committed: moneyString(num(row.open)), hours: null, people: null });
  }
  const [count] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(poItems)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, poItems.purchaseOrderId))
    .where(where);
  return { lines, count: count?.n ?? 0 };
}

async function declarationLines({ db, projectId, currency, q, fetchCount }: SourceQuery): Promise<SourceLines> {
  const declOk = inCurrency(declarations.currency, currency);
  const lines: CostLine[] = [];
  const date = day(declarations.expenseDate);
  const uid = sql`'declaration:' || ${declarations.id}`;
  const w = { date, uid };
  const where = and(
    eq(declarations.projectId, projectId),
    inArray(declarations.status, [...COUNTED_DECLARATION_STATUSES]),
    declOk,
    ...windowOf(w, q),
  );
  const cursorCondition = afterCursor(w, q.cursor);
  const rows = await db
    .select({ id: declarations.id, date, title: declarations.description, reference: declarations.category, status: declarations.status, amount: sql<string>`${declarations.amount}::text` })
    .from(declarations)
    .where(cursorCondition ? and(where, cursorCondition) : where)
    .orderBy(sql`${date} desc`, sql`${uid} collate "C" desc`)
    .limit(fetchCount);
  for (const row of rows) {
    lines.push({ id: `declaration:${row.id}`, source: 'declaration', date: row.date, title: row.title, reference: row.reference, status: row.status, amount: moneyString(num(row.amount)), committed: '0.00', hours: null, people: null });
  }
  const [count] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(declarations).where(where);
  return { lines, count: count?.n ?? 0 };
}

const SOURCE_LINES: Record<CostSource, (query: SourceQuery) => Promise<SourceLines>> = {
  time: timeLines,
  bill: billLines,
  journal: journalLineItems,
  purchase_order: purchaseOrderLines,
  declaration: declarationLines,
};

/**
 * The cost lines behind the figures, newest first, over every source (or one).
 * Time is one line per ISO week, so no person's cost shows. Each source is
 * queried for one page past the cursor and the results merged: ids compare
 * bytewise (`collate "C"`) so every backend orders ties alike.
 */
export async function listCostLines(db: Database, projectId: string, currency: string | null, q: CostLineQuery): Promise<CostLinePage> {
  const wanted = q.source ? [q.source] : SOURCES;
  const query: SourceQuery = { db, projectId, currency, q, fetchCount: q.limit + 1 };

  const merged: CostLine[] = [];
  let total = 0;
  for (const source of wanted) {
    const result = await SOURCE_LINES[source](query);
    merged.push(...result.lines);
    total += result.count;
  }

  merged.sort(compareLines);
  const hasMore = merged.length > q.limit;
  const pageRows = hasMore ? merged.slice(0, q.limit) : merged;
  const last = pageRows[pageRows.length - 1];
  return {
    lines: pageRows,
    total,
    hasMore,
    cursor: hasMore && last ? `${last.date}~${last.id}` : null,
  };
}

/** Which projects of the workspace the weekly sweep measures: live, with a baseline, not closed or cancelled. */
export async function projectsToSnapshot(db: Database): Promise<ProjectRow[]> {
  return db
    .select()
    .from(schema.projects)
    .where(
      and(
        isNull(schema.projects.deletedAt),
        sql`${schema.projects.status} not in ('Closed', 'Cancelled')`,
        sql`exists (select 1 from ${schema.projectBaselines} where ${schema.projectBaselines.projectId} = ${schema.projects.id})`,
      ),
    );
}

