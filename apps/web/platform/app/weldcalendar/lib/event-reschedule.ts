import type { CalendarEvent } from '@/hooks/queries/use-calendar-queries';

/** Display length the grid assumes for an event stored without an end time. */
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

/**
 * Attendees a reschedule would email: those with an address that is not the
 * signed-in user's own (the organizer is not mailed about their own move).
 */
export function getNotifiableGuests(
  event: Pick<CalendarEvent, 'attendees'>,
  selfEmail?: string | null,
): NonNullable<CalendarEvent['attendees']> {
  const self = selfEmail?.trim().toLowerCase();
  return (event.attendees ?? []).filter((a) => {
    const email = a.email?.trim().toLowerCase();
    return !!email && email !== self;
  });
}

/** The slot an event occupies right now, as ISO strings: what an Undo restores. */
export function getCurrentSlot(event: Pick<CalendarEvent, 'startTime' | 'endTime'>): {
  startTime: string;
  endTime: string;
} {
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : new Date(start.getTime() + DEFAULT_DURATION_MS);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

/** True when the move changes nothing (same start and end), so there is nothing to persist or announce. */
export function isSameSlot(
  event: Pick<CalendarEvent, 'startTime' | 'endTime'>,
  newStart: Date,
  newEnd: Date,
): boolean {
  const current = getCurrentSlot(event);
  return current.startTime === newStart.toISOString() && current.endTime === newEnd.toISOString();
}
