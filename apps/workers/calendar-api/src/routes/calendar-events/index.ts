/**
 * Calendar event routes — flat /api/calendar-events/* surface backed by
 * `calendarEvents`.
 *
 * Successor to api-worker's `/api/calendar/events/*` (W5b of the legacy-worker
 * phase-out). What came across on top of the previous CRUD shell:
 *   - date-range filtering on the list, plus `/range` and `/upcoming`
 *     (the calendar grid and the upcoming widgets run on these);
 *   - attendee mail — Resend invite / reschedule / cancellation with an ICS
 *     attachment, driven by `?sendNotification=true` on update + delete (the
 *     "notify attendees?" dialog) and sent unconditionally on create, cancel
 *     and reschedule, exactly as the legacy route did. An update that sets the
 *     status to cancelled mails the cancellation, one that takes it off
 *     cancelled mails that the event is on again;
 *   - `/:id/reschedule` + `/:id/unpin`, which also pin/unpin the linked
 *     `tasks.startDate` (or the CRM activity's start/end) so the
 *     auto-scheduler respects a hand-picked slot;
 *   - Google Calendar outbound push — every mutation below fires
 *     `pushCalendarEventToGoogle(...)` through `waitUntil`, mirroring the legacy
 *     route's five dispatch sites. Without it, workspaces with an active
 *     `google_calendar` connection silently stop syncing to Google. Failures are
 *     swallowed inside the sync (see lib/integrations/sync/outbound-calendar-sync).
 *
 * Access model (from the legacy route): events are reachable through the
 * calendars the caller can see — the ones they own plus the ones shared with
 * them — not by `organizerId`. See services/calendar-access.ts. `events:scope:all`
 * is intentionally not consulted: sharing is the access mechanism here, and
 * widening the calendar grid to every member's events is not the product.
 *
 * Permissions mirror the legacy route exactly:
 *   events:read | events:create | events:update | events:delete
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  getAccessibleCalendarIds,
  getCalendarAccess,
  resolveRequestedCalendarIds,
} from '../../services/calendar-access';
import {
  listEventsInRange,
  listUpcomingEvents,
  pinRescheduledSource,
  unpinEvent,
} from '../../services/calendar-events';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import {
  getMemberEmails,
  getOrganizerInfo,
  getWorkspaceLanguage,
  nextIcsSequence,
  sendCalendarEventEmails,
  type AttendeeLike,
  type CalendarMailEvent,
  type SendOptions,
} from '../../services/calendar-mail';
import { timeZoneSchema } from '../../services/calendar-timezone';
import {
  cancelMeetingsForEvent,
  linkMeetingToEvent,
  syncMeetingsFromEvent,
  type MeetingSyncResult,
} from '../../services/calendar-meeting-sync';
import { pushCalendarEventToGoogle } from '../../lib/integrations/sync/outbound-calendar-sync';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.calendarEvents;

// ── Validation ───────────────────────────────────────────────────────────
//
// Defined locally rather than pulled from
// `@weldsuite/core-api-client/schemas/calendar-events`: that schema models a
// different table shape (`startsAt`/`endsAt`/`isAllDay`, `attendees: string[]`)
// and would reject every real WeldCalendar payload while letting a row through
// with no `startTime` — which the NOT NULL column then rejects at the DB.
// These mirror the legacy route and the `calendar_events` columns.

/** `null` from a client that serialises "no value" is treated as absent. */
const optionalText = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

/**
 * An attendee is identified by email alone: workspace members, CRM contacts and
 * external guests all arrive as `{ email, name? }` (plus optional status/role),
 * and every one of them is mailed the invite. Unknown keys (a client-side id or
 * type) are stripped.
 */
const attendeeSchema = z.object({
  email: z.string().trim().email(),
  name: optionalText,
  status: optionalText,
  role: optionalText,
});

