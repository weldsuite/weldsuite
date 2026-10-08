/**
 * Fiscal years for the entity setup preview: month-based years and 52-53-week
 * years. Mirrors `@weldsuite/books-domain/us-compliance/fiscal-year` (the
 * platform doesn't import the domain package); the server stays the source of
 * truth for what the reports use.
 *
 * A fiscal year is named for the calendar year its end month falls in:
 * July-June FY2026 runs 1 July 2025 to 30 June 2026. A 52-53-week year ends on
 * the last (or the nearest) given weekday of its end month.
 */

export interface MonthFiscalYearConfig {
  type: 'month';
  /** 1 = January (calendar year) ... 12 = December. */
  startMonth: number;
}

export interface WeekFiscalYearConfig {
  type: 'fifty_two_fifty_three';
  /** Month the year ends in, 1-12. */
  endMonth: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  /** `last`: the last such weekday of the month. `nearest`: the one nearest the end of the month. */
  rule: 'last' | 'nearest';
}

export type FiscalYearConfig = MonthFiscalYearConfig | WeekFiscalYearConfig;

export interface FiscalYear {
  /** Named for the calendar year of its end month. */
  year: number;
  /** `YYYY-MM-DD` */
  start: string;
  end: string;
  /** 52 or 53 for week-based years, null for month-based ones. */
  weeks: number | null;
}

const DAY_MS = 86_400_000;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function formatIso(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function parseIso(value: string): { y: number; m: number; d: number } {
  return { y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)), d: Number(value.slice(8, 10)) };
}

function addDays(value: string, days: number): string {
  const { y, m, d } = parseIso(value);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function diffDays(a: string, b: string): number {
  const pa = parseIso(a);
  const pb = parseIso(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

function weekdayOf(value: string): number {
  const { y, m, d } = parseIso(value);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function lastDayOfMonth(y: number, m: number): string {
  return formatIso(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}

function clampMonth(month: number): number {
  const value = Math.trunc(Number.isFinite(month) ? month : 1);
  return Math.min(12, Math.max(1, value));
}

/** The last day of a 52-53-week year named `year`. */
function weekYearEnd(config: WeekFiscalYearConfig, year: number): string {
  const anchor = lastDayOfMonth(year, clampMonth(config.endMonth));
  const weekday = ((Math.trunc(config.weekday) % 7) + 7) % 7;
  if (config.rule === 'last') return addDays(anchor, -((weekdayOf(anchor) - weekday + 7) % 7));
  const forward = (weekday - weekdayOf(anchor) + 7) % 7;
  return addDays(anchor, forward <= 3 ? forward : forward - 7);
}

export function fiscalYearFor(config: FiscalYearConfig, year: number): FiscalYear {
  if (config.type === 'month') {
    const startMonth = clampMonth(config.startMonth);
    if (startMonth === 1) return { year, start: formatIso(year, 1, 1), end: formatIso(year, 12, 31), weeks: null };
    return { year, start: formatIso(year - 1, startMonth, 1), end: lastDayOfMonth(year, startMonth - 1), weeks: null };
  }
  const end = weekYearEnd(config, year);
  const previousEnd = weekYearEnd(config, year - 1);
  return { year, start: addDays(previousEnd, 1), end, weeks: diffDays(previousEnd, end) / 7 };
}

/** The fiscal year that contains a `YYYY-MM-DD` date. */
export function fiscalYearContaining(config: FiscalYearConfig, date: string): FiscalYear {
  const { y, m } = parseIso(date);
  if (config.type === 'month') {
    const startMonth = clampMonth(config.startMonth);
    return fiscalYearFor(config, startMonth === 1 || m < startMonth ? y : y + 1);
  }
  for (const candidate of [y, y + 1, y - 1]) {
    const year = fiscalYearFor(config, candidate);
    if (date >= year.start && date <= year.end) return year;
  }
  return fiscalYearFor(config, y);
}

/** The month a 52-53-week year starts in, for the entity's `fiscalYearStart` column. */
export function startMonthOfWeekYear(config: WeekFiscalYearConfig): number {
  return (clampMonth(config.endMonth) % 12) + 1;
}
