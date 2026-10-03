import { format, isSameDay, startOfDay } from 'date-fns';
import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';
import { formatClock, formatClockRange, type TimeFormat } from './calendar-format';

type WhenEvent = Pick<CalendarEvent, 'startTime' | 'endTime' | 'allDay'>;

const DAY_FORMAT = 'EEE, MMM d';

/**
 * The "When" summary of an event: the date (range) for all-day events, else the
 * date plus a start - end clock range in the user's 12h/24h preference.
 *
 * An end before the start (bad data) is ignored rather than shown as a
 * negative range; an end on another day names that day.
 */
export function formatEventWhen(event: WhenEvent, timeFormat: TimeFormat): string {
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : null;
  const validEnd = end && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime() ? end : null;

  if (event.allDay) {
    if (validEnd && !isSameDay(start, validEnd) && startOfDay(validEnd).getTime() > startOfDay(start).getTime()) {
      return `${format(start, DAY_FORMAT)} – ${format(validEnd, DAY_FORMAT)}`;
    }
    return format(start, 'EEEE, MMMM d');
  }

  const day = format(start, DAY_FORMAT);
  if (!validEnd) return `${day} · ${formatClock(start, timeFormat)}`;
  if (isSameDay(start, validEnd)) return `${day} · ${formatClockRange(start, validEnd, timeFormat)}`;
  return `${day} · ${formatClock(start, timeFormat)} – ${format(validEnd, DAY_FORMAT)} · ${formatClock(validEnd, timeFormat)}`;
}