/** One entry per email address (case-insensitive) so nobody is invited twice. */
const attendeesSchema = z.array(attendeeSchema).transform((list) => {
  const seen = new Set<string>();
  return list.filter((a) => {
    const key = a.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

/** True for an absolute http(s) URL. `new URL` alone also accepts `javascript:`, `data:` etc. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Join link of a video meeting. Only http(s): the link is rendered as a clickable
 * button in the platform and in attendee mail, so `javascript:alert(1)` must not
 * get through. An empty string is allowed: it is how a client clears the link.
 */
const meetingUrlSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || isHttpUrl(v), 'meetingUrl must be an http(s) URL');

const createSchema = z.object({
  calendarId: z.string().min(1),
  // Trimmed first, so a title of only spaces is rejected like an empty one.
  title: z.string().trim().min(1).max(255),
  description: z.string().optional(),
  type: z.enum(['meeting', 'call', 'appointment', 'event', 'reminder', 'other']).default('meeting'),
  startTime: z.string().min(1),
  endTime: z.string().optional(),
  allDay: z.boolean().optional(),
  /** IANA zone the event is scheduled in (e.g. Europe/Amsterdam); mails render times in it. */
  timezone: timeZoneSchema.optional(),
  location: z.string().optional(),
  isVirtual: z.boolean().optional(),
  meetingUrl: meetingUrlSchema.optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  color: z.string().optional(),
  recurrenceRule: z.string().optional(),
  recurrenceId: z.string().optional(),
  attendees: attendeesSchema.optional(),
  reminders: z
    .array(z.object({ type: z.enum(['email', 'notification']), minutes: z.number() }))
    .optional(),
  customerId: z.string().optional(),
  contactId: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * Id of a WeldMeet meeting (created by the caller beforehand) to attach to
   * this event. Not a column: calendar-api links it (`meetings.calendar_event_id`)
   * if the caller is the meeting's organizer, then keeps the meeting in sync.
   */
  weldMeetingId: z.string().max(30).optional(),
});

/**
 * `recurrenceId` is deliberately NOT patchable (it links an occurrence to its
 * series and has no edit flow); Zod strips the key, so `data` cannot carry it.
 *
 * `calendarId` IS patchable (move an event to another calendar), but only
 * through the authorization in the PATCH handler: `calendar_events.calendarId`
 * has no FK, so a blindly written value would let a caller move an event into a
 * calendar they have no write access to, or into a non-existent one, which
 * every read path (filtered by `getAccessibleCalendarIds()`) would then hide
 * from everyone with no route to recover it. The handler requires write access
 * (owner, or an edit/manage share) to both the current and the target calendar.
 */
const updateSchema = createSchema
  .partial()
  .omit({ recurrenceId: true })
  .extend({
    // A client clearing a field sends null; accept it instead of answering 400.
    tags: z.array(z.string()).nullable().optional(),
    attendees: attendeesSchema.nullable().optional(),
    location: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    customerId: z.string().nullable().optional(),
    contactId: z.string().nullable().optional(),
    meetingUrl: meetingUrlSchema.nullable().optional(),
    timezone: timeZoneSchema.nullable().optional(),
  });

const rescheduleSchema = z.object({
  startTime: z.string().min(1),
  endTime: z.string().optional(),
  /**
   * True when the user explicitly dragged/chose this slot: pins the event and
   * writes the slot back to the linked task/activity. Programmatic
   * reschedules (cron, cascading bumps) pass false and must not pin.
   */
  manual: z.boolean().optional().default(false),
  /** False moves the event without mailing the attendees. */
  notifyAttendees: z.boolean().optional().default(true),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().optional(),
  search: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  /** Comma-separated; narrowed to the calendars the caller may read. */
  calendarIds: z.string().optional(),
});

const rangeQuerySchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  calendarIds: z.string().optional(),
});

const upcomingQuerySchema = z.object({
  days: z.coerce.number().min(1).max(365).default(7),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// ── Helpers ──────────────────────────────────────────────────────────────

const isoOrNull = (d: Date | null | undefined): string | null => d?.toISOString() ?? null;

/**
 * Why a start/end pair is not a valid time range, or null when it is. An event
 * must end after it starts; an all-day event may end the same day it starts
 * (the platform stores a one-day all-day event as start 00:00 .. end 23:59, and
 * older clients send the same instant twice), so for those `end >= start`.
 */
function timeRangeError(
  start: Date,
  end: Date | null | undefined,
  allDay: boolean | null | undefined,
): string | null {
  if (Number.isNaN(start.getTime())) return 'startTime is not a valid date';
  if (!end) return null;
  if (Number.isNaN(end.getTime())) return 'endTime is not a valid date';
  const ok = allDay ? end.getTime() >= start.getTime() : end.getTime() > start.getTime();
  return ok ? null : 'endTime must be after startTime';
}

/** Owner, or a share that lets the caller edit; `null` is a missing/deleted/invisible calendar. */
function canWrite(access: Awaited<ReturnType<typeof getCalendarAccess>>): boolean {
  return !!access && (access.isOwn || access.permission === 'edit' || access.permission === 'manage');
}

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** The mail-relevant fields of a stored event. */
function mailEventFromRow(row: CalendarEventRow): CalendarMailEvent {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    startTime: isoOrNull(row.startTime),
    endTime: isoOrNull(row.endTime),
    meetingUrl: row.meetingUrl,
    timezone: row.timezone,
    allDay: row.allDay,
  };
}

// Attendee mail is dispatched through `c.executionCtx.waitUntil(...)` rather
// than awaited inline as the legacy route did. Sends were already best-effort
// there (each wrapped in its own try/catch, failures never surfaced), so this
// changes nothing observable — it just stops a create with N attendees holding
// the response open for N sequential Resend round-trips.

/**
 * Queue attendee mail. Workspace members are looked up first: they get a link
 * into the authenticated calendar, external guests (no account) do not.
 */
function queueMail(c: EventContext, opts: SendOptions): void {
  if (!workerTransport(c.env) || opts.attendees.length === 0) return;
  const db = c.get('tenantDb');
  c.executionCtx.waitUntil(
    (async () => {
      const [memberEmails, workspaceLanguage] = await Promise.all([
        getMemberEmails(db, opts.attendees.map((a) => a.email ?? '')),
        getWorkspaceLanguage(db),
      ]);
      await sendCalendarEventEmails(c.env, { ...opts, memberEmails, workspaceLanguage });
    })(),
  );
}

// ── GET / — list events (cursor-paginated) ───────────────────────────────

app.get('/', requirePermission('events:read'), zValidator('query', listQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.valid('query');

  try {
    const calendarIds = await resolveRequestedCalendarIds(db, userId, q.calendarIds);
    if (calendarIds.length === 0) {
      return list(c, [], cursorPagination(0, false, null));
    }

    const conditions = [isNull(t.deletedAt), inArray(t.calendarId, calendarIds)];
    if (q.type) conditions.push(eq(t.type, q.type));
    if (q.status) conditions.push(eq(t.status, q.status));
    // Events OVERLAPPING the window, not just those starting inside it: a
    // multi-day event that began before `startDate` must still be listed.
    if (q.startDate) conditions.push(gte(sql`coalesce(${t.endTime}, ${t.startTime})`, new Date(q.startDate)));
    if (q.endDate) conditions.push(lte(t.startTime, new Date(q.endDate)));
    if (q.search) {
      const term = `%${q.search.replaceAll(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      conditions.push(
        or(ilike(t.title, term), ilike(t.description, term), ilike(t.location, term))!,
      );
    }

    const filterConditions = [...conditions];
    if (q.cursor) {
      const [cur] = await db
        .select({ createdAt: t.createdAt, id: t.id })
        .from(t)
        .where(eq(t.id, q.cursor))
        .limit(1);
      if (cur?.createdAt) {
        conditions.push(
          sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
        );
      }
    }

    const [rows, countRes] = await Promise.all([
      db
        .select()
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(q.limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);

    const hasMore = rows.length > q.limit;
    const data = hasMore ? rows.slice(0, q.limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/calendar-events] list failed:', err);
    return error.internal(c, 'Failed to list calendar events');
  }
});

// ── GET /range — events in a window (calendar grid; un-paginated) ────────
//
// Registered before `/:id` so the literal path wins.

app.get('/range', requirePermission('events:read'), zValidator('query', rangeQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.valid('query');

  try {
    const calendarIds = await resolveRequestedCalendarIds(db, userId, q.calendarIds);
    const rows = await listEventsInRange(db, {
      calendarIds,
      startDate: new Date(q.startDate),
      endDate: new Date(q.endDate),
    });
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/calendar-events] range failed:', err);
    return error.internal(c, 'Failed to fetch events');
  }
});

// ── GET /upcoming — next N days of confirmed events ──────────────────────

app.get('/upcoming', requirePermission('events:read'), zValidator('query', upcomingQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.valid('query');

  try {
    const calendarIds = await getAccessibleCalendarIds(db, userId);
    const rows = await listUpcomingEvents(db, { calendarIds, days: q.days, limit: q.limit });
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/calendar-events] upcoming failed:', err);
    return error.internal(c, 'Failed to fetch upcoming events');
  }
});

// ── GET /:id — single event ──────────────────────────────────────────────

app.get('/:id', requirePermission('events:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Calendar event', id);

    const calendarIds = await getAccessibleCalendarIds(db, userId);
    if (!calendarIds.includes(row.calendarId)) return error.notFound(c, 'Calendar event', id);

    return success(c, row);
  } catch (err) {
    console.error('[app-api/calendar-events] get failed:', err);
    return error.internal(c, 'Failed to fetch calendar event');
  }
});

// ── POST / — create event (always invites attendees) ─────────────────────

app.post('/', requirePermission('events:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { weldMeetingId, ...data } = c.req.valid('json');
  const id = generateId('evt');
  const now = new Date();

  try {
    // The caller must be able to reach the target calendar.
    const accessible = await getAccessibleCalendarIds(db, userId);
    if (!accessible.includes(data.calendarId)) return error.forbidden(c);

    const rangeError = timeRangeError(
      new Date(data.startTime),
      data.endTime ? new Date(data.endTime) : null,
      data.allDay,
    );
    if (rangeError) return error.badRequest(c, rangeError);

    await db.insert(t).values({
      id,
      calendarId: data.calendarId,
      title: data.title,
      description: data.description,
      type: data.type,
      startTime: new Date(data.startTime),
      endTime: data.endTime ? new Date(data.endTime) : null,
      allDay: data.allDay,
      timezone: data.timezone,
      location: data.location,
      isVirtual: data.isVirtual,
      meetingUrl: data.meetingUrl?.trim() || undefined,
      status: data.status || 'confirmed',
      priority: data.priority || 'normal',
      color: data.color,
      recurrenceRule: data.recurrenceRule,
      recurrenceId: data.recurrenceId,
      organizerId: userId,
      attendees: data.attendees,
      reminders: data.reminders,
      customerId: data.customerId,
      contactId: data.contactId,
      notes: data.notes,
      tags: data.tags,
      createdAt: now,
      updatedAt: now,
    });

    publishEntityEvent({
      c,
      entityType: 'calendar_event',
      entityId: id,
      action: 'created',
      data: {
        id,
        title: data.title,
        calendarId: data.calendarId,
        startAt: data.startTime,
        endAt: data.endTime ?? null,
      },
    });

    c.executionCtx.waitUntil(pushCalendarEventToGoogle(db, id, 'created', { id, ...data }, c.env));

    // The meeting was created by the caller with the same schedule and
    // attendees, so linking is all that is needed here (no sync pass).
    const weldMeetingLinked = weldMeetingId
      ? await linkMeeting(c, { meetingId: weldMeetingId, eventId: id, userId })
      : undefined;

    if (data.attendees?.length) {
      const organizer = await getOrganizerInfo(db, userId);
      queueMail(c, {
        kind: 'invite',
        organizer,
        attendees: data.attendees,
        event: {
          id,
          title: data.title,
          description: data.description,
          location: data.location,
          startTime: data.startTime,
          endTime: data.endTime,
          meetingUrl: data.meetingUrl,
          timezone: data.timezone,
          allDay: data.allDay,
        },
      });
    }

    return success(c, weldMeetingId ? { id, weldMeetingLinked } : { id }, 201);
  } catch (err) {
    console.error('[app-api/calendar-events] create failed:', err);
    return error.internal(c, 'Failed to create calendar event');
  }
});

type UpdateEventData = Omit<z.infer<typeof updateSchema>, 'weldMeetingId'>;
type CalendarEventRow = typeof t.$inferSelect;
type EventContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Column values for a PATCH: skips undefined keys and parses the time fields.
 * An empty `meetingUrl` clears the column (that is how the client removes
 * conferencing from an event).
 */
function buildUpdateFields(data: UpdateEventData): Record<string, unknown> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (k === 'startTime' || k === 'endTime') update[k] = new Date(v as string);
    else if (k === 'meetingUrl' && v === '') update[k] = null;
    else update[k] = v;
  }
  return update;
}

// ── WeldMeet meeting sync ────────────────────────────────────────────────
//
// Every helper here is best-effort: a failure is logged and never fails the
// event request. The event is the source of truth; a meeting that could not be
// linked is reported to the client (`weldMeetingLinked: false`), one that could
// not be synced is left as it was.

function publishMeetingChanges(c: EventContext, meetings: MeetingSyncResult[]): void {
  for (const m of meetings) {
    publishEntityEvent({
      c,
      entityType: 'meeting',
      entityId: m.id,
      action: 'updated',
      data: { id: m.id, title: m.title, status: m.status, startAt: m.startAt, hostId: m.hostId },
      changes: m.status !== m.oldStatus ? { status: { old: m.oldStatus, new: m.status } } : null,
    });
  }
}

/** Link a meeting to an event; resolves to whether it was linked. */
async function linkMeeting(
  c: EventContext,
  params: { meetingId: string; eventId: string; userId: string },
): Promise<boolean> {
  try {
    const linked = await linkMeetingToEvent(c.get('tenantDb'), params);
    if (!linked) {
      console.error(
        `[calendar-api/calendar-events] weldMeetingId ${params.meetingId} not linked to ${params.eventId}: meeting not found or not owned by caller`,
      );
      return false;
    }
    publishMeetingChanges(c, [linked]);
    return true;
  } catch (err) {
    console.error('[calendar-api/calendar-events] linking meeting failed:', err);
    return false;
  }
}

/** Re-read the event and push its state onto the meetings linked to it. */
async function syncLinkedMeetings(c: EventContext, before: CalendarEventRow): Promise<void> {
  try {
    const db = c.get('tenantDb');
    const [after] = await db.select().from(t).where(eq(t.id, before.id)).limit(1);
    if (!after) return;
    publishMeetingChanges(c, await syncMeetingsFromEvent(db, { before, after }));
  } catch (err) {
    console.error('[calendar-api/calendar-events] meeting sync failed:', err);
  }
}

/** Cancel the meetings linked to an event that was deleted or cancelled. */
async function cancelLinkedMeetings(c: EventContext, eventId: string): Promise<void> {
  try {
    publishMeetingChanges(c, await cancelMeetingsForEvent(c.get('tenantDb'), eventId));
  } catch (err) {
    console.error('[calendar-api/calendar-events] meeting cancel failed:', err);
  }
}

const emailKey = (a: AttendeeLike): string => (a.email ?? '').trim().toLowerCase();

/**
 * Mails the people an edit affects: newly-added attendees get an invitation,
 * removed ones a cancellation, and the rest an update when the time moved
 * (reschedule) or a join link was added or changed (update). Nobody is mailed
 * twice for one edit.
 *
 * An edit that cancels the event, or puts a cancelled one back on, is one
 * message to everyone instead: the cancellation, or "it is on again" with the
 * event as it now reads.
 */
async function notifyAttendeesOfUpdate(
  c: EventContext,
  existing: CalendarEventRow,
  data: UpdateEventData,
): Promise<void> {
  const db = c.get('tenantDb');
  const organizer = await getOrganizerInfo(db, existing.organizerId);

  // The event as it reads after the edit (a null clears the field).
  const pick = <K extends keyof UpdateEventData & keyof CalendarEventRow>(key: K) =>
    data[key] !== undefined ? data[key] : existing[key];
  const startTime = data.startTime ? new Date(data.startTime) : existing.startTime;
  const endTime = data.endTime ? new Date(data.endTime) : existing.endTime;
  const meetingUrl = (pick('meetingUrl') ?? '').trim() || null;
  const mailEvent: CalendarMailEvent = {
    id: existing.id,
    title: data.title ?? existing.title,
    description: pick('description'),
    location: pick('location'),
    startTime: isoOrNull(startTime),
    endTime: isoOrNull(endTime),
    meetingUrl,
    timezone: pick('timezone'),
    allDay: data.allDay ?? existing.allDay,
  };

  const oldAttendees: AttendeeLike[] = existing.attendees ?? [];
  const newAttendees: AttendeeLike[] =
    data.attendees === undefined ? oldAttendees : (data.attendees ?? []);
  const oldKeys = new Set(oldAttendees.map(emailKey).filter(Boolean));
  const newKeys = new Set(newAttendees.map(emailKey).filter(Boolean));
  const added = newAttendees.filter((a) => emailKey(a) && !oldKeys.has(emailKey(a)));
  const removed = oldAttendees.filter((a) => emailKey(a) && !newKeys.has(emailKey(a)));
  const retained = newAttendees.filter((a) => oldKeys.has(emailKey(a)));

  const wasCancelled = existing.status === 'cancelled';
  const isCancelled = (data.status ?? existing.status) === 'cancelled';

  // Cancelled by this edit: whoever was on the event hears it is off, the same
  // mail a delete sends. Guests added in the same edit were never invited.
  if (isCancelled && !wasCancelled) {
    queueMail(c, {
      kind: 'cancel',
      organizer,
      attendees: oldAttendees,
      event: mailEventFromRow(existing),
    });
    return;
  }

  // Back on: everyone on the event now is told, with its current time and join
  // link. The .ics is a REQUEST with a newer sequence than the cancellation,
  // which puts the event back in their calendar.
  if (wasCancelled && !isCancelled) {
    queueMail(c, {
      kind: 'restored',
      organizer,
      attendees: newAttendees,
      event: mailEvent,
      sequence: nextIcsSequence(),
    });
    return;
  }

  // Newly-added attendees get an invitation.
  queueMail(c, {
    kind: 'invite',
    organizer,
    attendees: added,
    event: mailEvent,
    sequence: nextIcsSequence(),
  });

  // Removed attendees are told they were taken off the event; it is not
  // cancelled, it carries on for everyone else.
  queueMail(c, {
    kind: 'removed',
    organizer,
    attendees: removed,
    event: mailEventFromRow(existing),
  });

  // Everyone who stays hears about a move, or about a join link that appeared
  // or changed. (Re-saving the same time is not a reschedule.)
  const moved = !sameInstant(startTime, existing.startTime) || !sameInstant(endTime, existing.endTime);
  const linkChanged = !!meetingUrl && meetingUrl !== (existing.meetingUrl?.trim() || null);
  if (moved || linkChanged) {
    queueMail(c, {
      kind: moved ? 'reschedule' : 'update',
      organizer,
      attendees: retained,
      event: mailEvent,
      oldStartTime: isoOrNull(existing.startTime),
      oldEndTime: isoOrNull(existing.endTime),
    });
  }
}

// ── PATCH /:id — update (mails attendees on ?sendNotification=true) ──────

app.patch('/:id', requirePermission('events:update'), zValidator('json', updateSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const { weldMeetingId, ...data } = c.req.valid('json');
  const sendNotification = c.req.query('sendNotification') === 'true';

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Calendar event', id);

    const accessible = await getAccessibleCalendarIds(db, userId);
    if (!accessible.includes(existing.calendarId)) return error.notFound(c, 'Calendar event', id);

    // Moving to another calendar needs write access to where the event is now
    // AND where it is going; a missing or deleted target answers 403 like one
    // the caller may not write to, so ids cannot be probed.
    const movedTo =
      data.calendarId !== undefined && data.calendarId !== existing.calendarId
        ? data.calendarId
        : undefined;
    if (movedTo !== undefined) {
      const [source, target] = await Promise.all([
        getCalendarAccess(db, existing.calendarId, userId),
        getCalendarAccess(db, movedTo, userId),
      ]);
      if (!canWrite(source) || !canWrite(target)) return error.forbidden(c);
    }

    // Compare against the stored value of whichever bound the body leaves out.
    if (data.startTime !== undefined || data.endTime !== undefined) {
      const rangeError = timeRangeError(
        data.startTime !== undefined ? new Date(data.startTime) : existing.startTime,
        data.endTime !== undefined ? new Date(data.endTime) : existing.endTime,
        data.allDay ?? existing.allDay,
      );
      if (rangeError) return error.badRequest(c, rangeError);
    }

    const update = buildUpdateFields(data);

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'calendar_event',
      entityId: id,
      action: 'updated',
      data: {
        id,
        title: data.title ?? existing.title,
        calendarId: movedTo ?? existing.calendarId,
        startAt: data.startTime ?? isoOrNull(existing.startTime),
        endAt: data.endTime ?? isoOrNull(existing.endTime),
      },
      changes: movedTo ? { calendarId: { old: existing.calendarId, new: movedTo } } : null,
    });

    c.executionCtx.waitUntil(pushCalendarEventToGoogle(db, id, 'updated', { id, ...data }, c.env));

    if (sendNotification) await notifyAttendeesOfUpdate(c, existing, data);

    // Link first so a meeting attached by this very request is synced too.
    const weldMeetingLinked = weldMeetingId
      ? await linkMeeting(c, { meetingId: weldMeetingId, eventId: id, userId })
      : undefined;
    await syncLinkedMeetings(c, existing);

    return success(c, weldMeetingId ? { id, ...data, weldMeetingLinked } : { id, ...data });
  } catch (err) {
    console.error('[app-api/calendar-events] update failed:', err);
    return error.internal(c, 'Failed to update calendar event');
  }
});

// ── DELETE /:id — soft delete (cancels attendees on ?sendNotification=true) ─

app.delete('/:id', requirePermission('events:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const sendNotification = c.req.query('sendNotification') === 'true';

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Calendar event', id);

    const accessible = await getAccessibleCalendarIds(db, userId);
    if (!accessible.includes(existing.calendarId)) return error.notFound(c, 'Calendar event', id);

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'calendar_event',
      entityId: id,
      action: 'deleted',
      data: { id, title: existing.title, calendarId: existing.calendarId },
    });

    c.executionCtx.waitUntil(pushCalendarEventToGoogle(db, id, 'deleted', { id }, c.env));

    await cancelLinkedMeetings(c, id);

    if (sendNotification && existing.attendees?.length) {
      const organizer = await getOrganizerInfo(db, existing.organizerId);
      queueMail(c, {
        kind: 'cancel',
        organizer,
        attendees: existing.attendees,
        event: mailEventFromRow(existing),
      });
    }

    return noContent(c);
  } catch (err) {
    console.error('[app-api/calendar-events] delete failed:', err);
    return error.internal(c, 'Failed to delete calendar event');
  }
});

// ── PATCH /:id/cancel — mark cancelled (always mails attendees) ──────────

app.patch('/:id/cancel', requirePermission('events:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Calendar event', id);

    const accessible = await getAccessibleCalendarIds(db, userId);
    if (!accessible.includes(existing.calendarId)) return error.notFound(c, 'Calendar event', id);

    await db
      .update(t)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)));

    // Legacy emits `updated` with a status change rather than the catalog's
    // `cancelled` action; kept so existing workflow/agent subscriptions match.
    publishEntityEvent({
      c,
      entityType: 'calendar_event',
      entityId: id,
      action: 'updated',
      data: { id, title: existing.title, calendarId: existing.calendarId },
      changes: { status: { old: existing.status, new: 'cancelled' } },
    });

    // Legacy pushes the cancel as an `updated` carrying only the new status —
    // Google keeps the event and flips it to `cancelled` rather than removing it.
    c.executionCtx.waitUntil(
      pushCalendarEventToGoogle(db, id, 'updated', { id, status: 'cancelled' }, c.env),
    );

    await cancelLinkedMeetings(c, id);

    if (existing.attendees?.length) {
      const organizer = await getOrganizerInfo(db, existing.organizerId);
      queueMail(c, {
        kind: 'cancel',
        organizer,
        attendees: existing.attendees,
        event: mailEventFromRow(existing),
      });
    }

    return success(c, { id, status: 'cancelled' });
  } catch (err) {
    console.error('[app-api/calendar-events] cancel failed:', err);
    return error.internal(c, 'Failed to cancel calendar event');
  }
});

// ── PATCH /:id/reschedule — move the event (pins the source when manual) ─

app.patch('/:id/reschedule', requirePermission('events:update'), zValidator('json', rescheduleSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Calendar event', id);

    const accessible = await getAccessibleCalendarIds(db, userId);
    if (!accessible.includes(existing.calendarId)) return error.notFound(c, 'Calendar event', id);

    const newStart = new Date(data.startTime);
    const newEnd = data.endTime ? new Date(data.endTime) : null;

    const rangeError = timeRangeError(newStart, newEnd ?? existing.endTime, existing.allDay);
    if (rangeError) return error.badRequest(c, rangeError);

    const update: Record<string, unknown> = { startTime: newStart, updatedAt: new Date() };
    if (newEnd) update.endTime = newEnd;

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    // Only a user-driven move pins the slot back onto the source entity.
    if (data.manual) {
      await pinRescheduledSource(db, { event: existing, startTime: newStart, endTime: newEnd });
    }

    publishEntityEvent({
      c,
      entityType: 'calendar_event',
      entityId: id,
      action: 'updated',
      data: {
        id,
        title: existing.title,
        calendarId: existing.calendarId,
        startAt: data.startTime,
        endAt: data.endTime ?? isoOrNull(existing.endTime),
      },
    });

    c.executionCtx.waitUntil(pushCalendarEventToGoogle(db, id, 'updated', { id, ...data }, c.env));

    await syncLinkedMeetings(c, existing);

    if (data.notifyAttendees && existing.attendees?.length) {
      const organizer = await getOrganizerInfo(db, existing.organizerId);
      queueMail(c, {
        kind: 'reschedule',
        organizer,
        attendees: existing.attendees,
        event: {
          ...mailEventFromRow(existing),
          startTime: data.startTime,
          endTime: data.endTime ?? isoOrNull(existing.endTime),
        },
        oldStartTime: isoOrNull(existing.startTime),
        oldEndTime: isoOrNull(existing.endTime),
      });
    }

    return success(c, { id, ...data });
  } catch (err) {
    console.error('[app-api/calendar-events] reschedule failed:', err);
    return error.internal(c, 'Failed to reschedule calendar event');
  }
});

// ── POST /:id/unpin — hand the event back to the auto-scheduler ──────────

app.post('/:id/unpin', requirePermission('events:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Calendar event', id);

    const accessible = await getAccessibleCalendarIds(db, userId);
    if (!accessible.includes(existing.calendarId)) return error.notFound(c, 'Calendar event', id);

    await unpinEvent(db, existing);

    return success(c, { id, autoScheduled: true });
  } catch (err) {
    console.error('[app-api/calendar-events] unpin failed:', err);
    return error.internal(c, 'Failed to unpin calendar event');
  }
});

export const calendarEventsRoutes = app;
