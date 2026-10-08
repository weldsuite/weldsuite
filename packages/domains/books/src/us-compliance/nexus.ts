/**
 * Economic nexus monitor: measures a seller's sales into each state against
 * that state's threshold (jurisdictions/us/nexus-thresholds.ts) and says
 * whether the seller is below, approaching (80% or more) or past it.
 *
 * What each window means here:
 * - previous_or_current_calendar_year: exceeded when last year or this year so
 *   far crossed. Both count.
 * - previous_calendar_year: only last year counts. This year so far is a
 *   look-ahead: it warns, and `pending` says when collecting would start.
 * - rolling_12_months: the 12 months ending `asOf`. When the state tests
 *   quarterly, the 12 months ending the last completed quarter count and the
 *   months since are the look-ahead.
 * - rolling_four_quarters: the same shape, on calendar quarters or New York's
 *   sales tax quarters.
 * - ct_october_september: the 12 months ending the last 30 September; the
 *   year in progress is the look-ahead.
 *
 * Amounts are dollars, summed in cents. A negative amount (a credit memo)
 * reduces the sales total and is not a transaction.
 */

import {
  getNexusRule,
  nexusMonitoredCodes,
  type CollectionStartRule,
  type NexusRule,
  type NexusUnverified,
} from '../jurisdictions/us/nexus-thresholds';
import { getUsState } from '../jurisdictions/us/states';
import { addDays, addMonths, daysInMonth, endOfMonth, formatIso, isIsoDate, parseIso, startOfMonth } from './dates';

/** The share of a threshold from which a state is flagged as approaching. */
export const NEXUS_APPROACHING_PERCENT = 80;

export interface NexusSale {
  /** `YYYY-MM-DD` (the date part of a timestamp is used). */
  date: string;
  /** Net sales in dollars, without tax; negative for a credit memo. */
  amount: number;
  /** Ship-to state (or `PR`). */
  stateCode: string;
  /** The sale went through a marketplace facilitator that collected the tax. */
  marketplaceFacilitated: boolean;
  /** The sale was taxable in the state. */
  taxable: boolean;
  /** A retail sale (not a sale for resale). */
  retail: boolean;
}

export type NexusStatus = 'below' | 'approaching' | 'exceeded';

export interface NexusPeriod {
  /** `binding` periods decide the status; a `look_ahead` period is in progress and only warns. */
  role: 'binding' | 'look_ahead';
  label: string;
  from: string;
  to: string;
  salesTotal: number;
  transactionCount: number;
  percentOfThreshold: number;
  exceeded: boolean;
  /** The day the threshold was first reached inside the period. */
  exceededOn?: string;
}

export interface NexusMeasurement {
  stateCode: string;
  /** False when the state has no sales tax: nothing to measure. */
  applicable: boolean;
  /** `effectiveFrom` of the rule version used. */
  ruleEffectiveFrom: string;
  /** Sales and transactions of the period that drives the status (the one closest to its threshold). */
  salesTotal: number;
  transactionCount: number;
  thresholdSales: number | null;
  /** Null when the state has no transaction test. */
  thresholdTransactions: number | null;
  /** 0 or more; 100 means the threshold is reached. Rounded down to two decimals. */
  percentOfThreshold: number;
  status: NexusStatus;
  /** When the threshold was crossed (the start of the current stretch above it). */
  exceededOn?: string;
  /** The first day the seller has to collect, from the state's collection start rule. */
  collectFrom?: string;
  /** False when the research could not confirm the state's collection start. */
  collectFromVerified: boolean;
  /** The window that drives the status. */
  window: { from: string; to: string };
  periods: NexusPeriod[];
  /** Below the threshold today, but the look-ahead period already crossed it. */
  pending?: { exceededOn: string; testDate: string; collectFrom: string };
  /** Rule cells the research could not settle. */
  unverified: readonly NexusUnverified[];
}

export type NexusAlert = 'register' | 'watch' | 'registered' | 'ok';

export interface NexusMonitorRow extends NexusMeasurement {
  stateName: string;
  registered: boolean;
  /** `register`: exceeded and not registered. `watch`: approaching. `registered`: exceeded and registered. */
  alert: NexusAlert;
}

interface Entry {
  date: string;
  cents: number;
  count: number;
}

interface Total {
  cents: number;
  count: number;
}

/** Day-aggregated sales with prefix sums, so any window is two binary searches. */
class SaleSeries {
  private readonly entries: Entry[];
  private readonly prefixCents: number[] = [0];
  private readonly prefixCount: number[] = [0];

