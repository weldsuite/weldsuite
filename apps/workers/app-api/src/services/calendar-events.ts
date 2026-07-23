/**
 * Calendar event reads + auto-schedule pinning.
 *
 * Ported from apps/api-worker/src/routes/calendar/events.ts (W5b of the
 * legacy-worker phase-out). Pure functions, no Hono context.
 *
 * The date-windowed reads (`range` / `upcoming`) are what the calendar grid
 * and the "upcoming" widgets run on; the pin/unpin pair keeps a calendar
 * event and the task/activity that spawned it in sync so the auto-scheduler
 * doesn't move a slot the user chose by hand.
 */

import { and, asc, eq, gte, isNull, inArray, lte } from 'drizzle-orm';
import { updateCalendarEventForTask } from '@weldsuite/db/lib/calendar-sync';
import type { Database } from '../db';
import { schema } from '../db';

export type CalendarEventRow = typeof schema.calendarEvents.$inferSelect;

/**
 * Events starting inside [startDate, endDate] across the given calendars,
 * ascending. Un-paginated by design — the calendar grid renders a whole
 * window at once (legacy `GET /calendar/events/range`).
 */
export async function listEventsInRange(
  db: Database,
  params: { calendarIds: string[]; startDate: Date; endDate: Date },
): Promise<CalendarEventRow[]> {
  const { calendarEvents } = schema;
  if (params.calendarIds.length === 0) return [];

  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        isNull(calendarEvents.deletedAt),
        inArray(calendarEvents.calendarId, params.calendarIds),
        gte(calendarEvents.startTime, params.startDate),
        lte(calendarEvents.startTime, params.endDate),
      ),
    )
    .orderBy(asc(calendarEvents.startTime));
}

/**
 * Confirmed events starting in the next `days` days, ascending, capped at
 * `limit` (legacy `GET /calendar/events/upcoming`).
 */
export async function listUpcomingEvents(
  db: Database,
  params: { calendarIds: string[]; days: number; limit: number },
): Promise<CalendarEventRow[]> {
  const { calendarEvents } = schema;
  if (params.calendarIds.length === 0) return [];

  const now = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + params.days);

  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        isNull(calendarEvents.deletedAt),
        inArray(calendarEvents.calendarId, params.calendarIds),
        gte(calendarEvents.startTime, now),
        lte(calendarEvents.startTime, endDate),
        eq(calendarEvents.status, 'confirmed'),
      ),
    )
    .orderBy(asc(calendarEvents.startTime))
    .limit(params.limit);
}

/**
 * Write a hand-picked slot back to the entity that spawned the event and pin
 * the event so the auto-scheduler leaves it alone.
 *
 * Only ever called for `manual: true` reschedules — a programmatic reschedule
 * (cron sweep, cascading bump) is just re-placing the event into a better
 * slot and must NOT pin it.
 */
export async function pinRescheduledSource(
  db: Database,
  params: {
    event: Pick<CalendarEventRow, 'id' | 'sourceId' | 'sourceType' | 'autoScheduled'>;
    startTime: Date;
    endTime: Date | null;
  },
): Promise<void> {
  const { calendarEvents, tasks, crmActivities } = schema;
  const { event, startTime, endTime } = params;
  if (!event.sourceId) return;

  if (event.sourceType === 'task') {
    await db
      .update(tasks)
      .set({ startDate: startTime, updatedAt: new Date() })
      .where(eq(tasks.id, event.sourceId));
  } else if (event.sourceType === 'activity') {
    // Activities need a concrete end; default to a 30-minute block like legacy.
    const activityEnd = endTime ?? new Date(startTime.getTime() + 30 * 60000);
    await db
      .update(crmActivities)
      .set({ startTime, endTime: activityEnd, updatedAt: new Date() })
      .where(eq(crmActivities.id, event.sourceId));
  }

  if (event.autoScheduled) {
    await db
      .update(calendarEvents)
      .set({ autoScheduled: false, updatedAt: new Date() })
      .where(and(eq(calendarEvents.id, event.id), isNull(calendarEvents.deletedAt)));
  }
}

/**
 * Release a pinned event back to the auto-scheduler: clear the pinned
 * start on the source entity, flip `autoScheduled` back on, and (for tasks)
 * immediately re-place the event via the standard scheduler so it doesn't
 * sit on a stale slot until the next cron sweep.
 */
export async function unpinEvent(
  db: Database,
  event: Pick<CalendarEventRow, 'id' | 'sourceId' | 'sourceType'>,
): Promise<void> {
  const { calendarEvents, tasks, crmActivities } = schema;

  await db
    .update(calendarEvents)
    .set({ autoScheduled: true, updatedAt: new Date() })
    .where(and(eq(calendarEvents.id, event.id), isNull(calendarEvents.deletedAt)));

  if (!event.sourceId) return;

  if (event.sourceType === 'task') {
    await db
      .update(tasks)
      .set({ startDate: null, updatedAt: new Date() })
      .where(eq(tasks.id, event.sourceId));

    // Re-place via the shared auto-scheduler, anchored on the task's real due date.
    const [linkedTask] = await db
      .select({ dueDate: tasks.dueDate })
      .from(tasks)
      .where(eq(tasks.id, event.sourceId))
      .limit(1);

    await updateCalendarEventForTask(db, {
      calendarEventId: event.id,
      dueDate: linkedTask?.dueDate ? new Date(linkedTask.dueDate) : undefined,
    });
  } else if (event.sourceType === 'activity') {
    await db
      .update(crmActivities)
      .set({ startTime: null, endTime: null, updatedAt: new Date() })
      .where(eq(crmActivities.id, event.sourceId));
  }
}
