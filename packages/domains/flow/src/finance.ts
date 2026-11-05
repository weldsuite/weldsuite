/**
 * Project finance and earned value: the pure rules (design:
 * weldflow-delivery-and-portfolio.md "Finance and earned value"; ADR FLOW-019).
 * Mirrored by `rust/crates/flow-domain/src/finance.rs`; keep the two identical.
 *
 * Nothing here reads a database. The routes and the weekly sweep gather the
 * lines (flow-api `services/project-finance.ts`) and call these.
 *
 * Money amounts are plain numbers in the project's `budget_currency`; callers
 * round to cents (`roundMoney`) when they present them.
 */

/** Time entry statuses that count as actual cost (`billed` follows `approved`). */
export const COUNTED_TIME_STATUSES = ['approved', 'billed'] as const;
/** Bill statuses that are posted (a draft or cancelled bill is not a cost). */
export const COUNTED_BILL_STATUSES = ['approved', 'partial', 'overdue', 'paid'] as const;
/** Purchase order statuses whose unreceived lines are a commitment. */
export const COMMITTED_PO_STATUSES = ['approved', 'ordered', 'partial'] as const;
/** Expense declaration statuses that count. */
export const COUNTED_DECLARATION_STATUSES = ['approved', 'paid'] as const;
/** Journal entry statuses in the ledger: a reversed entry and its reversal net to zero. */
export const COUNTED_JOURNAL_STATUSES = ['posted', 'reversed'] as const;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Two decimals, half away from zero. */
export function roundMoney(value: number): number {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  return value < 0 ? -rounded : rounded;
}

/** The ISO week (`YYYY-Www`, UTC) a moment falls in. */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  // The Thursday of this week decides the ISO year.
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (3 - day) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const firstThursday = jan4 + (3 - ((new Date(jan4).getUTCDay() + 6) % 7)) * DAY_MS;
  const week = Math.round((thursday - firstThursday) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Monday 00:00 UTC of the week after the one `ms` falls in. */
export function nextWeekStartMs(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (7 - day) * DAY_MS;
}

/**
 * Each item's share of the budget, by planned hours. With no hours at all the
 * budget is split evenly; an empty list has no shares.
 */
export function budgetShares(hours: readonly number[]): number[] {
  if (hours.length === 0) return [];
  const clean = hours.map((h) => (Number.isFinite(h) && h > 0 ? h : 0));
  const total = clean.reduce((sum, h) => sum + h, 0);
  if (total <= 0) return clean.map(() => 1 / clean.length);
  return clean.map((h) => h / total);
}

export interface DoneTask {
  done: boolean;
  /** The task's estimate in hours; 0 or null when unestimated. */
  hours: number | null;
}

/**
 * Fraction (0 to 1) of the work done: tasks done weighted by their estimate.
 * With no estimate on any task, every task weighs the same. Callers leave
 * cancelled tasks out. No tasks: 0.
 */
export function percentDone(tasks: readonly DoneTask[]): number {
  if (tasks.length === 0) return 0;
  const weight = (t: DoneTask) => (t.hours !== null && Number.isFinite(t.hours) && t.hours > 0 ? t.hours : 0);
  const total = tasks.reduce((sum, t) => sum + weight(t), 0);
  if (total <= 0) return tasks.filter((t) => t.done).length / tasks.length;
  return tasks.reduce((sum, t) => sum + (t.done ? weight(t) : 0), 0) / total;
}

/**
 * How much of an item's work should be done at `now` (0 to 1): linear between
 * its dates. One date only counts as both. No dates: null (the caller falls
 * back to the project's span).
 */
export function plannedFraction(startMs: number | null, endMs: number | null, nowMs: number): number | null {
  if (startMs === null && endMs === null) return null;
  const start = startMs ?? (endMs as number);
  const end = endMs ?? start;
  if (end <= start) return nowMs >= end ? 1 : 0;
  if (nowMs <= start) return 0;
  if (nowMs >= end) return 1;
  return (nowMs - start) / (end - start);
}

export interface EvmItem {
  /** The deliverable id, null for the work that belongs to none. */
  id: string | null;
  plannedHours: number;
  /** Baseline dates, epoch ms. */
  plannedStart: number | null;
  plannedEnd: number | null;
  /** 0 to 1 (an accepted deliverable is 1). */
  percentDone: number;
}

export interface EvmItemResult {
  id: string | null;
  /** The item's share of the budget (0 to 1). */
  share: number;
  budget: number;
  plannedValue: number;
  earnedValue: number;
}

export interface EvmInput {
  budget: number | null;
  items: readonly EvmItem[];
  /** The project's span, used for items without dates. */
  spanStart: number | null;
  spanEnd: number | null;
  now: number;
}

export interface EvmResult {
  items: EvmItemResult[];
  plannedValue: number;
  earnedValue: number;
}

/** Planned and earned value of the project and of each item. Without a budget everything is 0. */
export function computeEvm(input: EvmInput): EvmResult {
  const budget = input.budget !== null && Number.isFinite(input.budget) && input.budget > 0 ? input.budget : 0;
  const shares = budgetShares(input.items.map((item) => item.plannedHours));
  const items = input.items.map((item, i): EvmItemResult => {
    const itemBudget = budget * shares[i];
    const hasDates = item.plannedStart !== null || item.plannedEnd !== null;
    const fraction = hasDates
      ? plannedFraction(item.plannedStart, item.plannedEnd, input.now)
      : plannedFraction(input.spanStart, input.spanEnd, input.now);
    const done = Math.min(1, Math.max(0, item.percentDone));
    return {
      id: item.id,
      share: shares[i],
      budget: itemBudget,
      plannedValue: itemBudget * (fraction ?? 0),
      earnedValue: itemBudget * done,
    };
  });
  return {
    items,
    plannedValue: items.reduce((sum, r) => sum + r.plannedValue, 0),
    earnedValue: items.reduce((sum, r) => sum + r.earnedValue, 0),
  };
}

/** `numerator / denominator`, null when the denominator is not positive. */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** A ratio to two decimals, as the CPI and SPI are shown. */
export function roundRatio(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

export type ForecastSource = 'manual' | 'cpi' | 'budget';

export interface Forecast {
  amount: number | null;
  source: ForecastSource | null;
}

/**
 * Forecast at completion: the manual forecast when there is one, else
 * budget / CPI. With no usable CPI (nothing spent, or nothing earned) the
 * budget stands, but never less than what is already spent and committed.
 * No budget and no manual forecast: none.
 */
export function forecastAtCompletion(args: {
  budget: number | null;
  actual: number;
  committed: number;
  cpi: number | null;
  manual: number | null;
}): Forecast {
  if (args.manual !== null) return { amount: args.manual, source: 'manual' };
  if (!isPositive(args.budget)) return { amount: null, source: null };
  if (args.cpi !== null && args.cpi > 0) return { amount: args.budget / args.cpi, source: 'cpi' };
  return { amount: Math.max(args.budget, args.actual + args.committed), source: 'budget' };
}

/** Whether `value` is a number above zero (not null, not NaN). */
function isPositive(value: number | null): value is number {
  return value !== null && value > 0;
}

/** `part` as a percentage of `whole` with one decimal; null without a positive whole. */
export function percentOf(part: number, whole: number | null): number | null {
  if (!isPositive(whole)) return null;
  return Math.round((part / whole) * 1000) / 10;
}
