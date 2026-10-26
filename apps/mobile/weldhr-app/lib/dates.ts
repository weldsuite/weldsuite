/**
 * Calendar-date helpers. WeldHR sends dates as `YYYY-MM-DD` strings in the
 * workspace's calendar (no time zone), so everything here works on those
 * strings and on local dates, never on UTC instants.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` for a local date. */
export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today in the phone's calendar. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now);
}

/** A local Date at midnight for a `YYYY-MM-DD` string; null when it is not one. */
export function parseIsoDate(value: string | null | undefined): Date | null {
  const match = value ? ISO_DATE.exec(value) : null;
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return toIsoDate(date) === value ? date : null;
}

export function addDays(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

export function isWeekend(iso: string): boolean {
  const day = parseIsoDate(iso)?.getDay();
  return day === 0 || day === 6;
}

/** The first Monday–Friday after `iso`. */
export function nextWeekday(iso: string): string {
  let day = addDays(iso, 1);
  while (isWeekend(day)) day = addDays(day, 1);
  return day;
}

/**
 * Mon–Fri days from `start` to `end`, inclusive. The server decides the real
 * number (half days, holidays); this is the estimate shown while filling in a
 * request.
 */
export function weekdaysBetween(start: string, end: string): number {
  if (!parseIsoDate(start) || !parseIsoDate(end) || end < start) return 0;
  let count = 0;
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (!isWeekend(day)) count += 1;
  }
  return count;
}

/** Monday-first weeks covering the month of `year`/`month` (0-based); null pads the edges. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = (first.getDay() + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(toIsoDate(new Date(year, month, day)));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The Monday of the week `iso` falls in. */
export function startOfWeek(iso: string): string {
  const day = parseIsoDate(iso)?.getDay();
  if (day == null) return iso;
  return addDays(iso, -((day + 6) % 7));
}

/** The ISO 8601 week number ("Week 43"): weeks start on Monday, week 1 holds the year's first Thursday. */
export function isoWeek(iso: string): number {
  const date = parseIsoDate(iso);
  if (!date) return 0;
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const diffDays = Math.round((thursday.getTime() - firstThursday.getTime()) / 86_400_000);
  return 1 + Math.round((diffDays - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
}

/** Monday-first weeks covering the month of `iso`, padded with the days of the months around it. */
export function monthWeeks(iso: string): string[][] {
  const date = parseIsoDate(iso) ?? new Date();
  const first = toIsoDate(new Date(date.getFullYear(), date.getMonth(), 1));
  const last = toIsoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
  const weeks: string[][] = [];
  for (let monday = startOfWeek(first); monday <= last; monday = addDays(monday, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(monday, i)));
  }
  return weeks;
}

/** The local calendar day of an ISO timestamp (a shift's start), or the date part when it does not parse. */
export function dayOf(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp.slice(0, 10) : toIsoDate(date);
}
