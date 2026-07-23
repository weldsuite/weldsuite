import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  endOfDay,
  addDays,
} from 'date-fns';

export type CalendarView = 'month' | 'week' | '4day' | 'day' | 'year' | 'schedule';

/**
 * Date range the calendar view fetches events for. Keep in lock-step with the
 * `useCalendarEventsRange` query key — anything that derives a key for
 * prefetching must call this so the cached entry matches what `CalendarView`
 * reads on mount.
 */
export function getCalendarDateRange(date: Date, view: CalendarView): { start: string; end: string } {
  switch (view) {
    case 'month': {
      const ms = startOfMonth(date);
      const me = endOfMonth(date);
      return {
        start: startOfWeek(ms, { weekStartsOn: 1 }).toISOString(),
        end: endOfWeek(me, { weekStartsOn: 1 }).toISOString(),
      };
    }
    case 'week': {
      const ws = startOfWeek(date, { weekStartsOn: 1 });
      return {
        start: ws.toISOString(),
        end: addDays(ws, 7).toISOString(),
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
        end: addDays(s, 4).toISOString(),
      };
    }
    case 'year': {
      const yearStart = new Date(date.getFullYear(), 0, 1);
      const yearEnd = new Date(date.getFullYear(), 11, 31);
      return {
        start: yearStart.toISOString(),
        end: yearEnd.toISOString(),
      };
    }
    case 'schedule':
      return {
        start: startOfDay(date).toISOString(),
        end: addDays(date, 60).toISOString(),
      };
    default:
      return {
        start: startOfMonth(date).toISOString(),
        end: endOfMonth(date).toISOString(),
      };
  }
}
