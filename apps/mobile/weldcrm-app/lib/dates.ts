/**
 * Date helpers for task due dates.
 *
 * A due date is a calendar day. It is stored as local noon so it stays on the
 * same day in any timezone within half a day of the phone's.
 */

import type { Translations } from './i18n/locales/en';

const DAY_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a stored due date; null for empty or malformed values. */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/** Local noon, `offsetDays` from `from`. */
export function dueDateFromToday(offsetDays: number, from: Date = new Date()): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + offsetDays, 12);
}

export function isToday(date: Date, now: Date = new Date()): boolean {
  return isSameDay(date, now);
}

export function isTomorrow(date: Date, now: Date = new Date()): boolean {
  return isSameDay(date, dueDateFromToday(1, now));
}

/** Strictly before today (a task due today is not overdue until the day has passed). */
export function isOverdue(date: Date, now: Date = new Date()): boolean {
  return startOfDay(date).getTime() < startOfDay(now).getTime();
}

/** After tomorrow, within the next 7 days. */
export function isThisWeek(date: Date, now: Date = new Date()): boolean {
  const day = startOfDay(date).getTime();
  const today = startOfDay(now).getTime();
  return day > today && day <= startOfDay(dueDateFromToday(7, now)).getTime();
}

/** "2026-08-05" in local time, for the date text field. */
export function toDateInput(date: Date | null | undefined): string {
  if (!date) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export type DateInputResult =
  | { date: Date | null; error?: undefined }
  | { date?: undefined; error: 'invalidDate' };

/**
 * Parse the date text field ("2026-08-05") to local noon. Empty input is a
 * valid "no date" (`{ date: null }`); anything that is not a real calendar
 * day (2026-02-31, 05/08/2026) is `{ error: 'invalidDate' }`.
 */
export function parseDateInput(input: string): DateInputResult {
  const trimmed = input.trim();
  if (!trimmed) return { date: null };
  const match = DAY_INPUT.exec(trimmed);
  if (!match) return { error: 'invalidDate' };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day, 12);
  const real = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return real ? { date } : { error: 'invalidDate' };
}

/** "Today", "Tomorrow", or "5 Aug" in the given locale. */
export function formatDueLabel(
  date: Date,
  t: Pick<Translations, 'common'>,
  locale: string,
  now: Date = new Date(),
): string {
  if (isToday(date, now)) return t.common.today;
  if (isTomorrow(date, now)) return t.common.tomorrow;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
