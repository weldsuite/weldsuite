/**
 * Calendar routes — flat /api/calendars/* surface backed by `calendars`.
 *
 * Successor to api-worker's `/api/calendar/calendars/*` (W5b of the
 * legacy-worker phase-out). The behaviour ported over the previous CRUD
 * shell is the share model: the list joins `calendarShares` so it returns
 * calendars shared *with* the caller alongside their own, each annotated
 * with `isOwn` + `permission` — the two fields the sidebar, the event dialog
 * and the calendar view gate on. `/ensure-default`, `/:id/shares`,
 * `/:id/share` and `/:id/share/:shareId` come across with it.
 * `/:id/delete-impact` and the event cascade on `DELETE /:id` are TASK-745.
 *
 * Access model (from the legacy route, unchanged):
 *   - list/read: calendars you own ∪ calendars shared with you
 *   - update/delete/share: owner only (share additionally allows a sharee
 *     holding `manage`)
 *
 * NOTE ON `calendars:scope:all`: the previous shell consulted it to widen
 * from own-only to every row. The legacy route has no such concept — access
 * is share-derived — and the sidebar renders whatever the list returns, so
 * honouring it here would show admins every member's personal calendar.
 * These routes therefore follow the legacy access model for all callers.
 *
 * Permissions mirror the legacy route exactly:
 *   calendars:read | calendars:create | calendars:update | calendars:delete
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  ensureDefaultCalendar,
  getCalendarAccess,
  isActiveWorkspaceMember,
  listCalendarShares,
  listCalendarsForUser,
  removeCalendarShare,
  upsertCalendarShare,
} from '../../services/calendar-access';
import {
  eventIdsWithScheduledMeetings,
  getCalendarDeleteImpact,
  listCalendarEventsForDeletion,
  needsCancellationMail,
  softDeleteCalendar,
} from '../../services/calendar-deletion';
import {
  getMemberEmails,
  getOrganizerInfo,
  getWorkspaceLanguage,
  sendCalendarEventEmails,
} from '../../services/calendar-mail';
import { cancelMeetingsForEvent } from '../../services/calendar-meeting-sync';
import { pushCalendarEventToGoogle } from '../../lib/integrations/sync/outbound-calendar-sync';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.calendars;

// ── Validation ───────────────────────────────────────────────────────────
//
// Defined locally rather than pulled from
// `@weldsuite/core-api-client/schemas/calendars`: that schema is `.passthrough()`
// with `color: max(50)` and an optional `ownerId`, which (a) overflows the
// `color varchar(20)` column and (b) lets a caller create a calendar owned by
// someone else. These bounds match the legacy route and the DB columns.

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  color: z.string().max(20).optional(),
});

const updateSchema = createSchema.partial();

const shareSchema = z.object({
  sharedWithId: z.string().trim().min(1).max(255),
  permission: z.enum(['view', 'edit', 'manage']).default('view'),
});

/** 422 for a well-formed request the share model cannot accept. */
const unprocessable = (c: Context, message: string) =>
  c.json({ error: { code: 'UNPROCESSABLE_ENTITY', message } }, 422);

// ── GET / — calendars visible to the caller (own + shared with them) ─────

app.get('/', requirePermission('calendars:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const rows = await listCalendarsForUser(db, userId);
    // Un-paginated by design: the sidebar needs the full set. The pagination
    // block is present to keep the list envelope uniform.
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/calendars] list failed:', err);
    return error.internal(c, 'Failed to list calendars');
  }
});

// ── POST /ensure-default — create the caller's default calendar if absent ─
//
// Registered before `/:id` handlers for clarity; 200 when one already
// existed, 201 when it was created (legacy contract).

app.post('/ensure-default', requirePermission('calendars:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const { calendar, created } = await ensureDefaultCalendar(db, userId);
    if (created) {
      publishEntityEvent({
        c,
        entityType: 'calendar',
        entityId: calendar.id,
        action: 'created',
        data: { id: calendar.id, name: calendar.name, ownerId: calendar.ownerId },
      });
    }
    return success(c, calendar, created ? 201 : 200);
  } catch (err) {
    console.error('[app-api/calendars] ensure-default failed:', err);
    return error.internal(c, 'Failed to ensure default calendar');
  }
});

// ── POST / — create a calendar ───────────────────────────────────────────

app.post('/', requirePermission('calendars:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const id = generateId('cal');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      name: data.name,
      description: data.description,
      color: data.color,
      ownerId: userId,
      isDefault: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({
      c,
      entityType: 'calendar',
      entityId: id,
      action: 'created',
      data: { id, name: data.name, ownerId: userId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/calendars] create failed:', err);
    return error.internal(c, 'Failed to create calendar');
  }
});

// ── GET /:id — single calendar (owner or sharee) ─────────────────────────

app.get('/:id', requirePermission('calendars:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Calendar', id);

    const access = await getCalendarAccess(db, id, userId);
    if (!access) return error.forbidden(c);

    return success(c, row);
  } catch (err) {
    console.error('[app-api/calendars] get failed:', err);
    return error.internal(c, 'Failed to fetch calendar');
  }
});

