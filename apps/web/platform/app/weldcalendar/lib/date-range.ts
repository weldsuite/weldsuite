import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  endOfDay,
  startOfYear,
  endOfYear,
  addDays,
  addMonths,
} from 'date-fns';
import { WEEK_STARTS_ON } from './calendar-format';

export type CalendarView = 'month' | 'week' | '4day' | 'day' | 'year' | 'schedule';

/** Number of days the Schedule view lists, starting at the selected date. */
const SCHEDULE_DAYS = 60;

/**
 * Date range the calendar view fetches events for. Keep in lock-step with the
 * `useCalendarEventsRange` query key — anything that derives a key for
 * prefetching must call this so the cached entry matches what `CalendarView`
 * reads on mount.
 *
 * Every range runs from the start of its first day to the **end** of its last
 * day (23:59:59.999), so events on the last day are never cut off.
 */
export function getCalendarDateRange(date: Date, view: CalendarView): { start: string; end: string } {
  switch (view) {
    case 'month': {
      const ms = startOfMonth(date);
      const me = endOfMonth(date);
      return {
        start: startOfWeek(ms, { weekStartsOn: WEEK_STARTS_ON }).toISOString(),
        end: endOfWeek(me, { weekStartsOn: WEEK_STARTS_ON }).toISOString(),
      };
    }
    case 'week': {
      const ws = startOfWeek(date, { weekStartsOn: WEEK_STARTS_ON });
      return {
        start: ws.toISOString(),
        end: endOfWeek(ws, { weekStartsOn: WEEK_STARTS_ON }).toISOString(),
      };
    }
    case 'day':
      return {
        start: startOfDay(date).toISOString(),
        end: endOfDay(date).toISOString(),
      };
    case '4day': {
      const s = startOfDay(date);
      return {
        start: s.toISOString(),
        end: endOfDay(addDays(s, 3)).toISOString(),
      };
    }
    case 'year':
      return {
        start: startOfYear(date).toISOString(),
        end: endOfYear(date).toISOString(),
      };
    case 'schedule': {
      const s = startOfDay(date);
      return {
        start: s.toISOString(),
        end: endOfDay(addDays(s, SCHEDULE_DAYS - 1)).toISOString(),
      };
    }
    default:
      return {
        start: startOfMonth(date).toISOString(),
        end: endOfMonth(date).toISOString(),
      };
  }
}

/** Months the mobile Month list renders before / after the current month. */
export const MOBILE_MONTHS_BACK = 12;
export const MOBILE_MONTHS_FORWARD = 24;

/**
 * Range the mobile Month view fetches. That view is one continuous list of
 * months around today (not a single month grid), so its event dots need the
 * events of every month it renders. Anchored on `now`, like the list itself.
 */
export function getMobileMonthListRange(now: Date): { start: string; end: string } {
  const anchor = startOfMonth(now);
  return {
    start: addMonths(anchor, -MOBILE_MONTHS_BACK).toISOString(),
    end: endOfMonth(addMonths(anchor, MOBILE_MONTHS_FORWARD)).toISOString(),
  };
}
