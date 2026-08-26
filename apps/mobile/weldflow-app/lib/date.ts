/**
 * Date helpers shared by WeldFlow screens.
 *
 * app-api returns ISO timestamps. Formatters tolerate empty/malformed values
 * by returning an em dash so a bad row never crashes a list.
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

export function isTaskOverdue(
  dueDate: string | null | undefined,
  status: string | null | undefined,
): boolean {
  if (!dueDate || status === 'done' || status === 'cancelled') return false;
  const date = parse(dueDate);
  if (!date) return false;
  return date.getTime() < Date.now();
}
