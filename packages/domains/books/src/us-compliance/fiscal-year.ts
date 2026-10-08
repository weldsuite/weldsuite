/**
 * Fiscal years: month-based (start month 1-12) and 52-53-week years (the year
 * ends on the last, or the nearest, given weekday of an end month).
 *
 * Naming: a fiscal year is named for the calendar year in which its end month
 * falls. July-June FY2026 runs 1 July 2025 to 30 June 2026; a 52-53-week year
 * with end month December that ends on 3 January 2027 is still FY2026.
 *
 * Periods: month-based years have the 12 calendar months, grouped in quarters
 * of three. 52-53-week years use the 4-4-5 calendar: each quarter has periods of
 * 4, 4 and 5 weeks (13 weeks), and the extra week of a 53-week year goes to the
 * last period (6 weeks). Dates are `YYYY-MM-DD` strings; no time zones.
 */

import {
  addDays,
  addMonths,
  diffDays,
  endOfMonth,
  formatIso,
  lastDayOfMonth,
  parseIso,
  weekdayOf,
} from './dates';

export interface MonthFiscalYearConfig {
  type: 'month';
  /** 1 = January (calendar year) ... 12 = December. */
  startMonth: number;
}

export interface FiftyTwoFiftyThreeConfig {
  type: 'fifty_two_fifty_three';
  /** Month the year ends in, 1-12. */
  endMonth: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  /** `last`: the last such weekday of the month. `nearest`: the one nearest the end of the month. */
  rule: 'last' | 'nearest';
}

export type FiscalYearConfig = MonthFiscalYearConfig | FiftyTwoFiftyThreeConfig;

export interface FiscalYear {
  /** Named for the calendar year of its end month. */
  year: number;
  start: string;
  end: string;
  /** 52 or 53 for week-based years, null for month-based ones. */
  weeks: number | null;
}

export interface FiscalPeriod {
  /** 1-12 */
  number: number;
  /** 1-4 */
  quarter: number;
  start: string;
  end: string;
  /** Length in weeks for 4-4-5 periods, null for calendar months. */
  weeks: number | null;
}

export interface DateRange {
  start: string;
  end: string;
}

export type ReportRangeKind =
  | 'ytd'
  | 'last_year'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_month'
  | 'last_month';

/** The config for an entity row: `fiscalYearConfig` for 52-53-week years, else `fiscalYearStart`. */
export function fiscalYearConfigOf(entity: {
  fiscalYearStart?: number | null;
  fiscalYearConfig?: FiftyTwoFiftyThreeConfig | null;
}): FiscalYearConfig {
  if (entity.fiscalYearConfig) return entity.fiscalYearConfig;
  return { type: 'month', startMonth: entity.fiscalYearStart ?? 1 };
}

function clampMonth(month: number): number {
  const value = Math.trunc(Number.isFinite(month) ? month : 1);
  return Math.min(12, Math.max(1, value));
}

/** The last day of a 52-53-week year named `year`. */
function weekYearEnd(config: FiftyTwoFiftyThreeConfig, year: number): string {
  const anchor = lastDayOfMonth(year, clampMonth(config.endMonth));
  const weekday = ((Math.trunc(config.weekday) % 7) + 7) % 7;
  if (config.rule === 'last') {
    return addDays(anchor, -((weekdayOf(anchor) - weekday + 7) % 7));
  }
  const forward = (weekday - weekdayOf(anchor) + 7) % 7;
  return addDays(anchor, forward <= 3 ? forward : forward - 7);
}

export function fiscalYearFor(config: FiscalYearConfig, year: number): FiscalYear {
  if (config.type === 'month') {
    const startMonth = clampMonth(config.startMonth);
    if (startMonth === 1) return { year, start: formatIso(year, 1, 1), end: formatIso(year, 12, 31), weeks: null };
    return {
      year,
      start: formatIso(year - 1, startMonth, 1),
      end: lastDayOfMonth(year, startMonth - 1),
      weeks: null,
    };
  }
  const end = weekYearEnd(config, year);
  const previousEnd = weekYearEnd(config, year - 1);
  return { year, start: addDays(previousEnd, 1), end, weeks: diffDays(previousEnd, end) / 7 };
}

/** The fiscal year that contains a date. */
export function fiscalYearRange(config: FiscalYearConfig, date: string): FiscalYear {
  const { y, m } = parseIso(date);
  if (config.type === 'month') {
    const startMonth = clampMonth(config.startMonth);
    return fiscalYearFor(config, startMonth === 1 || m < startMonth ? y : y + 1);
  }
  for (const candidate of [y, y + 1, y - 1]) {
    const year = fiscalYearFor(config, candidate);
    if (date >= year.start && date <= year.end) return year;
  }
  throw new Error(`No fiscal year found for ${date}`);
}

export function isFiftyThreeWeekYear(config: FiscalYearConfig, fiscalYear: number): boolean {
  return config.type === 'fifty_two_fifty_three' && fiscalYearFor(config, fiscalYear).weeks === 53;
}

