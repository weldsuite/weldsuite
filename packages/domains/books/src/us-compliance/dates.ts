/**
 * Calendar-date helpers for the US compliance code. Dates are `YYYY-MM-DD`
 * strings; arithmetic goes through UTC so a time zone never moves a due date.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  y: number;
  m: number;
  d: number;
}

export function isIsoDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const match = ISO_DAY.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function parseIso(value: string): DateParts {
  if (!isIsoDate(value)) throw new Error(`Invalid date: ${value}`);
  const match = ISO_DAY.exec(value) as RegExpExecArray;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function formatIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
  const { y, m, d } = parseIso(value);
  return fromUtc(Date.UTC(y, m - 1, d + days));
}

/** Adds calendar months; the day is clamped to the end of a shorter month. */
export function addMonths(value: string, months: number): string {
  const { y, m, d } = parseIso(value);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return formatIso(year, month, Math.min(d, daysInMonth(year, month)));
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function diffDays(a: string, b: string): number {
  const pa = parseIso(a);
  const pb = parseIso(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(value: string): number {
  const { y, m, d } = parseIso(value);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function lastDayOfMonth(y: number, m: number): string {
  return formatIso(y, m, daysInMonth(y, m));
}

export function endOfMonth(value: string): string {
  const { y, m } = parseIso(value);
  return lastDayOfMonth(y, m);
}

export function startOfMonth(value: string): string {
  const { y, m } = parseIso(value);
  return formatIso(y, m, 1);
}

export function yearOf(value: string): number {
  return parseIso(value).y;
}

/** The date `day` of `month` (1-12) in a year, with `day` clamped to the month's length. */
export function dateIn(y: number, m: number, day: number): string {
  const index = y * 12 + (m - 1);
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return formatIso(year, month, Math.min(day, daysInMonth(year, month)));
}

/** The nth (1-based) given weekday of a month, e.g. the 3rd Monday of January. */
export function nthWeekdayOfMonth(y: number, m: number, weekday: number, n: number): string {
  const first = weekdayOf(formatIso(y, m, 1));
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return formatIso(y, m, day);
}

/** The last given weekday of a month. */
export function lastWeekdayOfMonth(y: number, m: number, weekday: number): string {
  const last = lastDayOfMonth(y, m);
  const back = (weekdayOf(last) - weekday + 7) % 7;
  return addDays(last, -back);
}

export function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

export function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}
