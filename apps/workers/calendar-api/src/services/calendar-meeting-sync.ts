/**
 * Calendar event <-> WeldMeet meeting sync (TASK-724).
 *
 * A calendar event can carry a WeldMeet meeting (`meetings.calendar_event_id`
 * points at the event). The platform creates the meeting first, then the event
 * with `weldMeetingId`; from there calendar-api keeps the meeting in step with
 * the event: title, time, attendees, and cancellation when the event is
 * deleted, cancelled or loses its WeldMeet link.
 *
 * Only meetings that are still `scheduled` are touched. A meeting that is
 * running or finished is history and an edit to its event must not rewrite it.
 *
 * Pure functions, no Hono context. Event access is the caller's concern
 * (same as `pinRescheduledSource`): anyone who may edit the event may sync
 * its meeting, no `meetings:update` check.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import type { CalendarEventRow } from './calendar-events';

type EventAttendees = NonNullable<CalendarEventRow['attendees']>;

/** A meeting the sync changed, in the shape the `meeting` entity event wants. */
export interface MeetingSyncResult {
  id: string;
  title: string;
  status: string;
  /** ISO start of the meeting after the change, or null when unscheduled. */
  startAt: string | null;
  hostId: string;
  /** Status before the change; differs from `status` only when it was cancelled. */
  oldStatus: string;
}

const iso = (d: Date | null | undefined): string | null => d?.toISOString() ?? null;

const sameTime = (a: Date | null | undefined, b: Date | null | undefined): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

function emailOf(a: { email?: string | null }): string {
  return (a.email ?? '').trim().toLowerCase();
}

// ── Attendees ────────────────────────────────────────────────────────────

export interface AttendeeDiff {
  attendees: MeetingAttendee[];
  changed: boolean;
}

/**
 * Apply the change between two versions of an event's attendee list to a
 * meeting's attendees.
 *
 * - People new to the event are appended as pending attendees (unless they are
 *   already on the meeting, by email).
 * - People who were on the event and are gone from it are removed. Nobody else
 *   is: the organizer, walk-in guests and people invited through meet-api were
 *   never on the event's list, so editing the event cannot drop them.
 * - Attendees that stay keep their user id, RSVP and links.
 */
export function applyEventAttendeeChange(
  current: MeetingAttendee[],
  before: EventAttendees | null | undefined,
  after: EventAttendees | null | undefined,
): AttendeeDiff {
  const beforeEmails = new Set((before ?? []).map(emailOf).filter(Boolean));
  const afterByEmail = new Map<string, { email: string; name?: string }>();
  for (const a of after ?? []) {
    const email = emailOf(a);
    if (email && !afterByEmail.has(email)) afterByEmail.set(email, a);
  }

  const removed = new Set([...beforeEmails].filter((e) => !afterByEmail.has(e)));
  const added = [...afterByEmail.keys()].filter((e) => !beforeEmails.has(e));
  if (removed.size === 0 && added.length === 0) return { attendees: current, changed: false };

  const kept = current.filter(
    (a) => !(removed.has(emailOf(a)) && a.role !== 'organizer' && a.source !== 'walk_in'),
  );
  const onMeeting = new Set(kept.map(emailOf));
  const appended: MeetingAttendee[] = [];
  for (const email of added) {
    if (onMeeting.has(email)) continue;
    const name = afterByEmail.get(email)?.name?.trim();
    appended.push({ userId: '', email, name: name || email, status: 'pending', role: 'attendee' });
  }

  const attendees = [...kept, ...appended];
  return { attendees, changed: kept.length !== current.length || appended.length > 0 };
}

// ── Link ─────────────────────────────────────────────────────────────────

/**
 * Point a meeting at its calendar event. Only the meeting's organizer can link
 * it, so nobody can attach (and later cancel through the event) a meeting they
 * do not own. Returns the meeting, or null when it was not linked (missing,
 * deleted, or someone else's).
 */
