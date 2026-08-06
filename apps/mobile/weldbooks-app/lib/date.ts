/**
 * Date helpers shared by the WeldBooks screens.
 *
 * app-api returns ISO timestamps; the forms collect `YYYY-MM-DD`. Every
 * formatter here tolerates a malformed/empty value by returning an em dash so a
 * bad row never crashes a list.
 */

const DASH = '—';

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "5 Aug 2026" */
export function formatDate(value: string | null | undefined, locale = 'en-GB'): string {
  const date = parse(value);
  if (!date) return DASH;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "5 Aug" — for dense rows where the year is implied. */
export function formatShortDate(value: string | null | undefined, locale = 'en-GB'): string {
  const date = parse(value);
  if (!date) return DASH;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `YYYY-MM-DD`, the format every WeldBooks form field expects.
 *
 * A `Date` is read in LOCAL time — `new Date(y, m, 1)` is local midnight, and
 * going through `toISOString()` would push it back a day for anyone east of
 * UTC, so "this month" would start on the 31st of the previous month. An ISO
 * STRING from app-api is read in UTC, which is how those timestamps are
 * anchored.
 */
export function toDateInput(value: Date | string | null | undefined): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const date = parse(value);
  if (!date) return '';
  return date.toISOString().split('T')[0];
}

export function today(): string {
  return toDateInput(new Date());
}

export function addDays(days: number, from: Date = new Date()): string {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return toDateInput(date);
}

/**
 * Whole days until `value` — negative once it has passed. Used to flag overdue
 * invoices, which app-api derives rather than storing as a status.
 */
export function daysUntil(value: string | null | undefined): number | null {
  const date = parse(value);
  if (!date) return null;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
}

/** True when a document is past due and still has an open balance. */
export function isOverdue(dueDate: string | null | undefined, balanceDue: number): boolean {
  if (balanceDue <= 0) return false;
  const days = daysUntil(dueDate);
  return days !== null && days < 0;
}

/** First and last day of the current month as `YYYY-MM-DD`. */
export function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: toDateInput(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: toDateInput(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
}

/** First and last day of the current year as `YYYY-MM-DD`. */
export function currentYearRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: toDateInput(new Date(now.getFullYear(), 0, 1)),
    to: toDateInput(new Date(now.getFullYear(), 11, 31)),
  };
}
