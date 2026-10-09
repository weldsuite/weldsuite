import { isSameDay, isSameMonth, isSameWeek, isSameYear, subDays } from 'date-fns';

export type NoteBucketId =
  | 'today'
  | 'yesterday'
  | 'this-week'
  | 'this-month'
  | 'this-year'
  | 'older';

/**
 * The single time bucket a note belongs to, relative to `now`.
 *
 * Buckets are mutually exclusive by construction: the checks run from the
 * narrowest span to the widest and the first match wins. Evaluating each
 * bucket independently double-listed notes, e.g. "yesterday" also matched
 * "this month" whenever yesterday fell before the start of the current week.
 */
export function getNoteBucket(createdAt: Date | string | number, now: Date = new Date()): NoteBucketId {
  const date = new Date(createdAt);
  if (isSameDay(date, now)) return 'today';
  if (isSameDay(date, subDays(now, 1))) return 'yesterday';
  if (isSameWeek(date, now, { weekStartsOn: 1 })) return 'this-week';
  if (isSameMonth(date, now)) return 'this-month';
  if (isSameYear(date, now)) return 'this-year';
  return 'older';
}
