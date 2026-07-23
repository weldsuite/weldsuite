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
 *     and reschedule, exactly as the legacy route did;
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
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  getAccessibleCalendarIds,
  resolveRequestedCalendarIds,
} from '../../services/calendar-access';
import {
  listEventsInRange,
  listUpcomingEvents,
  pinRescheduledSource,
  unpinEvent,
} from '../../services/calendar-events';
import {
  getOrganizerInfo,
  sendCalendarEventEmails,
  type AttendeeLike,
} from '../../services/calendar-mail';
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

const attendeeSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  status: z.string().optional(),
  role: z.string().optional(),
});

const createSchema = z.object({
  calendarId: z.string().min(1),
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.enum(['meeting', 'call', 'appointment', 'event', 'reminder', 'other']).default('meeting'),
  startTime: z.string().min(1),
  endTime: z.string().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  location: z.string().optional(),
  isVirtual: z.boolean().optional(),
  meetingUrl: z.string().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  color: z.string().optional(),
  recurrenceRule: z.string().optional(),
  recurrenceId: z.string().optional(),
  attendees: z.array(attendeeSchema).optional(),
  reminders: z
    .array(z.object({ type: z.enum(['email', 'notification']), minutes: z.number() }))
    .optional(),
  customerId: z.string().optional(),
  contactId: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * `calendarId` and `recurrenceId` are deliberately NOT patchable — the legacy
 * route's explicit field whitelist (api-worker calendar/events.ts) assigns 20
 * named fields and neither of these is among them, so a patched `calendarId`
 * was silently ignored there.
 *
 * Keeping them out matters beyond fidelity: PATCH validates access against the
 * event's EXISTING calendar, and `calendar_events.calendarId` has no FK (the
 * reference is a comment only). A writable `calendarId` would therefore let a
 * caller move an event into a calendar they were never checked against, or into
 * a non-existent one — and since every read path filters by
 * `getAccessibleCalendarIds()`, a bogus value would make the event invisible to
 * everyone, with no API route to recover it.
 *
 * Omitting (rather than filtering in the update loop below) makes this a
 * compile-time guarantee: Zod strips the keys, so `data` cannot carry them.
 * The WeldCalendar event dialog does send `calendarId` on edit — seeded from the
 * event's own calendar, so it is a no-op. Moving an event between calendars is
 * not a supported operation; it would need the same accessibility check POST
 * does, plus a product decision.
 */
const updateSchema = createSchema.partial().omit({ calendarId: true, recurrenceId: true });

const rescheduleSchema = z.object({
  startTime: z.string().min(1),
  endTime: z.string().optional(),
  /**
   * True when the user explicitly dragged/chose this slot: pins the event and
   * writes the slot back to the linked task/activity. Programmatic
   * reschedules (cron, cascading bumps) pass false and must not pin.
   */
  manual: z.boolean().optional().default(false),
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

// Attendee mail is dispatched through `c.executionCtx.waitUntil(...)` rather
// than awaited inline as the legacy route did. Sends were already best-effort
// there (each wrapped in its own try/catch, failures never surfaced), so this
// changes nothing observable — it just stops a create with N attendees holding
// the response open for N sequential Resend round-trips.

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
    if (q.startDate) conditions.push(gte(t.startTime, new Date(q.startDate)));
    if (q.endDate) conditions.push(lte(t.startTime, new Date(q.endDate)));
    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(or(like(t.title, term), like(t.description, term))!);
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
  const data = c.req.valid('json');
  const id = generateId('evt');
  const now = new Date();

  try {
    // The caller must be able to reach the target calendar.
    const accessible = await getAccessibleCalendarIds(db, userId);
    if (!accessible.includes(data.calendarId)) return error.forbidden(c);

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
      meetingUrl: data.meetingUrl,
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

    if (data.attendees?.length) {
      const organizer = await getOrganizerInfo(db, userId);
      c.executionCtx.waitUntil(
        sendCalendarEventEmails(c.env, {
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
          },
        }),
      );
    }

    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/calendar-events] create failed:', err);
    return error.internal(c, 'Failed to create calendar event');
  }
});

