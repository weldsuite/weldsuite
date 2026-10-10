/**
 * Federal due dates: business days and legal holidays.
 *
 * Pub 15 (2026) section 11, "Deposits Due on Business Days Only": a business
 * day is any day other than a Saturday, Sunday or legal holiday, and "legal
 * holiday" means any legal holiday in the District of Columbia. The list for
 * 2026 in Pub 15 (New Year's Day, Martin Luther King Jr.'s Birthday,
 * Washington's Birthday, DC Emancipation Day, Memorial Day, Juneteenth,
 * Independence Day (observed 3 July), Labor Day, Columbus Day, Veterans Day,
 * Thanksgiving, Christmas) is reproduced by the rules below; Inauguration
 * Day (20 January after a presidential election year) is a DC holiday too.
 * A holiday on a Saturday is observed the Friday before, on a Sunday the
 * Monday after. Filing due dates move the same way (Pub 15, "Calendar").
 */

import { addDays, weekday } from '../periods';

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The `n`th (1-based) `dow` (0 = Sunday) of a month; n = -1 for the last. */
function nthWeekday(year: number, month: number, dow: number, n: number): string {
  if (n > 0) {
    const first = ymd(year, month, 1);
    const offset = (dow - weekday(first) + 7) % 7;
    return addDays(first, offset + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = ymd(year, month, lastDay);
  const back = (weekday(last) - dow + 7) % 7;
  return addDays(last, -back);
}

function observed(date: string): string {
  const d = weekday(date);
  if (d === 6) return addDays(date, -1);
  if (d === 0) return addDays(date, 1);
  return date;
}

/** DC legal holidays observed in `year` (sorted). */
export function legalHolidays(year: number): string[] {
  const fixed = (y: number) => [
    observed(ymd(y, 1, 1)),
    observed(ymd(y, 4, 16)),
    observed(ymd(y, 6, 19)),
    observed(ymd(y, 7, 4)),
    observed(ymd(y, 11, 11)),
    observed(ymd(y, 12, 25)),
  ];
  const days = [
    ...fixed(year),
    // New Year's Day of the next year observed on 31 December.
    ...fixed(year + 1).filter((d) => d.startsWith(`${year}-`)),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    nthWeekday(year, 5, 1, -1),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 10, 1, 2),
    nthWeekday(year, 11, 4, 4),
  ];
  // Inauguration Day: 20 January of the year after a presidential election (Sunday → Monday).
  if ((year - 1) % 4 === 0) {
    const inauguration = ymd(year, 1, 20);
    days.push(weekday(inauguration) === 0 ? addDays(inauguration, 1) : inauguration);
  }
  return [...new Set(days.filter((d) => d.startsWith(`${year}-`)))].sort();
}

const holidayCache = new Map<number, Set<string>>();

export function isLegalHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  let set = holidayCache.get(year);
  if (!set) {
    set = new Set(legalHolidays(year));
    holidayCache.set(year, set);
  }
  return set.has(date);
}

export function isBusinessDay(date: string): boolean {
  const d = weekday(date);
  return d !== 0 && d !== 6 && !isLegalHoliday(date);
}

/** `date` itself when it is a business day, else the next one. */
export function onOrNextBusinessDay(date: string): string {
  let d = date;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** The `n`th business day after `date` (not counting `date`). */
export function businessDaysAfter(date: string, n: number): string {
  let d = date;
  let count = 0;
  while (count < n) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) count += 1;
  }
  return d;
}

export function lastDayOfMonth(year: number, month: number): string {
  return ymd(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
}

/** Calendar quarter bounds. */
export function quarterBounds(year: number, quarter: 1 | 2 | 3 | 4): { start: string; end: string } {
  const firstMonth = (quarter - 1) * 3 + 1;
  return { start: ymd(year, firstMonth, 1), end: lastDayOfMonth(year, firstMonth + 2) };
}

/** Last day of the month after the quarter, moved to the next business day (941, quarterly state returns). */
export function quarterlyReturnDueDate(year: number, quarter: 1 | 2 | 3 | 4): string {
  const month = quarter * 3 + 1;
  return onOrNextBusinessDay(month > 12 ? lastDayOfMonth(year + 1, 1) : lastDayOfMonth(year, month));
}

/** 31 January of the next year, moved to the next business day (940, W-2, W-3). */
export function annualReturnDueDate(taxYear: number): string {
  return onOrNextBusinessDay(ymd(taxYear + 1, 1, 31));
}