  constructor(entries: Entry[]) {
    this.entries = entries;
    for (const entry of entries) {
      this.prefixCents.push((this.prefixCents[this.prefixCents.length - 1] as number) + entry.cents);
      this.prefixCount.push((this.prefixCount[this.prefixCount.length - 1] as number) + entry.count);
    }
  }

  get firstDate(): string | undefined {
    return this.entries[0]?.date;
  }

  /** Number of entries dated before `date`. */
  private before(date: string): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.entries[mid] as Entry).date < date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Number of entries dated on or before `date`. */
  private upTo(date: string): number {
    return this.before(addDays(date, 1));
  }

  total(from: string, to: string): Total {
    if (to < from) return { cents: 0, count: 0 };
    const a = this.before(from);
    const b = this.upTo(to);
    return {
      cents: (this.prefixCents[b] as number) - (this.prefixCents[a] as number),
      count: (this.prefixCount[b] as number) - (this.prefixCount[a] as number),
    };
  }

  /** The first day in `[from, to]` on which the running total from `from` passes `test`. */
  firstCrossing(from: string, to: string, test: (total: Total) => boolean): string | undefined {
    let cents = 0;
    let count = 0;
    for (let i = this.before(from); i < this.entries.length; i++) {
      const entry = this.entries[i] as Entry;
      if (entry.date > to) break;
      cents += entry.cents;
      count += entry.count;
      if (test({ cents, count })) return entry.date;
    }
    return undefined;
  }

  /** Every dated entry on or before `to`. */
  datesUpTo(to: string): string[] {
    return this.entries.slice(0, this.upTo(to)).map((entry) => entry.date);
  }
}

function toIsoDay(value: string | Date): string {
  const day = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  if (!isIsoDate(day)) throw new RangeError(`Invalid date: ${String(value)}`);
  return day;
}

function reaches(value: number, threshold: number, comparison: 'gte' | 'gt'): boolean {
  return comparison === 'gt' ? value > threshold : value >= threshold;
}

/** Whether a total meets the state's test (sales, transactions, either or both). */
function meets(rule: NexusRule, total: Total): boolean {
  const salesOk = rule.salesThreshold !== null && reaches(total.cents / 100, rule.salesThreshold, rule.comparison);
  const countOk =
    rule.transactionThreshold !== null && reaches(total.count, rule.transactionThreshold, rule.comparison);
  if (rule.test === 'or') return salesOk || countOk;
  if (rule.test === 'and') return salesOk && countOk;
  return salesOk;
}

/** Progress toward the threshold in percent: the nearer test for "or", the farther one for "and". */
function progress(rule: NexusRule, total: Total): number {
  const sales = rule.salesThreshold ? (total.cents / 100 / rule.salesThreshold) * 100 : 0;
  const count = rule.transactionThreshold ? (total.count / rule.transactionThreshold) * 100 : 0;
  const value = rule.test === 'or' ? Math.max(sales, count) : rule.test === 'and' ? Math.min(sales, count) : sales;
  return Math.max(0, value);
}

function floor2(value: number): number {
  return Math.floor(value * 100 + 1e-9) / 100;
}

function dollars(cents: number): number {
  return cents / 100;
}

/** The first collection day for a threshold crossed on `exceededOn`. */
export function applyCollectionStart(rule: CollectionStartRule, exceededOn: string): string {
  switch (rule.kind) {
    case 'next_transaction':
      return addDays(exceededOn, 1);
    case 'first_day_of_next_month':
      return addDays(endOfMonth(exceededOn), 1);
    case 'days_after':
      return addDays(exceededOn, rule.days);
  }
}

/** Last day of the quarter ending at or before `date`; `firstMonth` is the first month of a quarter. */
function lastQuarterEndOnOrBefore(date: string, firstMonth: number): string {
  const { y, m } = parseIso(date);
  for (let back = 0; back < 4; back++) {
    const index = y * 12 + (m - 1) - back;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    if ((((month - firstMonth - 2) % 3) + 3) % 3 !== 0) continue;
    const end = formatIso(year, month, daysInMonth(year, month));
    if (end <= date) return end;
  }
  throw new Error('unreachable quarter end');
}

function nextQuarterEnd(quarterEnd: string): string {
  return endOfMonth(addMonths(startOfMonth(quarterEnd), 3));
}

