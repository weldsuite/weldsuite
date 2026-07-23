/**
 * Stock adjustment routes — flat /api/stock-adjustments/* surface backed by
 * `stockAdjustments`. Stock adjustments are an append-only audit trail; every
 * entry is permanent. There is no update or delete endpoint by design.
 *
 * Permissions: inventory:read | inventory:create.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createStockAdjustmentSchema } from '@weldsuite/app-api-client/schemas/stock-adjustments';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.stockAdjustments;

app.get('/', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.reason, term), like(t.notes, term))!);
  }
  if (q.type) conditions.push(eq(t.type, q.type));
  if (q.warehouseId) conditions.push(eq(t.warehouseId, q.warehouseId));
  if (q.productId) conditions.push(eq(t.productId, q.productId));
  if (q.sourceType) conditions.push(eq(t.sourceType, q.sourceType));

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
    console.error('[app-api/stock-adjustments] list failed:', err);
    return error.internal(c, 'Failed to list stock adjustments');
  }
});

app.get('/:id', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Stock adjustment', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/stock-adjustments] get failed:', err);
    return error.internal(c, 'Failed to fetch stock adjustment');
  }
});

app.post('/', requirePermission('inventory:create'), zValidator('json', createStockAdjustmentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('adj');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      productId: data.productId as string,
      variantId: data.variantId as string | undefined,
      warehouseId: data.warehouseId as string | undefined,
      locationId: data.locationId as string | undefined,
      inventoryId: data.inventoryId as string | undefined,
      type: data.type as string,
      previousQuantity: data.previousQuantity as number,
      adjustmentQuantity: data.adjustmentQuantity as number,
      newQuantity: data.newQuantity as number,
      lotNumber: data.lotNumber as string | undefined,
      batchNumber: data.batchNumber as string | undefined,
      reason: data.reason as string | undefined,
      reasonCode: data.reasonCode as string | undefined,
      notes: data.notes as string | undefined,
      performedBy: data.performedBy as string | undefined,
      performedByName: data.performedByName as string | undefined,
      sourceType: data.sourceType as string | undefined,
      sourceId: data.sourceId as string | undefined,
      sourceNumber: data.sourceNumber as string | undefined,
      requiresApproval: data.requiresApproval ? 1 : 0,
      approvalStatus: data.requiresApproval ? 'pending' : 'approved',
      metadata: data.metadata as Record<string, unknown> | undefined,
      createdAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'wms_adjustment',
      entityId: id,
      action: 'created',
      data: {
        id,
        productId: data.productId as string,
        type: data.type as string,
        adjustmentQuantity: data.adjustmentQuantity as number,
        newQuantity: data.newQuantity as number,
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/stock-adjustments] create failed:', err);
    return error.internal(c, 'Failed to create stock adjustment');
  }
});

export const stockAdjustmentsRoutes = app;