export async function linkMeetingToEvent(
  db: Database,
  params: { meetingId: string; eventId: string; userId: string },
): Promise<MeetingSyncResult | null> {
  const { meetings } = schema;
  const [row] = await db
    .update(meetings)
    .set({ calendarEventId: params.eventId, updatedAt: new Date() })
    .where(
      and(
        eq(meetings.id, params.meetingId),
        isNull(meetings.deletedAt),
        eq(meetings.organizerId, params.userId),
      ),
    )
    .returning();
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    startAt: iso(row.scheduledStart),
    hostId: row.organizerId,
    oldStatus: row.status,
  };
}

// ── Sync ─────────────────────────────────────────────────────────────────

async function scheduledMeetingsForEvent(db: Database, eventId: string) {
  const { meetings } = schema;
  return db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.calendarEventId, eventId),
        isNull(meetings.deletedAt),
        eq(meetings.status, 'scheduled'),
      ),
    );
}

type MeetingRow = Awaited<ReturnType<typeof scheduledMeetingsForEvent>>[number];

async function cancelMeeting(db: Database, row: MeetingRow): Promise<MeetingSyncResult> {
  const { meetings } = schema;
  await db
    .update(meetings)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(meetings.id, row.id), eq(meetings.status, 'scheduled')));
  return {
    id: row.id,
    title: row.title,
    status: 'cancelled',
    startAt: iso(row.scheduledStart),
    hostId: row.organizerId,
    oldStatus: row.status,
  };
}

/** True when the event no longer carries this meeting's join link. */
function lostMeetingLink(row: MeetingRow, meetingUrl: string | null): boolean {
  const url = meetingUrl?.trim();
  if (!url) return true;
  return row.joinCode ? !url.includes(row.joinCode) : false;
}

/**
 * Cancel every still-scheduled meeting linked to an event (event deleted or
 * cancelled).
 */
export async function cancelMeetingsForEvent(
  db: Database,
  eventId: string,
): Promise<MeetingSyncResult[]> {
  const rows = await scheduledMeetingsForEvent(db, eventId);
  const out: MeetingSyncResult[] = [];
  for (const row of rows) out.push(await cancelMeeting(db, row));
  return out;
}

/**
 * Bring the meetings linked to an event in line with the event's new state.
 * `before` is the event as it was prior to the edit (for the attendee diff),
 * `after` the re-read row. Returns only the meetings that actually changed.
 */
export async function syncMeetingsFromEvent(
  db: Database,
  params: { before: CalendarEventRow; after: CalendarEventRow },
): Promise<MeetingSyncResult[]> {
  const { before, after } = params;
  const { meetings } = schema;
  const rows = await scheduledMeetingsForEvent(db, after.id);
  const out: MeetingSyncResult[] = [];

  for (const row of rows) {
    if (after.deletedAt || after.status === 'cancelled' || lostMeetingLink(row, after.meetingUrl)) {
      out.push(await cancelMeeting(db, row));
      continue;
    }

    const update: Partial<typeof meetings.$inferInsert> = {};
    if (row.title !== after.title) update.title = after.title;
    if (!sameTime(row.scheduledStart, after.startTime)) update.scheduledStart = after.startTime;
    if (!sameTime(row.scheduledEnd, after.endTime)) update.scheduledEnd = after.endTime ?? null;

    const diff = applyEventAttendeeChange(row.attendees ?? [], before.attendees, after.attendees);
    if (diff.changed) update.attendees = diff.attendees;

    if (Object.keys(update).length === 0) continue;

    await db
      .update(meetings)
      .set({ ...update, updatedAt: new Date() })
      .where(and(eq(meetings.id, row.id), eq(meetings.status, 'scheduled')));
    out.push({
      id: row.id,
      title: update.title ?? row.title,
      status: row.status,
      startAt: iso(update.scheduledStart !== undefined ? update.scheduledStart : row.scheduledStart),
      hostId: row.organizerId,
      oldStatus: row.status,
    });
  }

  return out;
}