function trailingYearStart(end: string): string {
  return addDays(addMonths(end, -12), 1);
}

/** Test dates from `start` to `last`, oldest first. */
function testDates(start: string, last: string, next: (date: string) => string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= last; date = next(date)) dates.push(date);
  return dates;
}

function quarterEndOnOrAfter(date: string, firstMonth: number): string {
  const previous = lastQuarterEndOnOrBefore(date, firstMonth);
  return previous === date ? date : nextQuarterEnd(previous);
}

function nextSeptember30(date: string): string {
  return formatIso(parseIso(date).y + 1, 9, 30);
}

function septemberOnOrAfter(date: string): string {
  const { y } = parseIso(date);
  const candidate = formatIso(y, 9, 30);
  return candidate >= date ? candidate : nextSeptember30(candidate);
}

function lastSeptember30OnOrBefore(date: string): string {
  const { y } = parseIso(date);
  const candidate = formatIso(y, 9, 30);
  return candidate <= date ? candidate : formatIso(y - 1, 9, 30);
}

interface RawPeriod {
  period: NexusPeriod;
  raw: number;
}

function makePeriod(
  rule: NexusRule,
  series: SaleSeries,
  role: 'binding' | 'look_ahead',
  label: string,
  from: string,
  to: string,
  exceededOnAtEnd?: boolean,
): RawPeriod {
  const total = series.total(from, to);
  const exceeded = meets(rule, total);
  const raw = progress(rule, total);
  const period: NexusPeriod = {
    role,
    label,
    from,
    to,
    salesTotal: dollars(total.cents),
    transactionCount: total.count,
    percentOfThreshold: floor2(raw),
    exceeded,
  };
  if (exceeded) {
    // A tested period passes at its end; a running year passes on the day it crosses.
    const crossing = exceededOnAtEnd ? to : series.firstCrossing(from, to, (running) => meets(rule, running));
    if (crossing) period.exceededOn = crossing;
  }
  return { period, raw };
}

/** The start of the current stretch of tested periods that all passed, given each test date's result. */
function streakStart(results: Array<{ date: string; passed: boolean }>): string | undefined {
  let start: string | undefined;
  for (const result of results) {
    if (result.passed) start ??= result.date;
    else start = undefined;
  }
  return start;
}

/** When the trailing 12 months ending on each event date reach the threshold, back to the start of the current stretch. */
function rollingStreakStart(rule: NexusRule, series: SaleSeries, asOf: string): string | undefined {
  const events = new Set<string>([asOf]);
  for (const date of series.datesUpTo(asOf)) {
    events.add(date);
    for (const leaves of [addMonths(date, 12), addDays(addMonths(date, 12), 1)]) {
      if (leaves <= asOf) events.add(leaves);
    }
  }
  const results = [...events]
    .sort()
    .map((date) => ({ date, passed: meets(rule, series.total(trailingYearStart(date), date)) }));
  return streakStart(results);
}

interface Build {
  periods: RawPeriod[];
  exceededOn?: string;
  /** First collection day for an exceeded status. */
  collectFrom?: string;
  pending?: NexusMeasurement['pending'];
}

function buildCalendarYears(rule: NexusRule, series: SaleSeries, asOf: string): Build {
  const year = parseIso(asOf).y;
  const previousOnly = rule.window === 'previous_calendar_year';
  const previous = makePeriod(rule, series, 'binding', `${year - 1}`, `${year - 1}-01-01`, `${year - 1}-12-31`);
  const current = makePeriod(
    rule,
    series,
    previousOnly ? 'look_ahead' : 'binding',
    `${year} to date`,
    `${year}-01-01`,
    asOf,
  );
  const build: Build = { periods: [previous, current] };

  const crossed = [previous, current].filter((p) => p.period.role === 'binding' && p.period.exceeded);
  if (crossed.length > 0) {
    const crossings = crossed.map((p) => p.period.exceededOn).filter((d): d is string => Boolean(d));
    build.exceededOn = crossings.sort()[0];
    if (previousOnly) build.collectFrom = `${year}-01-01`;
    else if (build.exceededOn) build.collectFrom = applyCollectionStart(rule.collectionStart, build.exceededOn);
  } else if (previousOnly && current.period.exceeded && current.period.exceededOn) {
    build.pending = {
      exceededOn: current.period.exceededOn,
      testDate: `${year}-12-31`,
      collectFrom: `${year + 1}-01-01`,
    };
  }
  return build;
}

