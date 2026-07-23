/**
 * Purchase order routes — flat /api/purchase-orders/* surface backed by `purchaseOrders`.
 *
 * Permissions: orders:read | orders:create | orders:update | orders:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createPurchaseOrderSchema, updatePurchaseOrderSchema } from '@weldsuite/core-api-client/schemas/purchase-orders';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.purchaseOrders;

app.get('/', requirePermission('orders:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.supplierId !== undefined && q.supplierId !== '') conditions.push(eq(t.supplierId, q.supplierId));
  if (q.warehouseId !== undefined && q.warehouseId !== '') conditions.push(eq(t.warehouseId, q.warehouseId));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.search) {
    conditions.push(like(t.poNumber, `%${q.search}%`));
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
    console.error('[app-api/purchase-orders] list failed:', err);
    return error.internal(c, 'Failed to list purchase orders');
  }
});

app.get('/:id', requirePermission('orders:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Purchase order', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/purchase-orders] get failed:', err);
    return error.internal(c, 'Failed to fetch purchase order');
  }
});

app.post('/', requirePermission('orders:create'), zValidator('json', createPurchaseOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('po');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({ c, entityType: 'purchase_order', entityId: id, action: 'created', data: { id, poNumber: data.poNumber, status: data.status, supplierId: data.supplierId } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/purchase-orders] create failed:', err);
    return error.internal(c, 'Failed to create purchase order');
  }
});

app.patch('/:id', requirePermission('orders:update'), zValidator('json', updatePurchaseOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Purchase order', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({ c, entityType: 'purchase_order', entityId: id, action: 'updated', data: { id, poNumber: (update.poNumber as string | undefined) ?? existing.poNumber, status: (update.status as string | undefined) ?? existing.status, supplierId: (update.supplierId as string | undefined) ?? existing.supplierId } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/purchase-orders] update failed:', err);
    return error.internal(c, 'Failed to update purchase order');
  }
});

app.delete('/:id', requirePermission('orders:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Purchase order', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'purchase_order', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/purchase-orders] delete failed:', err);
    return error.internal(c, 'Failed to delete purchase order');
  }
});

export const purchaseOrdersRoutes = app;
