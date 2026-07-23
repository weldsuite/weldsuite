/**
 * Booking page routes — flat /api/booking-pages/* surface backed by `calendarBookingPages`.
 *
 * Permissions: bookings:read | bookings:create | bookings:update | bookings:delete.
 *   bookings:scope:all elevates from own-only default to cross-owner access.
 *
 * `/:id/available-slots` and `/:id/toggle` are ports of the legacy api-worker
 * handlers (`apps/api-worker/src/routes/calendar/booking-pages.ts`, W5b of the
 * legacy-worker phase-out). Slot availability is computed server-side from the
 * page's weekly availability minus the owner's confirmed events and buffers —
 * see services/calendar-slots.ts.
 */

import { Hono } from 'hono';
import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import {
  ensurePermissionsResolved,
  requirePermission,
} from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createBookingPageSchema, updateBookingPageSchema } from '@weldsuite/core-api-client/schemas/booking-pages';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  computeAvailableSlots,
  type WeeklyAvailability,
} from '../../services/calendar-slots';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.calendarBookingPages;

async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  const perms = resolved?.permissions ?? [];
  if (hasPermission(perms, 'bookings:scope:all')) return undefined;
  return c.get('userId');
}

app.get('/', requirePermission('bookings:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const scope = await scopeFor(c);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  if (q.ownerId !== undefined && q.ownerId !== '') conditions.push(eq(t.ownerId, q.ownerId));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.slug, term))!);
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/booking-pages] list failed:', err);
    return error.internal(c, 'Failed to list booking pages');
  }
});

app.get('/:id', requirePermission('bookings:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [row] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!row) return error.notFound(c, 'Booking page', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/booking-pages] get failed:', err);
    return error.internal(c, 'Failed to fetch booking page');
  }
});

app.post('/', requirePermission('bookings:create'), zValidator('json', createBookingPageSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const userId = c.get('userId');
  const id = generateId('bpg');
  const now = new Date();
  // `ownerId` is NOT NULL at the DB; default to the caller when the
  // body doesn't pass one.
  const ownerId =
    typeof data.ownerId === 'string' && data.ownerId.length > 0
      ? data.ownerId
      : userId;
  try {
    await db.insert(t).values({ id, ...data, ownerId, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'calendar_booking_page',
      entityId: id,
      action: 'created',
      data: {
        id,
        name: data.name as string,
        slug: data.slug as string,
        ownerId,
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/booking-pages] create failed:', err);
    return error.internal(c, 'Failed to create booking page');
  }
});

app.patch('/:id', requirePermission('bookings:update'), zValidator('json', updateBookingPageSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Booking page', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'calendar_booking_page',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name,
        slug: (update.slug as string | undefined) ?? existing.slug,
        ownerId: (update.ownerId as string | undefined) ?? existing.ownerId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/booking-pages] update failed:', err);
    return error.internal(c, 'Failed to update booking page');
  }
});

app.delete('/:id', requirePermission('bookings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Booking page', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'calendar_booking_page',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/booking-pages] delete failed:', err);
    return error.internal(c, 'Failed to delete booking page');
  }
});

// ── PATCH /:id/toggle — flip published state ─────────────────────────────

app.patch('/:id/toggle', requirePermission('bookings:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));
  try {
    const [record] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!record) return error.notFound(c, 'Booking page', id);

    const isActive = !record.isActive;
    await db.update(t).set({ isActive, updatedAt: new Date() }).where(eq(t.id, id));

    publishEntityEvent({
      c,
      entityType: 'calendar_booking_page',
      entityId: id,
      action: 'updated',
      data: { id, name: record.name, slug: record.slug, ownerId: record.ownerId },
      changes: { isActive: { old: record.isActive, new: isActive } },
    });
    return success(c, { id, isActive });
  } catch (err) {
    console.error('[app-api/booking-pages] toggle failed:', err);
    return error.internal(c, 'Failed to toggle booking page');
  }
});

// ── GET /:id/available-slots — bookable slots for one date ───────────────

const slotsQuerySchema = z.object({
  /** ISO calendar date (YYYY-MM-DD), read in the page's own timezone. */
  date: z.string().min(1),
});

app.get('/:id/available-slots', requirePermission('bookings:read'), zValidator('query', slotsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { date } = c.req.valid('query');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.ownerId, scope));

  try {
    const [page] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!page) return error.notFound(c, 'Booking page', id);

    const slots = await computeAvailableSlots(
      db,
      {
        ownerId: page.ownerId,
        availability: page.availability as WeeklyAvailability | null,
        timezone: page.timezone,
        duration: page.duration,
        bufferBefore: page.bufferBefore,
        bufferAfter: page.bufferAfter,
        minNotice: page.minNotice,
      },
      date,
    );
    return success(c, slots);
  } catch (err) {
    console.error('[app-api/booking-pages] available-slots failed:', err);
    return error.internal(c, 'Failed to compute available slots');
  }
});

export const bookingPagesRoutes = app;
