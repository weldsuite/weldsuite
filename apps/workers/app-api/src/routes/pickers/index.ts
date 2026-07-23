/**
 * Pickers (warehouse worker) routes — flat /api/pickers/* surface backed by
 * `warehouseWorkers`. Pickers are warehouse staff who fulfil pick lists in WeldStash.
 *
 * Permissions: warehouses:read | warehouses:create | warehouses:update | warehouses:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createPickerSchema,
  updatePickerSchema,
} from '@weldsuite/app-api-client/schemas/pickers';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.warehouseWorkers;

// ---------------------------------------------------------------------------
// GET / — list pickers with optional filters + stats block
// ---------------------------------------------------------------------------
app.get('/', requirePermission('warehouses:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];

  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.email, term))!);
  }
  if (q.status && q.status !== 'all') conditions.push(eq(t.status, q.status));
  if (q.warehouseId && q.warehouseId !== 'all') conditions.push(eq(t.warehouseId, q.warehouseId));
  if (q.role && q.role !== 'all') conditions.push(eq(t.role, q.role));

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
    const [rows, countRes, statsRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
      db.select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${t.status} = 'active')::int`,
        inactive: sql<number>`count(*) filter (where ${t.status} = 'inactive')::int`,
        on_break: sql<number>`count(*) filter (where ${t.status} = 'on_break')::int`,
      }).from(t).where(isNull(t.deletedAt)),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    const stats = statsRes[0] ?? { total: 0, active: 0, inactive: 0, on_break: 0 };

    return c.json({
      data,
      pagination: cursorPagination(totalCount, hasMore, nextCursor),
      stats,
    });
  } catch (err) {
    console.error('[app-api/pickers] list failed:', err);
    return error.internal(c, 'Failed to list pickers');
  }
});

// ---------------------------------------------------------------------------
// GET /stats — picker statistics (optionally scoped to a warehouse)
// ---------------------------------------------------------------------------
app.get('/stats', requirePermission('warehouses:read'), async (c) => {
  const db = c.get('tenantDb');
  const { warehouseId } = c.req.query();

  const conditions: any[] = [isNull(t.deletedAt)];
  if (warehouseId && warehouseId !== 'all') conditions.push(eq(t.warehouseId, warehouseId));
  const where = conditions.length ? and(...conditions) : undefined;

  try {
    const [res] = await db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${t.status} = 'active')::int`,
      inactive: sql<number>`count(*) filter (where ${t.status} = 'inactive')::int`,
      on_break: sql<number>`count(*) filter (where ${t.status} = 'on_break')::int`,
    }).from(t).where(where);

    return success(c, res ?? { total: 0, active: 0, inactive: 0, on_break: 0 });
  } catch (err) {
    console.error('[app-api/pickers] stats failed:', err);
    return error.internal(c, 'Failed to fetch picker stats');
  }
});

// ---------------------------------------------------------------------------
// GET /:id — single picker with picklist performance stats
// ---------------------------------------------------------------------------
app.get('/:id', requirePermission('warehouses:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const pl = schema.pickLists;

  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Picker', id);

    const [performance] = await db.select({
      totalPicklists: sql<number>`count(*)::int`,
      completedPicklists: sql<number>`count(*) filter (where ${pl.status} = 'completed')::int`,
      totalItems: sql<number>`coalesce(sum(${pl.totalItems}), 0)::int`,
      pickedItems: sql<number>`coalesce(sum(${pl.pickedItems}), 0)::int`,
    }).from(pl).where(and(eq(pl.assignedTo, id), isNull(pl.deletedAt)));

    return success(c, {
      ...row,
      performance: performance ?? { totalPicklists: 0, completedPicklists: 0, totalItems: 0, pickedItems: 0 },
    });
  } catch (err) {
    console.error('[app-api/pickers] get failed:', err);
    return error.internal(c, 'Failed to fetch picker');
  }
});

// ---------------------------------------------------------------------------
// GET /:id/picklists — picklists assigned to this picker
// ---------------------------------------------------------------------------
app.get('/:id/picklists', requirePermission('warehouses:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { status } = c.req.query();
  const pl = schema.pickLists;

  const conditions: any[] = [eq(pl.assignedTo, id), isNull(pl.deletedAt)];
  if (status && status !== 'all') conditions.push(eq(pl.status, status));

  try {
    const rows = await db
      .select()
      .from(pl)
      .where(and(...conditions))
      .orderBy(desc(pl.createdAt))
      .limit(50);

    return success(c, rows);
  } catch (err) {
    console.error('[app-api/pickers] picklists failed:', err);
    return error.internal(c, 'Failed to fetch picker picklists');
  }
});

// ---------------------------------------------------------------------------
// POST / — create picker
// ---------------------------------------------------------------------------
app.post('/', requirePermission('warehouses:create'), zValidator('json', createPickerSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('wkr');
  const now = new Date();

  try {
    await db.insert(t).values({
      id,
      userId: data.userId as string | undefined,
      name: data.name as string,
      email: data.email as string | undefined,
      phone: data.phone as string | undefined,
      warehouseId: data.warehouseId as string | undefined,
      role: (data.role as string | undefined) ?? 'picker',
      status: (data.status as string | undefined) ?? 'active',
      skills: data.skills as string[] | undefined,
      notes: data.notes as string | undefined,
      metadata: data.metadata as Record<string, unknown> | undefined,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);

    publishEntityEvent({
      c,
      entityType: 'picker',
      entityId: id,
      action: 'created',
      data: { id, name: data.name as string, warehouseId: data.warehouseId as string | undefined },
    });

    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/pickers] create failed:', err);
    return error.internal(c, 'Failed to create picker');
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — full update
// ---------------------------------------------------------------------------
app.put('/:id', requirePermission('warehouses:update'), zValidator('json', updatePickerSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;

  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Picker', id);

    const update: Record<string, any> = { updatedAt: new Date() };
    const fields = ['name', 'email', 'phone', 'warehouseId', 'role', 'status', 'skills', 'notes', 'userId', 'metadata'];
    for (const key of fields) {
      if (data[key] !== undefined) update[key] = data[key];
    }

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'picker',
      entityId: id,
      action: 'updated',
      data: { id, name: (update.name as string | undefined) ?? existing.name },
    });

    return success(c, { id });
  } catch (err) {
    console.error('[app-api/pickers] update failed:', err);
    return error.internal(c, 'Failed to update picker');
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id/status — update status only
// ---------------------------------------------------------------------------
app.patch('/:id/status', requirePermission('warehouses:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { status?: string };
  const { status } = body;

  if (!status) return error.badRequest(c, 'Status is required');

  try {
    const [existing] = await db.select({ id: t.id }).from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Picker', id);

    await db.update(t).set({ status, updatedAt: new Date() }).where(and(eq(t.id, id), isNull(t.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'picker',
      entityId: id,
      action: 'updated',
      data: { id, status },
    });

    return success(c, { id, status });
  } catch (err) {
    console.error('[app-api/pickers] status update failed:', err);
    return error.internal(c, 'Failed to update picker status');
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — soft delete
// ---------------------------------------------------------------------------
app.delete('/:id', requirePermission('warehouses:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Picker', id);

    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    publishEntityEvent({
      c,
      entityType: 'picker',
      entityId: id,
      action: 'deleted',
      data: { id, name: existing.name },
    });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/pickers] delete failed:', err);
    return error.internal(c, 'Failed to delete picker');
  }
});

export const pickersRoutes = app;
