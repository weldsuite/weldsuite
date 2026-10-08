/**
 * Calendar-date helpers for tax points. Dates are `YYYY-MM-DD` strings and are
 * compared as text; arithmetic goes through UTC so a time zone never moves a
 * tax point.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** The `YYYY-MM-DD` part of a date string or the UTC day of a Date. */
export function isoDay(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.trim().slice(0, 10);
}

export function isIsoDay(value: string | null | undefined): value is string {
  return Boolean(value && ISO_DAY.test(value));
}

function parts(value: string): { y: number; m: number; d: number } {
  const match = ISO_DAY.exec(value.trim());
  if (!match) throw new Error(`Invalid date: ${value}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(value: string, days: number): string {
  const { y, m, d } = parts(value);
  return isoDay(new Date(Date.UTC(y, m - 1, d + days)));
}

/** Adds calendar months; the day is clamped to the end of a shorter month. */
export function addMonths(value: string, months: number): string {
  const { y, m, d } = parts(value);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return format(year, month, Math.min(d, daysInMonth(year, month)));
}

/** 31 December of the date's year. */
export function endOfYear(value: string): string {
  const { y } = parts(value);
  return format(y, 12, 31);
}

/** `from <= date` and (`to` empty or `date <= to`). Empty `from` = no lower bound. */
export function inRange(date: string, from?: string | null, to?: string | null): boolean {
  const day = isoDay(date);
  if (from && day < isoDay(from)) return false;
  if (to && day > isoDay(to)) return false;
  return true;
}
