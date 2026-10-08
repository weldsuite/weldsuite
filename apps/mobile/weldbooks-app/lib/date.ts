/**
 * Date helpers shared by the WeldBooks screens.
 *
 * app-api returns ISO timestamps; the forms collect `YYYY-MM-DD` (US entities
 * type MM/DD/YYYY). Every formatter here tolerates a malformed/empty value by
 * returning an em dash so a bad row never crashes a list.
 *
 * Accounting dates are calendar dates, not instants. app-api stores an issue or
 * due date as midnight UTC, and `new Date(...).toLocaleDateString()` would show
 * the day before for everyone west of UTC — every US user. So a date-only string
 * or a UTC-midnight timestamp keeps the day it was written with; any other
 * timestamp is an instant and becomes the device's local day.
 */

const DASH = '—';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const MIDNIGHT_UTC = /^\d{4}-\d{2}-\d{2}(T00:00(:00(\.0+)?)?(Z|[+-]00:?00)?)?$/;

const US_LOCALE = /^en[-_]US$/i;

interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The calendar day of an API value, or null when it isn't a date. */
function calendarDay(value: string | null | undefined): CalendarDay | null {
  if (!value) return null;
  const trimmed = value.trim();
  const iso = ISO_DATE.exec(trimmed);
  if (iso && MIDNIGHT_UTC.test(trimmed)) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }
  const instant = parse(trimmed);
  if (!instant) return null;
  return { year: instant.getFullYear(), month: instant.getMonth() + 1, day: instant.getDate() };
}

/** UTC noon of a calendar day: formatting it in UTC can never slip to a neighbouring day. */
function noonUtc({ year, month, day }: CalendarDay): Date {
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/** "5 Aug 2026" — or "08/05/2026" when the locale is US English. */
export function formatDate(value: string | null | undefined, locale = 'en-GB'): string {
  const day = calendarDay(value);
  if (!day) return DASH;
  const options: Intl.DateTimeFormatOptions = US_LOCALE.test(locale)
    ? { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
  return noonUtc(day).toLocaleDateString(locale, options);
}

/** "5 Aug" — or "08/05" for US English — for dense rows where the year is implied. */
export function formatShortDate(value: string | null | undefined, locale = 'en-GB'): string {
  const day = calendarDay(value);
  if (!day) return DASH;
  const options: Intl.DateTimeFormatOptions = US_LOCALE.test(locale)
    ? { month: '2-digit', day: '2-digit', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', timeZone: 'UTC' };
  return noonUtc(day).toLocaleDateString(locale, options);
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

// ---------------------------------------------------------------------------
// Typing dates
// ---------------------------------------------------------------------------

function isRealDay(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** What a date field shows as its placeholder in this locale. */
export function dateInputPlaceholder(locale: string): string {
  return US_LOCALE.test(locale) ? 'MM/DD/YYYY' : 'YYYY-MM-DD';
}

/** A `YYYY-MM-DD` date as the field shows it: MM/DD/YYYY for US English, otherwise unchanged. */
export function formatDateInput(isoDate: string, locale: string): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match || !US_LOCALE.test(locale)) return isoDate;
  return `${match[2]}/${match[3]}/${match[1]}`;
}

/**
 * What the user typed in a date field → `YYYY-MM-DD`, or null when it isn't a
 * real calendar day. ISO is always accepted; US English also takes M/D/YYYY and
 * M/D/YY, every other locale D-M-YYYY or D/M/YYYY (day first).
 */
export function parseDateInput(text: string, locale: string): string | null {
  const trimmed = text.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isRealDay(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
  }

  const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(trimmed);
  if (!parts) return null;
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  const year = parts[3].length === 2 ? 2000 + Number(parts[3]) : Number(parts[3]);
  const [month, day] = US_LOCALE.test(locale) ? [first, second] : [second, first];
  return isRealDay(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
}

/**
 * Whole days until `value` — negative once it has passed. Used to flag overdue
 * invoices, which app-api derives rather than storing as a status.
 */
export function daysUntil(value: string | null | undefined): number | null {
  const due = calendarDay(value);
  if (!due) return null;
  const now = new Date();
  const todayDay: CalendarDay = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  return Math.round((noonUtc(due).getTime() - noonUtc(todayDay).getTime()) / 86_400_000);
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
