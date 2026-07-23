/**
 * Inventory movement routes — flat /api/inventory-movements/* surface backed by `inventoryMovements`.
 *
 * Permissions: inventory:read | inventory:create | inventory:update | inventory:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createInventoryMovementSchema, updateInventoryMovementSchema } from '@weldsuite/core-api-client/schemas/inventory-movements';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.inventoryMovements;

app.get('/', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [];
  if (q.productId !== undefined && q.productId !== '') conditions.push(eq(t.productId, q.productId));
  if (q.warehouseId !== undefined && q.warehouseId !== '') {
    conditions.push(
      sql`(${t.sourceWarehouseId} = ${q.warehouseId} OR ${t.destWarehouseId} = ${q.warehouseId})`,
    );
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
    console.error('[app-api/inventory-movements] list failed:', err);
    return error.internal(c, 'Failed to list inventory movements');
  }
});

app.get('/:id', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Inventory movement', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/inventory-movements] get failed:', err);
    return error.internal(c, 'Failed to fetch inventory movement');
  }
});

app.post('/', requirePermission('inventory:create'), zValidator('json', createInventoryMovementSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('imv');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'wms_inventory_movement',
      entityId: id,
      action: 'created',
      data: {
        id,
        productId: data.productId as string,
        movementType: data.movementType as string,
        quantity: data.quantity as number,
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/inventory-movements] create failed:', err);
    return error.internal(c, 'Failed to create inventory movement');
  }
});

app.patch('/:id', requirePermission('inventory:update'), zValidator('json', updateInventoryMovementSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Inventory movement', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'wms_inventory_movement',
      entityId: id,
      action: 'updated',
      data: {
        id,
        productId: existing.productId,
        movementType: (update.movementType as string | undefined) ?? existing.movementType,
        quantity: (update.quantity as number | undefined) ?? existing.quantity,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/inventory-movements] update failed:', err);
    return error.internal(c, 'Failed to update inventory movement');
  }
});

app.delete('/:id', requirePermission('inventory:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Inventory movement', id);
    await db.delete(t).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'wms_inventory_movement',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/inventory-movements] delete failed:', err);
    return error.internal(c, 'Failed to delete inventory movement');
  }
});

export const inventoryMovementsRoutes = app;
