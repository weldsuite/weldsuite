/**
 * Date helpers shared by WeldFlow screens.
 *
 * app-api returns ISO timestamps. Formatters tolerate empty/malformed values
 * by returning an em dash so a bad row never crashes a list.
 */

const DASH = '—';

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  // A bare "YYYY-MM-DD" is a calendar day; `new Date()` would read it as UTC
  // midnight, which is the previous day west of Greenwich.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
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

/**
 * A due date is a calendar day: the task is overdue once that day has passed,
 * not from midnight at its start. Same day-based rule as the server's
 * `dueDateBucket: 'overdue'`, so a row and the Overdue count agree.
 */
export function isTaskOverdue(
  dueDate: string | null | undefined,
  status: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!dueDate || status === 'done' || status === 'cancelled') return false;
  const date = parse(dueDate);
  if (!date) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return dueDay.getTime() < startOfToday.getTime();
}