// ── PATCH /:id — update (mails attendees on ?sendNotification=true) ──────

app.patch('/:id', requirePermission('events:update'), zValidator('json', updateSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
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

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (k === 'startTime' || k === 'endTime') update[k] = new Date(v as string);
      else update[k] = v;
    }

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'calendar_event',
      entityId: id,
      action: 'updated',
      data: {
        id,
        title: data.title ?? existing.title,
        calendarId: existing.calendarId,
        startAt: data.startTime ?? isoOrNull(existing.startTime),
        endAt: data.endTime ?? isoOrNull(existing.endTime),
      },
    });

    c.executionCtx.waitUntil(pushCalendarEventToGoogle(db, id, 'updated', { id, ...data }, c.env));

    if (sendNotification) {
      const organizer = await getOrganizerInfo(db, existing.organizerId);
      const title = data.title ?? existing.title;
      const startTime = data.startTime ?? isoOrNull(existing.startTime);
      const endTime = data.endTime ?? isoOrNull(existing.endTime);
      const mailEvent = {
        id,
        title,
        description: data.description ?? existing.description,
        location: data.location ?? existing.location,
        startTime,
        endTime,
      };

      // Newly-added attendees get an invitation.
      if (data.attendees !== undefined) {
        const oldEmails = new Set(
          (existing.attendees ?? []).map((a) => a.email?.toLowerCase()).filter(Boolean),
        );
        const added = data.attendees.filter((a) => !oldEmails.has(a.email.toLowerCase()));
        if (added.length) {
          c.executionCtx.waitUntil(
            sendCalendarEventEmails(c.env, {
              kind: 'invite',
              organizer,
              attendees: added,
              event: mailEvent,
              sequence: 1,
            }),
          );
        }
      }

      // A time change re-notifies the attendee list.
      if (data.startTime !== undefined || data.endTime !== undefined) {
        const attendees: AttendeeLike[] = data.attendees ?? existing.attendees ?? [];
        if (attendees.length) {
          c.executionCtx.waitUntil(
            sendCalendarEventEmails(c.env, {
              kind: 'reschedule',
              organizer,
              attendees,
              event: mailEvent,
              sequence: 2,
              oldStartTime: isoOrNull(existing.startTime),
              oldEndTime: isoOrNull(existing.endTime),
            }),
          );
        }
      }
    }

    return success(c, { id, ...data });
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

    if (sendNotification && existing.attendees?.length) {
      const organizer = await getOrganizerInfo(db, existing.organizerId);
      c.executionCtx.waitUntil(
        sendCalendarEventEmails(c.env, {
          kind: 'cancel',
          organizer,
          attendees: existing.attendees,
          sequence: 3,
          event: {
            id,
            title: existing.title,
            description: existing.description,
            location: existing.location,
            startTime: isoOrNull(existing.startTime),
            endTime: isoOrNull(existing.endTime),
          },
        }),
      );
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

    if (existing.attendees?.length) {
      const organizer = await getOrganizerInfo(db, existing.organizerId);
      c.executionCtx.waitUntil(
        sendCalendarEventEmails(c.env, {
          kind: 'cancel',
          organizer,
          attendees: existing.attendees,
          sequence: 3,
          event: {
            id,
            title: existing.title,
            description: existing.description,
            location: existing.location,
            startTime: isoOrNull(existing.startTime),
            endTime: isoOrNull(existing.endTime),
          },
        }),
      );
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

    if (existing.attendees?.length) {
      const organizer = await getOrganizerInfo(db, existing.organizerId);
      c.executionCtx.waitUntil(
        sendCalendarEventEmails(c.env, {
          kind: 'reschedule',
          organizer,
          attendees: existing.attendees,
          sequence: 2,
          event: {
            id,
            title: existing.title,
            description: existing.description,
            location: existing.location,
            startTime: data.startTime,
            endTime: data.endTime ?? isoOrNull(existing.endTime),
          },
          oldStartTime: isoOrNull(existing.startTime),
          oldEndTime: isoOrNull(existing.endTime),
        }),
      );
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