function buildRolling(rule: NexusRule, series: SaleSeries, asOf: string): Build {
  const period = makePeriod(rule, series, 'binding', '12 months', trailingYearStart(asOf), asOf);
  const build: Build = { periods: [period] };
  if (period.period.exceeded) {
    build.exceededOn = rollingStreakStart(rule, series, asOf) ?? period.period.exceededOn;
    if (build.exceededOn) build.collectFrom = applyCollectionStart(rule.collectionStart, build.exceededOn);
  }
  return build;
}

/** Windows tested at the end of a period: the last completed test is binding, the period in progress warns. */
function buildTested(
  rule: NexusRule,
  series: SaleSeries,
  asOf: string,
  scheme: {
    lastTest: string;
    nextTest: string;
    windowStart: (testDate: string) => string;
    allTests: string[];
    label: (testDate: string) => string;
  },
): Build {
  const binding = makePeriod(
    rule,
    series,
    'binding',
    scheme.label(scheme.lastTest),
    scheme.windowStart(scheme.lastTest),
    scheme.lastTest,
    true,
  );
  const lookFrom = scheme.windowStart(scheme.nextTest);
  const lookAhead = makePeriod(rule, series, 'look_ahead', `${scheme.label(scheme.nextTest)} so far`, lookFrom, asOf);
  const build: Build = { periods: [binding, lookAhead] };

  if (binding.period.exceeded) {
    const results = scheme.allTests.map((date) => ({
      date,
      passed: meets(rule, series.total(scheme.windowStart(date), date)),
    }));
    build.exceededOn = streakStart(results) ?? scheme.lastTest;
    build.collectFrom = applyCollectionStart(rule.collectionStart, build.exceededOn);
  } else if (lookAhead.period.exceeded && lookAhead.period.exceededOn) {
    build.pending = {
      exceededOn: lookAhead.period.exceededOn,
      testDate: scheme.nextTest,
      collectFrom: applyCollectionStart(rule.collectionStart, scheme.nextTest),
    };
  }
  return build;
}

function buildQuarterTested(rule: NexusRule, series: SaleSeries, asOf: string): Build {
  const firstMonth = rule.quarterFirstMonth ?? 1;
  const lastTest = lastQuarterEndOnOrBefore(asOf, firstMonth);
  const first = series.firstDate ?? asOf;
  return buildTested(rule, series, asOf, {
    lastTest,
    nextTest: nextQuarterEnd(lastTest),
    windowStart: trailingYearStart,
    allTests: testDates(quarterEndOnOrAfter(first, firstMonth), lastTest, nextQuarterEnd),
    label: (date) => `12 months to ${date}`,
  });
}

function buildConnecticut(rule: NexusRule, series: SaleSeries, asOf: string): Build {
  const lastTest = lastSeptember30OnOrBefore(asOf);
  const first = series.firstDate ?? asOf;
  return buildTested(rule, series, asOf, {
    lastTest,
    nextTest: nextSeptember30(lastTest),
    windowStart: (testDate) => addDays(formatIso(parseIso(testDate).y - 1, 9, 30), 1),
    allTests: testDates(septemberOnOrAfter(first), lastTest, nextSeptember30),
    label: (date) => `Oct ${parseIso(date).y - 1} to Sep ${parseIso(date).y}`,
  });
}

function buildSeries(rule: NexusRule, sales: readonly NexusSale[]): SaleSeries {
  const byDay = new Map<string, Entry>();
  for (const sale of sales) {
    if (sale.stateCode.trim().toUpperCase() !== rule.stateCode) continue;
    if (sale.marketplaceFacilitated && !rule.marketplaceSalesCount) continue;
    if (rule.base === 'retail' && !sale.retail) continue;
    if (rule.base === 'taxable' && !sale.taxable) continue;
    if (!Number.isFinite(sale.amount)) throw new RangeError(`Invalid sale amount: ${sale.amount}`);
    const date = toIsoDay(sale.date);
    const entry = byDay.get(date) ?? { date, cents: 0, count: 0 };
    entry.cents += Math.round(sale.amount * 100);
    if (sale.amount > 0) entry.count += 1;
    byDay.set(date, entry);
  }
  return new SaleSeries([...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)));
}

/**
 * Measures one state's rule against a seller's sales as of a date. `sales`
 * may hold other states' sales; they are ignored.
 */