// ── PATCH /:id — update calendar (owner only) ────────────────────────────

app.patch('/:id', requirePermission('calendars:update'), zValidator('json', updateSchema), async (c) => {
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
    if (!existing) return error.notFound(c, 'Calendar', id);
    if (existing.ownerId !== userId) return error.forbidden(c);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.color !== undefined) update.color = data.color;

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'calendar',
      entityId: id,
      action: 'updated',
      data: { id, name: data.name ?? existing.name, ownerId: existing.ownerId },
    });
    return success(c, { id, ...data });
  } catch (err) {
    console.error('[app-api/calendars] update failed:', err);
    return error.internal(c, 'Failed to update calendar');
  }
});

// ── Calendar delete (TASK-745) ───────────────────────────────────────────
//
// Deleting a calendar deletes its events with it, and applies to every one of
// them what a single event delete does: the linked WeldMeet meeting is
// cancelled, Google gets the delete, and — on `?sendNotification=true`, the
// same flag and meaning as `DELETE /api/calendar-events/:id` — attendees of
// upcoming events are mailed a cancellation. `GET /:id/delete-impact` feeds
// the confirmation dialog ("this deletes N events").

type CalendarContext = Context<{ Bindings: Env; Variables: Variables }>;
type CalendarEventRow = Awaited<ReturnType<typeof listCalendarEventsForDeletion>>[number];

const isoOrNull = (d: Date | null | undefined): string | null => d?.toISOString() ?? null;

/**
 * The calendar the caller may delete, or the error response to return: 404
 * when missing, 403 when not theirs (sharees, even `manage`, cannot delete),
 * 400 for the default calendar.
 */
async function loadDeletableCalendar(
  c: CalendarContext,
  id: string,
): Promise<{ calendar: typeof t.$inferSelect } | { response: Response }> {
  const db = c.get('tenantDb');
  const [calendar] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, id), isNull(t.deletedAt)))
    .limit(1);
  if (!calendar) return { response: error.notFound(c, 'Calendar', id) };
  if (calendar.ownerId !== c.get('userId')) return { response: error.forbidden(c) };
  if (calendar.isDefault) {
    return { response: error.badRequest(c, 'Cannot delete default calendar') };
  }
  return { calendar };
}

