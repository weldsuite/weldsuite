/**
 * Deleting a whole calendar (TASK-745).
 *
 * A calendar is deleted together with its events. The events are soft-deleted
 * explicitly, so nothing is left behind that the calendar list no longer
 * reaches, and the side effects a single event delete has (WeldMeet meeting
 * cancelled, optional cancellation mail to attendees) are applied to every
 * event in the calendar.
 *
 * Pure functions, no Hono context. Access checks (owner only, never the
 * default calendar) are the route's concern.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import type { CalendarEventRow } from './calendar-events';

type ImpactRow = Pick<
  CalendarEventRow,
  'startTime' | 'endTime' | 'recurrenceRule' | 'status' | 'attendees'
>;

/**
 * True when deleting this event should mail its attendees a cancellation: it
 * has attendees, it is not already cancelled (they got that mail then), and
 * it has not finished yet. A recurring event counts as upcoming, since later
 * occurrences may still be ahead even when the first one is in the past.
 */
export function needsCancellationMail(row: ImpactRow, now: Date): boolean {
  if (!row.attendees?.length) return false;
  if (row.status === 'cancelled') return false;
  if (row.recurrenceRule) return true;
  const end = row.endTime ?? row.startTime;
  return end.getTime() >= now.getTime();
}

export interface CalendarDeleteImpact {
  /** Every (non-deleted) event the delete removes. */
  eventCount: number;
  /** The upcoming events with attendees, who can be sent a cancellation mail. */
  eventsWithAttendees: number;
}

/** What deleting a calendar would remove, for the confirmation dialog. */
export async function getCalendarDeleteImpact(
  db: Database,
  calendarId: string,
  now: Date = new Date(),
): Promise<CalendarDeleteImpact> {
  const t = schema.calendarEvents;
  const rows = await db
    .select({
      startTime: t.startTime,
      endTime: t.endTime,
      recurrenceRule: t.recurrenceRule,
      status: t.status,
      attendees: t.attendees,
    })
    .from(t)
    .where(and(eq(t.calendarId, calendarId), isNull(t.deletedAt)));

  return {
    eventCount: rows.length,
    eventsWithAttendees: rows.filter((r) => needsCancellationMail(r, now)).length,
  };
}

/** The calendar's non-deleted events, read before they are soft-deleted. */
export async function listCalendarEventsForDeletion(
  db: Database,
  calendarId: string,
): Promise<CalendarEventRow[]> {
  const t = schema.calendarEvents;
  return db
    .select()
    .from(t)
    .where(and(eq(t.calendarId, calendarId), isNull(t.deletedAt)));
}

/**
 * Of the given events, the ids that still have a scheduled WeldMeet meeting
 * linked. One query, so the caller only runs the per-event cancel for events
 * that actually carry a meeting.
 */
export async function eventIdsWithScheduledMeetings(
  db: Database,
  eventIds: string[],
): Promise<string[]> {
  if (eventIds.length === 0) return [];
  const { meetings } = schema;
  const rows = await db
    .selectDistinct({ eventId: meetings.calendarEventId })
    .from(meetings)
    .where(
      and(
        inArray(meetings.calendarEventId, eventIds),
        isNull(meetings.deletedAt),
        eq(meetings.status, 'scheduled'),
      ),
    );
  return rows.map((r) => r.eventId).filter((id): id is string => !!id);
}

/**
 * Soft-delete a calendar, its events and its shares. Events go first so a
 * failure part-way never leaves live events in a deleted calendar.
 */
export async function softDeleteCalendar(db: Database, calendarId: string): Promise<void> {
  const { calendars, calendarEvents, calendarShares } = schema;
  const now = new Date();

  await db
    .update(calendarEvents)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(calendarEvents.calendarId, calendarId), isNull(calendarEvents.deletedAt)));

  await db
    .update(calendarShares)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(calendarShares.calendarId, calendarId), isNull(calendarShares.deletedAt)));

  await db
    .update(calendars)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(calendars.id, calendarId), isNull(calendars.deletedAt)));
}
