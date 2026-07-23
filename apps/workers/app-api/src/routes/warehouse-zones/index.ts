/**
 * Warehouse zone routes — flat /api/warehouse-zones/* surface backed by
 * `warehouseZones`. Zones are logical areas within a warehouse and share the
 * warehouse permission prefix.
 *
 * Permissions: warehouses:read | warehouses:create | warehouses:update | warehouses:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createWarehouseZoneSchema,
  updateWarehouseZoneSchema,
} from '@weldsuite/app-api-client/schemas/warehouse-zones';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.warehouseZones;

app.get('/', requirePermission('warehouses:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.code, term))!);
  }
  if (q.warehouseId) conditions.push(eq(t.warehouseId, q.warehouseId));
  if (q.zoneType) conditions.push(eq(t.zoneType, q.zoneType));
  if (q.isActive !== undefined) conditions.push(eq(t.isActive, q.isActive === 'true'));

  if (q.cursor) {
    const [cur] = await db
      .select({ pickingSequence: t.pickingSequence, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) {
      conditions.push(
        sql`(${t.pickingSequence} > ${cur.pickingSequence} OR (${t.pickingSequence} = ${cur.pickingSequence} AND ${t.id} > ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(asc(t.pickingSequence), asc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/warehouse-zones] list failed:', err);
    return error.internal(c, 'Failed to list warehouse zones');
  }
});

app.get('/:id', requirePermission('warehouses:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Warehouse zone', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/warehouse-zones] get failed:', err);
    return error.internal(c, 'Failed to fetch warehouse zone');
  }
});

app.post('/', requirePermission('warehouses:create'), zValidator('json', createWarehouseZoneSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('zone');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      ...data,
      totalLocations: 0,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'warehouse_zone',
      entityId: id,
      action: 'created',
      data: { id, name: data.name as string, warehouseId: data.warehouseId as string },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/warehouse-zones] create failed:', err);
    return error.internal(c, 'Failed to create warehouse zone');
  }
});

app.patch('/:id', requirePermission('warehouses:update'), zValidator('json', updateWarehouseZoneSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Warehouse zone', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'warehouse_zone',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name,
        warehouseId: existing.warehouseId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/warehouse-zones] update failed:', err);
    return error.internal(c, 'Failed to update warehouse zone');
  }
});

app.delete('/:id', requirePermission('warehouses:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Warehouse zone', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'warehouse_zone',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/warehouse-zones] delete failed:', err);
    return error.internal(c, 'Failed to delete warehouse zone');
  }
});

export const warehouseZonesRoutes = app;