const FOUR_FOUR_FIVE = [4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5];

/** The 12 periods of a fiscal year: calendar months, or 4-4-5 week periods. */
export function fiscalPeriods(config: FiscalYearConfig, fiscalYear: number): FiscalPeriod[] {
  const year = fiscalYearFor(config, fiscalYear);
  if (config.type === 'month') {
    return Array.from({ length: 12 }, (_, index) => {
      const start = addMonths(year.start, index);
      return { number: index + 1, quarter: Math.floor(index / 3) + 1, start, end: endOfMonth(start), weeks: null };
    });
  }
  const lengths = [...FOUR_FOUR_FIVE];
  if (year.weeks === 53) lengths[11] = 6;
  let start = year.start;
  return lengths.map((weeks, index) => {
    const end = addDays(start, weeks * 7 - 1);
    const period = { number: index + 1, quarter: Math.floor(index / 3) + 1, start, end, weeks };
    start = addDays(end, 1);
    return period;
  });
}

/** The period (month or 4-4-5 period) that contains a date. */
export function fiscalPeriodOf(config: FiscalYearConfig, date: string): FiscalPeriod & { fiscalYear: number } {
  const year = fiscalYearRange(config, date);
  const period = fiscalPeriods(config, year.year).find((candidate) => date >= candidate.start && date <= candidate.end);
  if (!period) throw new Error(`No fiscal period found for ${date}`);
  return { ...period, fiscalYear: year.year };
}

interface QuarterEntry extends DateRange {
  fiscalYear: number;
  quarter: number;
}

function quartersOf(config: FiscalYearConfig, fiscalYear: number): QuarterEntry[] {
  const periods = fiscalPeriods(config, fiscalYear);
  return [1, 2, 3, 4].map((quarter) => {
    const inQuarter = periods.filter((period) => period.quarter === quarter);
    return {
      fiscalYear,
      quarter,
      start: inQuarter[0]!.start,
      end: inQuarter[inQuarter.length - 1]!.end,
    };
  });
}

/**
 * The default date range of a report. Quarter and month ranges are whole
 * quarters and months; `ytd` runs from the start of the fiscal year to today.
 */
export function defaultReportRange(config: FiscalYearConfig, today: string, kind: ReportRangeKind): DateRange {
  const year = fiscalYearRange(config, today);
  switch (kind) {
    case 'ytd':
      return { start: year.start, end: today };
    case 'last_year': {
      const previous = fiscalYearFor(config, year.year - 1);
      return { start: previous.start, end: previous.end };
    }
    case 'this_quarter':
    case 'last_quarter': {
      const quarters = [year.year - 1, year.year, year.year + 1].flatMap((fy) => quartersOf(config, fy));
      const index = quarters.findIndex((quarter) => today >= quarter.start && today <= quarter.end);
      const target = quarters[kind === 'this_quarter' ? index : index - 1]!;
      return { start: target.start, end: target.end };
    }
    case 'this_month':
    case 'last_month': {
      const periods = [year.year - 1, year.year, year.year + 1].flatMap((fy) => fiscalPeriods(config, fy));
      const index = periods.findIndex((period) => today >= period.start && today <= period.end);
      const target = periods[kind === 'this_month' ? index : index - 1]!;
      return { start: target.start, end: target.end };
    }
  }
}

function isWholeMonths(range: DateRange): boolean {
  return range.start.endsWith('-01') && range.end === endOfMonth(range.end);
}

/**
 * The range of the same length right before `range`. Whole-month ranges move
 * back by their number of months (a quarter becomes the previous quarter);
 * other ranges move back by their number of days (whole weeks stay aligned).
 */
export function priorPeriod(range: DateRange): DateRange {
  if (isWholeMonths(range)) {
    const s = parseIso(range.start);
    const e = parseIso(range.end);
    const months = (e.y * 12 + e.m) - (s.y * 12 + s.m) + 1;
    return { start: addMonths(range.start, -months), end: endOfMonth(addMonths(range.end, -months)) };
  }
  const length = diffDays(range.start, range.end) + 1;
  return { start: addDays(range.start, -length), end: addDays(range.start, -1) };
}

/**
 * The same range one year earlier. Whole-month ranges stay whole months; with a
 * 52-53-week config the range moves back 52 weeks so weekdays line up
 * (comparable weeks); otherwise the dates move back 12 months, a 29 February
 * becoming 28 February.
 */
export function priorYear(range: DateRange, config?: FiscalYearConfig): DateRange {
  if (config?.type === 'fifty_two_fifty_three') {
    return { start: addDays(range.start, -364), end: addDays(range.end, -364) };
  }
  if (isWholeMonths(range)) {
    return { start: addMonths(range.start, -12), end: endOfMonth(addMonths(range.end, -12)) };
  }
  return { start: addMonths(range.start, -12), end: addMonths(range.end, -12) };
}
