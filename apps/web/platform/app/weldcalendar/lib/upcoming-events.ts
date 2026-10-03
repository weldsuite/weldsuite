import { endOfDay, startOfDay } from 'date-fns';
import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';

type Timed = Pick<CalendarEvent, 'startTime' | 'endTime' | 'allDay'>;

/** End of an event, never before its start (bad data would otherwise look like a negative range). */
export function effectiveEnd(event: Pick<CalendarEvent, 'startTime' | 'endTime'>): Date {
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : null;
  return end && !Number.isNaN(end.getTime()) && end.getTime() >= start.getTime() ? end : start;
}

/**
 * Whether an event belongs in an "upcoming" list at `now`: it has not ended
 * yet, so ongoing events stay, and an all-day event of today counts for the
 * whole day (it starts at 00:00, which a "start >= now" test wrongly drops).
 */
export function isUpcomingOrOngoing(event: Timed, now: Date): boolean {
  const start = new Date(event.startTime);
  if (Number.isNaN(start.getTime())) return false;
  const end = effectiveEnd(event);
  if (event.allDay) return endOfDay(end).getTime() >= startOfDay(now).getTime();
  return end.getTime() >= now.getTime();
}