export function measureNexus(rule: NexusRule, sales: readonly NexusSale[], asOf: string | Date): NexusMeasurement {
  const day = toIsoDay(asOf);

  if (!rule.hasSalesTax || rule.salesThreshold === null) {
    return {
      stateCode: rule.stateCode,
      applicable: false,
      ruleEffectiveFrom: rule.effectiveFrom,
      salesTotal: 0,
      transactionCount: 0,
      thresholdSales: null,
      thresholdTransactions: null,
      percentOfThreshold: 0,
      status: 'below',
      collectFromVerified: true,
      window: { from: day, to: day },
      periods: [],
      unverified: rule.unverified,
    };
  }

  const series = buildSeries(rule, sales);
  let build: Build;
  switch (rule.window) {
    case 'previous_or_current_calendar_year':
    case 'previous_calendar_year':
      build = buildCalendarYears(rule, series, day);
      break;
    case 'rolling_12_months':
      build = rule.testedQuarterly ? buildQuarterTested(rule, series, day) : buildRolling(rule, series, day);
      break;
    case 'rolling_four_quarters':
      build = buildQuarterTested(rule, series, day);
      break;
    case 'ct_october_september':
      build = buildConnecticut(rule, series, day);
      break;
  }

  const exceeded = build.periods.some((p) => p.period.role === 'binding' && p.period.exceeded);
  // The period nearest its threshold drives what is shown; a binding period wins a tie.
  const driver = build.periods.reduce((best, candidate) => {
    if (candidate.raw > best.raw) return candidate;
    if (candidate.raw === best.raw && candidate.period.role === 'binding' && best.period.role !== 'binding') return candidate;
    return best;
  });
  const raw = driver.raw;
  const status: NexusStatus = exceeded ? 'exceeded' : raw >= NEXUS_APPROACHING_PERCENT ? 'approaching' : 'below';

  const result: NexusMeasurement = {
    stateCode: rule.stateCode,
    applicable: true,
    ruleEffectiveFrom: rule.effectiveFrom,
    salesTotal: driver.period.salesTotal,
    transactionCount: driver.period.transactionCount,
    thresholdSales: rule.salesThreshold,
    thresholdTransactions: rule.transactionThreshold,
    percentOfThreshold: floor2(raw),
    status,
    collectFromVerified: !rule.unverified.includes('collection_start'),
    window: { from: driver.period.from, to: driver.period.to },
    periods: build.periods.map((p) => p.period),
    unverified: rule.unverified,
  };
  if (exceeded && build.exceededOn) result.exceededOn = build.exceededOn;
  if (exceeded && build.collectFrom) result.collectFrom = build.collectFrom;
  if (!exceeded && build.pending) result.pending = build.pending;
  return result;
}

/**
 * Every requested state's nexus position, nearest to its threshold first.
 * Each state is measured with the rule in force on `asOf`; states without a
 * sales tax (or without a rule) are left out. `registeredStates` are the
 * states the seller already collects in.
 */
export function nexusMonitor(
  states: readonly string[] | 'all',
  sales: readonly NexusSale[],
  asOf: string | Date,
  registeredStates: readonly string[] = [],
): NexusMonitorRow[] {
  const day = toIsoDay(asOf);
  const codes = (states === 'all' ? nexusMonitoredCodes() : states).map((code) => code.trim().toUpperCase());
  const registered = new Set(registeredStates.map((code) => code.trim().toUpperCase()));

  const salesByState = new Map<string, NexusSale[]>();
  for (const sale of sales) {
    const code = sale.stateCode.trim().toUpperCase();
    const list = salesByState.get(code);
    if (list) list.push(sale);
    else salesByState.set(code, [sale]);
  }

  const rows: NexusMonitorRow[] = [];
  for (const code of new Set(codes)) {
    const rule = getNexusRule(code, day);
    if (!rule || !rule.hasSalesTax) continue;
    const measurement = measureNexus(rule, salesByState.get(code) ?? [], day);
    const isRegistered = registered.has(code);
    const alert: NexusAlert =
      measurement.status === 'exceeded'
        ? isRegistered ? 'registered' : 'register'
        : measurement.status === 'approaching' && !isRegistered
          ? 'watch'
          : 'ok';
    rows.push({
      ...measurement,
      stateName: code === 'PR' ? 'Puerto Rico' : (getUsState(code)?.name ?? code),
      registered: isRegistered,
      alert,
    });
  }
  return rows.sort((a, b) => b.percentOfThreshold - a.percentOfThreshold || a.stateCode.localeCompare(b.stateCode));
}
