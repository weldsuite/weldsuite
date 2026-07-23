/**
 * Booking routes — flat /api/bookings/* surface backed by `calendarBookings`.
 *
 * Permissions: bookings:read | bookings:create | bookings:update | bookings:delete.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ensurePermissionsResolved, requirePermission } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createBookingSchema, updateBookingSchema } from '@weldsuite/core-api-client/schemas/bookings';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.calendarBookings;
const bp = schema.calendarBookingPages;

const BOOKING_DENIED = 'You do not have access to this booking';

/** Own-only (booking-page owner) unless the caller holds bookings:scope:all. */
async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  if (hasPermission(resolved?.permissions ?? [], 'bookings:scope:all')) return undefined;
  return c.get('userId');
}

/** True if `scope` owns the booking page a booking belongs to. */
async function ownsPage(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  bookingPageId: string,
  scope: string,
): Promise<boolean> {
  const db = c.get('tenantDb');
  const [page] = await db.select({ ownerId: bp.ownerId }).from(bp).where(eq(bp.id, bookingPageId)).limit(1);
  return !!page && page.ownerId === scope;
}

app.get('/', requirePermission('bookings:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.bookingPageId !== undefined && q.bookingPageId !== '') conditions.push(eq(t.bookingPageId, q.bookingPageId));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  // Owner scope: restrict to bookings on the caller's own pages unless scope:all.
  const scope = await scopeFor(c);
  if (scope) {
    const pages = await db.select({ id: bp.id }).from(bp).where(eq(bp.ownerId, scope));
    const pageIds = pages.map((p) => p.id);
    conditions.push(inArray(t.bookingPageId, pageIds.length ? pageIds : ['']));
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
    console.error('[app-api/bookings] list failed:', err);
    return error.internal(c, 'Failed to list bookings');
  }
});

app.get('/:id', requirePermission('bookings:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Booking', id);
    const scope = await scopeFor(c);
    if (scope && !(await ownsPage(c, row.bookingPageId, scope))) {
      return error.forbidden(c, BOOKING_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/bookings] get failed:', err);
    return error.internal(c, 'Failed to fetch booking');
  }
});

app.post('/', requirePermission('bookings:create'), zValidator('json', createBookingSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('bk');
  const now = new Date();
  const scope = await scopeFor(c);
  if (scope && !(await ownsPage(c, data.bookingPageId as string, scope))) {
    return error.forbidden(c, BOOKING_DENIED);
  }
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'calendar_booking',
      entityId: id,
      action: 'created',
      data: {
        id,
        bookingPageId: data.bookingPageId as string,
        bookerEmail: data.bookerEmail as string,
        status: (data.status as string | undefined) ?? 'confirmed',
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/bookings] create failed:', err);
    return error.internal(c, 'Failed to create booking');
  }
});

app.patch('/:id', requirePermission('bookings:update'), zValidator('json', updateBookingSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Booking', id);
    const scope = await scopeFor(c);
    if (scope && !(await ownsPage(c, existing.bookingPageId, scope))) {
      return error.forbidden(c, BOOKING_DENIED);
    }
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'calendar_booking',
      entityId: id,
      action: 'updated',
      data: {
        id,
        bookingPageId: (update.bookingPageId as string | undefined) ?? existing.bookingPageId,
        bookerEmail: (update.bookerEmail as string | undefined) ?? existing.bookerEmail,
        status: (update.status as string | undefined) ?? existing.status,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/bookings] update failed:', err);
    return error.internal(c, 'Failed to update booking');
  }
});

app.delete('/:id', requirePermission('bookings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Booking', id);
    const scope = await scopeFor(c);
    if (scope && !(await ownsPage(c, existing.bookingPageId, scope))) {
      return error.forbidden(c, BOOKING_DENIED);
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'calendar_booking',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/bookings] delete failed:', err);
    return error.internal(c, 'Failed to delete booking');
  }
});

export const bookingsRoutes = app;
