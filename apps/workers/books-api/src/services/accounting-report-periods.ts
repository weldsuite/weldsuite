/**
 * Date ranges and columns of the financial reports: fiscal-year defaults,
 * comparative columns (prior period, prior year) and month / quarter columns.
 *
 * Dates are `YYYY-MM-DD` strings, inclusive on both ends. Fiscal years come
 * from `@weldsuite/books-domain/us-compliance/fiscal-year`, which knows both
 * month-based years (`entities.fiscalYearStart`) and 52–53-week years
 * (`entities.fiscalYearConfig`).
 */

import {
  fiscalPeriods,
  fiscalYearConfigOf,
  fiscalYearFor,
  fiscalYearRange,
  priorPeriod,
  priorYear,
  type FiscalYearConfig,
} from '@weldsuite/books-domain/us-compliance/fiscal-year';
import { addDays, addMonths, endOfMonth, isIsoDate } from '@weldsuite/books-domain/us-compliance/dates';
import { ReportInputError } from './accounting-reports-basis';

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

export type CompareMode = 'prior_period' | 'prior_year';
export type PeriodsMode = 'months' | 'quarters';

interface FiscalEntity {
  fiscalYearStart: number | null;
  fiscalYearConfig: Parameters<typeof fiscalYearConfigOf>[0]['fiscalYearConfig'];
  timezone: string | null;
}

export function fiscalConfigOf(entity: FiscalEntity): FiscalYearConfig {
  return fiscalYearConfigOf(entity);
}

