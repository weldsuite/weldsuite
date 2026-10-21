import type { CalendarEvent, UserCalendar } from '@/hooks/queries/use-calendar-queries';

/** Statuses that take a slot off a booking page; a cancelled event frees it. */
const BLOCKING_STATUSES = new Set(['confirmed', 'tentative']);

/**
 * The events that take slots off a booking page, as calendar-api's
 * `computeAvailableSlots` decides it: confirmed or tentative events the page
 * owner organizes, or that sit on a calendar the owner owns. Everything else
 * the viewer can see (a teammate's shared calendar and the tasks on it,
 * cancelled events) has no effect on the page, so the booking view leaves it out.
 *
 * Without an owner nothing can be matched, so nothing is returned.
 */
export function bookingConflictEvents(
  events: readonly CalendarEvent[],
  calendars: readonly UserCalendar[],
  ownerId: string | undefined,
): CalendarEvent[] {
  if (!ownerId) return [];
  const ownerCalendarIds = new Set(calendars.filter((c) => c.ownerId === ownerId).map((c) => c.id));
  return events.filter(
    (evt) =>
      // The column defaults to 'confirmed', so a missing status counts as one.
      BLOCKING_STATUSES.has(evt.status ?? 'confirmed') &&
      (evt.organizerId === ownerId || (!!evt.calendarId && ownerCalendarIds.has(evt.calendarId))),
  );
}
