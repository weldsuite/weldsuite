/**
 * Pure helpers for the Schedule (list) view: which group a day falls into and
 * how a row's time is written.
 */

import { addDays, addWeeks, endOfWeek, isSameDay, isSameMonth, startOfDay, startOfWeek } from 'date-fns';
import { formatClock, formatClockRange, WEEK_STARTS_ON, type TimeFormat } from './calendar-format';

export type ScheduleGroup =
  | 'earlier'
  | 'yesterday'
  | 'today'
  | 'tomorrow'
  | 'this_week'
  | 'next_week'
  | 'this_month'
  | 'later';

/**
 * Group a day relative to `now`. Boundaries follow the calendar's own week
 * (Monday to Sunday):
 *
 * - yesterday / today / tomorrow win over everything else;
 * - this week: the rest of the current week (and days earlier this week);
 * - next week: the whole of next week, from its Monday 00:00 to Sunday end;
 * - this month: later days of the current month, beyond next week;
 * - earlier: anything before the current week that is not yesterday;
 * - later: everything else.
 */
export function getDateGroup(date: Date, now: Date = new Date()): ScheduleGroup {
  if (isSameDay(date, addDays(now, -1))) return 'yesterday';
  if (isSameDay(date, now)) return 'today';
  if (isSameDay(date, addDays(now, 1))) return 'tomorrow';

  const thisWeekStart = startOfWeek(now, { weekStartsOn: WEEK_STARTS_ON });
  const thisWeekEnd = endOfWeek(now, { weekStartsOn: WEEK_STARTS_ON });
  if (date >= thisWeekStart && date <= thisWeekEnd) return 'this_week';

  const nextWeekStart = startOfWeek(addWeeks(now, 1), { weekStartsOn: WEEK_STARTS_ON });
  const nextWeekEnd = endOfWeek(addWeeks(now, 1), { weekStartsOn: WEEK_STARTS_ON });
  if (date >= nextWeekStart && date <= nextWeekEnd) return 'next_week';

  if (startOfDay(date) < thisWeekStart) return 'earlier';
  if (isSameMonth(date, now)) return 'this_month';
  return 'later';
}

/**
 * "11:00 AM – 11:30 AM" / "11:00 – 11:30". Shows just the start when there is
 * no end, or when the end is not after the start (bad data must not read as a
 * backwards range). `allDayLabel` replaces the time for all-day rows.
 */
export function formatEventTimeRange(start: Date, end: Date | null, timeFormat: TimeFormat): string {
  if (!end || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    return formatClock(start, timeFormat);
  }
  return formatClockRange(start, end, timeFormat);
}

/** Time column of the schedule list: the all-day label, a start – end range, or just the start. */
export function formatScheduleTime(
  start: Date,
  end: Date | null,
  allDayLabel: string | null,
  timeFormat: TimeFormat,
): string {
  if (allDayLabel) return allDayLabel;
  return formatEventTimeRange(start, end, timeFormat);
}
