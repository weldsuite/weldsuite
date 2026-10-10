/**
 * Pay periods from a pay schedule.
 *
 * - `monthly` periods are calendar months and `semimonthly` periods are the
 *   1st–15th and the 16th–last day; the anchor only says which period is the
 *   first one.
 * - `four_weekly`, `biweekly` and `weekly` periods are fixed blocks of 28, 14
 *   and 7 days counted from the anchor date.
 *
 * The tax year of a period is the calendar year of its start in the
 * Netherlands (a monthly tijdvak never crosses a year) and the calendar year
 * of the pay date in the US (wages are taxed when paid). Period numbers count
 * the periods of that tax year from 1.
 *
 * A pay date that falls on a Saturday or Sunday moves to the Friday before.
 * Public holidays are not considered.
 */

import type { PayFrequency, PayPeriod, PayrollCountry } from './types';

export type PayDateRule =
  | { kind: 'day_of_month'; day: number }
  | { kind: 'offset_after_end'; days: number }
  | { kind: 'last_business_day' };

export interface PayScheduleSpec {
  frequency: PayFrequency;
  /** `YYYY-MM-DD`: start of the first period. */
  anchorDate: string;
  payDateRule: PayDateRule;
}

/** Nominal periods per year, as withholding tables use them. */
export const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  monthly: 12,
  semimonthly: 24,
  four_weekly: 13,
  biweekly: 26,
  weekly: 52,
};

const BLOCK_DAYS: Partial<Record<PayFrequency, number>> = { four_weekly: 28, biweekly: 14, weekly: 7 };

// ---------------------------------------------------------------------------
// Date helpers (UTC, `YYYY-MM-DD`)
// ---------------------------------------------------------------------------

function parse(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Not a date: ${iso}`);
  return new Date(`${iso}T00:00:00Z`);
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parse(toIso).getTime() - parse(fromIso).getTime()) / 86_400_000);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: string): number {
  return parse(iso).getUTCDay();
}

function previousWeekdayIfWeekend(iso: string): string {
  const day = weekday(iso);
  if (day === 6) return addDays(iso, -1);
  if (day === 0) return addDays(iso, -2);
  return iso;
}

/** Monday–Friday days in [start, end], inclusive. */
export function weekdaysBetween(start: string, end: string): number {
  if (end < start) return 0;
  let count = 0;
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    const day = weekday(cursor);
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

interface Bounds {
  start: string;
  end: string;
}

/** The period (start/end) containing `date`. */
function boundsContaining(spec: PayScheduleSpec, date: string): Bounds {
  const d = parse(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  switch (spec.frequency) {
    case 'monthly':
      return { start: ymd(year, month, 1), end: ymd(year, month, lastDayOfMonth(year, month)) };
    case 'semimonthly':
      return d.getUTCDate() <= 15
        ? { start: ymd(year, month, 1), end: ymd(year, month, 15) }
        : { start: ymd(year, month, 16), end: ymd(year, month, lastDayOfMonth(year, month)) };
    default: {
      const block = BLOCK_DAYS[spec.frequency]!;
      const offset = daysBetween(spec.anchorDate, date);
      const index = Math.floor(offset / block);
      const start = addDays(spec.anchorDate, index * block);
      return { start, end: addDays(start, block - 1) };
    }
  }
}

function boundsAfter(spec: PayScheduleSpec, bounds: Bounds): Bounds {
  return boundsContaining(spec, addDays(bounds.end, 1));
}

export function payDateFor(spec: PayScheduleSpec, bounds: Bounds): string {
  const rule = spec.payDateRule;
  const end = parse(bounds.end);
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() + 1;
  let date: string;
  switch (rule.kind) {
    case 'day_of_month':
      if (spec.frequency === 'monthly') {
        date = ymd(year, month, Math.min(Math.max(1, Math.trunc(rule.day)), lastDayOfMonth(year, month)));
      } else {
        // Other frequencies have no "day of the month" of their own: pay at period end.
        date = bounds.end;
      }
      break;
    case 'offset_after_end':
      date = addDays(bounds.end, Math.trunc(rule.days));
      break;
    case 'last_business_day':
      date = ymd(year, month, lastDayOfMonth(year, month));
      break;
  }
  return previousWeekdayIfWeekend(date);
}

function taxYearOf(country: PayrollCountry, bounds: Bounds, payDate: string): number {
  return country === 'NL' ? Number(bounds.start.slice(0, 4)) : Number(payDate.slice(0, 4));
}

/** The first period of the schedule whose tax year is `year`. */
function firstBoundsOfYear(spec: PayScheduleSpec, country: PayrollCountry, year: number): Bounds {
  // Start a little before the year so a period that straddles New Year is found.
  let bounds = boundsContaining(spec, `${year - 1}-12-01`);
  for (let i = 0; i < 80; i += 1) {
    if (taxYearOf(country, bounds, payDateFor(spec, bounds)) >= year) return bounds;
    bounds = boundsAfter(spec, bounds);
  }
  throw new Error('Could not find the first pay period of the year');
}

function toPeriod(spec: PayScheduleSpec, country: PayrollCountry, bounds: Bounds): PayPeriod {
  const payDate = payDateFor(spec, bounds);
  const taxYear = taxYearOf(country, bounds, payDate);
  let periodNumber: number;
  if (country === 'NL' && spec.frequency === 'monthly') {
    periodNumber = Number(bounds.start.slice(5, 7));
  } else {
    periodNumber = 1;
    let cursor = firstBoundsOfYear(spec, country, taxYear);
    while (cursor.start < bounds.start) {
      cursor = boundsAfter(spec, cursor);
      periodNumber += 1;
    }
  }
  return {
    start: bounds.start,
    end: bounds.end,
    payDate,
    frequency: spec.frequency,
    taxYear,
    periodNumber,
    periodsPerYear: PERIODS_PER_YEAR[spec.frequency],
  };
}

/** The pay period containing `date`. */
export function periodContaining(spec: PayScheduleSpec, country: PayrollCountry, date: string): PayPeriod {
  return toPeriod(spec, country, boundsContaining(spec, date));
}

/** The period after `period`. */
export function periodAfter(spec: PayScheduleSpec, country: PayrollCountry, period: Pick<PayPeriod, 'start' | 'end'>): PayPeriod {
  return toPeriod(spec, country, boundsAfter(spec, period));
}

/** The schedule's first period (the one starting on or containing the anchor). */
export function firstPeriod(spec: PayScheduleSpec, country: PayrollCountry): PayPeriod {
  return periodContaining(spec, country, spec.anchorDate);
}

/**
 * The next period to run: the one after the latest run's period, or the
 * schedule's first period when nothing ran yet.
 */
export function nextPeriodToRun(
  spec: PayScheduleSpec,
  country: PayrollCountry,
  lastRunPeriod: Pick<PayPeriod, 'start' | 'end'> | null,
): PayPeriod {
  return lastRunPeriod ? periodAfter(spec, country, lastRunPeriod) : firstPeriod(spec, country);
}

/** The quarter (1–4) a date falls in. */
export function quarterOf(iso: string): number {
  return Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
}

/** Age in whole years on `onDate`. */
export function ageOn(dateOfBirth: string, onDate: string): number {
  const b = parse(dateOfBirth);
  const d = parse(onDate);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}