/** Today's date in the entity's time zone (UTC when it has none). */
export function todayFor(entity: { timezone: string | null }, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: entity.timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function requireIsoDate(value: string, name: string): string {
  // Accept a full ISO timestamp from older clients: the report works in whole days.
  const day = value.length > 10 ? value.slice(0, 10) : value;
  if (!isIsoDate(day)) throw new ReportInputError(`${name} must be a date (YYYY-MM-DD)`);
  return day;
}

/** The fiscal year that contains a date. */
export function fiscalYearContaining(entity: FiscalEntity, date: string): DateRange {
  const range = fiscalYearRange(fiscalConfigOf(entity), date);
  return { from: range.start, to: range.end };
}

/**
 * Fiscal year `year`, named for the calendar year it ends in (July–June
 * FY2026 is 1 July 2025 to 30 June 2026).
 */
export function fiscalYearNamed(entity: FiscalEntity, year: number): DateRange {
  const range = fiscalYearFor(fiscalConfigOf(entity), year);
  return { from: range.start, to: range.end };
}

/** Year to date: the start of the current fiscal year through today. */
export function fiscalYearToDate(entity: FiscalEntity, today: string): DateRange {
  return { from: fiscalYearContaining(entity, today).from, to: today };
}

/**
 * The `from` / `to` of a period report: explicit dates win, a missing end is
 * today, a missing start is the start of the fiscal year the end falls in.
 */
export function resolvePeriod(
  entity: FiscalEntity,
  query: { from?: string; to?: string },
  today = todayFor(entity),
): DateRange {
  const to = query.to ? requireIsoDate(query.to, 'to') : today;
  const from = query.from ? requireIsoDate(query.from, 'from') : fiscalYearContaining(entity, to).from;
  if (from > to) throw new ReportInputError('from must be on or before to');
  return { from, to };
}

export function priorPeriodOf(range: DateRange): DateRange {
  const prior = priorPeriod({ start: range.from, end: range.to });
  return { from: prior.start, to: prior.end };
}

export function priorYearOf(entity: FiscalEntity, range: DateRange): DateRange {
  const prior = priorYear({ start: range.from, end: range.to }, fiscalConfigOf(entity));
  return { from: prior.start, to: prior.end };
}

export function parseCompare(value: string | undefined | null): CompareMode | null {
  if (!value) return null;
  if (value === 'prior_period' || value === 'prior_year') return value;
  throw new ReportInputError("compare must be 'prior_period' or 'prior_year'");
}

export function parsePeriods(value: string | undefined | null): PeriodsMode | null {
  if (!value) return null;
  if (value === 'months' || value === 'quarters') return value;
  throw new ReportInputError("periods must be 'months' or 'quarters'");
}

function rangeLabel(range: DateRange): string {
  return range.from === range.to ? range.from : `${range.from} to ${range.to}`;
}

/** Columns of a period report: the range, plus the comparison range when asked for. */
export function periodColumns(entity: FiscalEntity, range: DateRange, compare: CompareMode | null): ReportColumn[] {
  const columns: ReportColumn[] = [{ key: 'current', label: rangeLabel(range), from: range.from, to: range.to }];
  if (compare) {
    const prior = compare === 'prior_year' ? priorYearOf(entity, range) : priorPeriodOf(range);
    columns.push({ key: 'prior', label: rangeLabel(prior), from: prior.from, to: prior.to });
  }
  return columns;
}

/** Columns of a balance sheet: everything up to a date, and up to the comparison date. */
export function pointInTimeColumns(
  asOf: string,
  compare: CompareMode | null,
  periodStart: string | null,
): ReportColumn[] {
  const columns: ReportColumn[] = [{ key: 'current', label: asOf, from: null, to: asOf }];
  if (compare) {
    let prior: string;
    if (compare === 'prior_year') {
      prior = asOf === endOfMonth(asOf) ? endOfMonth(addMonths(asOf, -12)) : addMonths(asOf, -12);
    } else if (periodStart) {
      // The period before the one that starts on `periodStart`.
      prior = addDays(periodStart, -1);
    } else {
      prior = asOf === endOfMonth(asOf) ? endOfMonth(addMonths(asOf, -1)) : addMonths(asOf, -1);
    }
    columns.push({ key: 'prior', label: prior, from: null, to: prior });
  }
  return columns;
}

/**
 * Month or quarter columns across a range, plus a total column. The blocks
 * are the fiscal periods of each fiscal year the range touches: calendar
 * months and quarters of three months from the fiscal year start, or the
 * 4-4-5 weeks of a 52–53-week year. Blocks at the ends are clipped to the range.
 * Keys: `YYYY-MM` for a calendar month, `<fiscal year>-P<nn>` for a 4-4-5
 * period, `<fiscal year>-Q<n>` for a quarter.
 */
export function splitColumns(entity: FiscalEntity, range: DateRange, mode: PeriodsMode): ReportColumn[] {
  const config = fiscalConfigOf(entity);
  const firstYear = fiscalYearRange(config, range.from).year;
  const lastYear = fiscalYearRange(config, range.to).year;
  if (lastYear - firstYear > 5) throw new ReportInputError('That range has too many columns; choose a shorter range');

  const blocks: Array<{ key: string; from: string; to: string }> = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const periods = fiscalPeriods(config, year);
    if (mode === 'months') {
      for (const p of periods) {
        blocks.push({ key: config.type === 'month' ? p.start.slice(0, 7) : `${year}-P${String(p.number).padStart(2, '0')}`, from: p.start, to: p.end });
      }
    } else {
      for (let quarter = 1; quarter <= 4; quarter++) {
        const members = periods.filter((p) => p.quarter === quarter);
        blocks.push({ key: `${year}-Q${quarter}`, from: members[0].start, to: members[members.length - 1].end });
      }
    }
  }

  const columns: ReportColumn[] = blocks
    .filter((b) => b.to >= range.from && b.from <= range.to)
    .map((b) => {
      const from = b.from < range.from ? range.from : b.from;
      const to = b.to > range.to ? range.to : b.to;
      return { key: b.key, label: rangeLabel({ from, to }), from, to };
    });
  columns.push({ key: 'total', label: rangeLabel(range), from: range.from, to: range.to });
  return columns;
}