/** Cancel the WeldMeet meetings linked to the deleted events (best-effort). */
async function cancelLinkedMeetings(c: CalendarContext, eventIds: string[]): Promise<void> {
  const db = c.get('tenantDb');
  try {
    const withMeetings = await eventIdsWithScheduledMeetings(db, eventIds);
    for (const eventId of withMeetings) {
      for (const m of await cancelMeetingsForEvent(db, eventId)) {
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
  } catch (err) {
    console.error('[calendar-api/calendars] meeting cancel failed:', err);
  }
}

/** Mail a cancellation to the attendees of each event, one organizer lookup per organizer. */
async function sendCancellationMails(c: CalendarContext, events: CalendarEventRow[]): Promise<void> {
  const db = c.get('tenantDb');
  const organizers = new Map<string, Awaited<ReturnType<typeof getOrganizerInfo>>>();
  const workspaceLanguage = await getWorkspaceLanguage(db);
  for (const event of events) {
    try {
      let organizer = organizers.get(event.organizerId);
      if (!organizer) {
        organizer = await getOrganizerInfo(db, event.organizerId);
        organizers.set(event.organizerId, organizer);
      }
      const memberEmails = await getMemberEmails(
        db,
        (event.attendees ?? []).map((a) => a.email ?? ''),
      );
      await sendCalendarEventEmails(c.env, {
        kind: 'cancel',
        organizer,
        attendees: event.attendees ?? [],
        sequence: 3,
        memberEmails,
        workspaceLanguage,
        event: {
          id: event.id,
          title: event.title,
          description: event.description,
          location: event.location,
          startTime: isoOrNull(event.startTime),
          endTime: isoOrNull(event.endTime),
          // The event's own zone and all-day flag, like the single-event cancel
          // and the invitation: without them the mail falls back to UTC.
          timezone: event.timezone,
          allDay: event.allDay,
        },
      });
    } catch (err) {
      console.error(`[calendar-api/calendars] cancellation mail failed for event ${event.id}:`, err);
    }
  }
}

/** Push each deleted event to the connected Google calendars, one at a time. */
async function pushDeletesToGoogle(c: CalendarContext, eventIds: string[]): Promise<void> {
  const db = c.get('tenantDb');
  for (const id of eventIds) {
    await pushCalendarEventToGoogle(db, id, 'deleted', { id }, c.env);
  }
}

// ── GET /:id/delete-impact — what a delete would remove (owner only) ─────

app.get('/:id/delete-impact', requirePermission('calendars:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const loaded = await loadDeletableCalendar(c, id);
    if ('response' in loaded) return loaded.response;
    return success(c, await getCalendarDeleteImpact(c.get('tenantDb'), id));
  } catch (err) {
    console.error('[calendar-api/calendars] delete impact failed:', err);
    return error.internal(c, 'Failed to load calendar delete impact');
  }
});

// ── DELETE /:id — soft delete with its events (owner only, never the default)

app.delete('/:id', requirePermission('calendars:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const sendNotification = c.req.query('sendNotification') === 'true';
  try {
    const loaded = await loadDeletableCalendar(c, id);
    if ('response' in loaded) return loaded.response;
    const { calendar } = loaded;

    // Read before the soft delete: the mails and meeting cancels need the rows.
    const events = await listCalendarEventsForDeletion(db, id);
    await softDeleteCalendar(db, id);

    publishEntityEvent({
      c,
      entityType: 'calendar',
      entityId: id,
      action: 'deleted',
      data: { id, name: calendar.name, ownerId: calendar.ownerId },
    });
    for (const event of events) {
      publishEntityEvent({
        c,
        entityType: 'calendar_event',
        entityId: event.id,
        action: 'deleted',
        data: { id: event.id, title: event.title, calendarId: id },
      });
    }

    const eventIds = events.map((e) => e.id);
    if (eventIds.length) c.executionCtx.waitUntil(pushDeletesToGoogle(c, eventIds));

    await cancelLinkedMeetings(c, eventIds);

    if (sendNotification) {
      const now = new Date();
      const toNotify = events.filter((e) => needsCancellationMail(e, now));
      if (toNotify.length) c.executionCtx.waitUntil(sendCancellationMails(c, toNotify));
    }

    return noContent(c);
  } catch (err) {
    console.error('[app-api/calendars] delete failed:', err);
    return error.internal(c, 'Failed to delete calendar');
  }
});

// ── GET /:id/shares — list shares (owner only) ───────────────────────────

app.get('/:id/shares', requirePermission('calendars:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const calendarId = c.req.param('id');
  try {
    const [calendar] = await db
      .select({ ownerId: t.ownerId })
      .from(t)
      .where(and(eq(t.id, calendarId), isNull(t.deletedAt)))
      .limit(1);
    if (!calendar) return error.notFound(c, 'Calendar', calendarId);
    if (calendar.ownerId !== userId) return error.forbidden(c);

    const shares = await listCalendarShares(db, calendarId);
    return list(c, shares, cursorPagination(shares.length, false, null));
  } catch (err) {
    console.error('[app-api/calendars] list shares failed:', err);
    return error.internal(c, 'Failed to list shares');
  }
});

// ── POST /:id/share — share with a member (owner, or a `manage` sharee) ──

app.post('/:id/share', requirePermission('calendars:update'), zValidator('json', shareSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const calendarId = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const access = await getCalendarAccess(db, calendarId, userId);
    if (!access) {
      // Distinguish "no such calendar" from "not yours" the way legacy did.
      const [exists] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.id, calendarId), isNull(t.deletedAt)))
        .limit(1);
      return exists ? error.forbidden(c) : error.notFound(c, 'Calendar', calendarId);
    }
    if (!access.isOwn && access.permission !== 'manage') return error.forbidden(c);

    // The target must be a real member: the share is keyed on their user id,
    // so an email or a typo would otherwise be stored as a share nobody can
    // use (TASK-749). Sharing with yourself or the owner grants nothing.
    if (data.sharedWithId === userId || data.sharedWithId === access.calendar.ownerId) {
      return unprocessable(c, 'A calendar cannot be shared with yourself or its owner');
    }
    if (!(await isActiveWorkspaceMember(db, data.sharedWithId))) {
      return unprocessable(c, 'Calendars can only be shared with members of this workspace');
    }

    const result = await upsertCalendarShare(db, {
      calendarId,
      sharedWithId: data.sharedWithId,
      permission: data.permission,
      sharedById: userId,
    });

    if (result.created) {
      publishEntityEvent({
        c,
        entityType: 'calendar_share',
        entityId: result.id,
        action: 'created',
        data: { id: result.id, calendarId, ...data },
      });
      return success(c, { id: result.id }, 201);
    }

    publishEntityEvent({
      c,
      entityType: 'calendar_share',
      entityId: result.id,
      action: 'updated',
      data: { id: result.id, calendarId, ...data },
    });
    return success(c, { id: result.id, permission: result.permission });
  } catch (err) {
    console.error('[app-api/calendars] share failed:', err);
    return error.internal(c, 'Failed to share calendar');
  }
});

// ── DELETE /:id/share/:shareId — remove a share (owner only) ─────────────

app.delete('/:id/share/:shareId', requirePermission('calendars:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const calendarId = c.req.param('id');
  const shareId = c.req.param('shareId');
  try {
    const [calendar] = await db
      .select({ ownerId: t.ownerId })
      .from(t)
      .where(and(eq(t.id, calendarId), isNull(t.deletedAt)))
      .limit(1);
    if (!calendar) return error.notFound(c, 'Calendar', calendarId);
    if (calendar.ownerId !== userId) return error.forbidden(c);

    await removeCalendarShare(db, calendarId, shareId);

    publishEntityEvent({
      c,
      entityType: 'calendar_share',
      entityId: shareId,
      action: 'deleted',
      data: { id: shareId, calendarId },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/calendars] remove share failed:', err);
    return error.internal(c, 'Failed to remove share');
  }
});

export const calendarsRoutes = app;
