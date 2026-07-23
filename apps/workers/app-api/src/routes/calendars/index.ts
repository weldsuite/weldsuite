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
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  ensureDefaultCalendar,
  getCalendarAccess,
  listCalendarShares,
  listCalendarsForUser,
  removeCalendarShare,
  upsertCalendarShare,
} from '../../services/calendar-access';

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
  sharedWithId: z.string().min(1),
  permission: z.enum(['view', 'edit', 'manage']).default('view'),
});

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

// ── DELETE /:id — soft delete (owner only, never the default) ────────────

app.delete('/:id', requirePermission('calendars:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Calendar', id);
    if (existing.ownerId !== userId) return error.forbidden(c);
    if (existing.isDefault) return error.badRequest(c, 'Cannot delete default calendar');

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(t.id, id));

    publishEntityEvent({
      c,
      entityType: 'calendar',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
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
