/**
 * Purchase order routes — flat /api/purchase-orders/* surface backed by `purchaseOrders`,
 * and its lines under /api/purchase-orders/:id/items backed by `purchaseOrderItems`.
 *
 * A line carries the WeldFlow project its cost belongs to (`projectId`, FLOW-019).
 * The server works out the line's amounts (services/purchase-order-items.ts); the
 * purchase order's own totals are not recomputed. Each line change publishes
 * `purchase_order` `updated`, as the header's own update does.
 *
 * Permissions: orders:read | orders:create | orders:update | orders:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, isNull, like, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createPurchaseOrderItemSchema,
  createPurchaseOrderSchema,
  updatePurchaseOrderItemSchema,
  updatePurchaseOrderSchema,
} from '@weldsuite/core-api-client/schemas/purchase-orders';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { liveProjectExists, lineAmounts } from '../../services/purchase-order-items';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.purchaseOrders;
const items = schema.purchaseOrderItems;

/** Filter conditions derived from the list query string. */
function buildPurchaseOrderFilters(q: Record<string, string>): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (q.supplierId !== undefined && q.supplierId !== '') conditions.push(eq(t.supplierId, q.supplierId));
  if (q.warehouseId !== undefined && q.warehouseId !== '') conditions.push(eq(t.warehouseId, q.warehouseId));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.search) {
    conditions.push(like(t.poNumber, `%${q.search}%`));
  }
  return conditions;
}

/** Keyset condition for the row after `cursor`, or undefined when the cursor row is unknown. */
async function buildCursorCondition(
  db: Variables['tenantDb'],
  cursor: string,
): Promise<SQL | undefined> {
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursor)).limit(1);
  if (!cur?.createdAt) return undefined;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

app.get('/', requirePermission('orders:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const conditions = buildPurchaseOrderFilters(q);
  if (q.cursor) {
    const cursorCondition = await buildCursorCondition(db, q.cursor);
    if (cursorCondition) conditions.push(cursorCondition);
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

// ── Lines ────────────────────────────────────────────────────────────────────

type PurchaseOrderRow = typeof t.$inferSelect;
type PurchaseOrderItemRow = typeof items.$inferSelect;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The same event the header's own update publishes: a line is part of the purchase order. */
function publishPurchaseOrderUpdated(c: AppContext, po: PurchaseOrderRow) {
  publishEntityEvent({
    c,
    entityType: 'purchase_order',
    entityId: po.id,
    action: 'updated',
    data: { id: po.id, poNumber: po.poNumber, status: po.status, supplierId: po.supplierId },
  });
}

/** The line's figures as the stored row has them, for the amounts the server works out. */
function figuresOf(row: PurchaseOrderItemRow) {
  return {
    quantityOrdered: row.quantityOrdered,
    quantityReceived: row.quantityReceived ?? 0,
    unitPrice: Number(row.unitPrice),
    discountPercent: Number(row.discountPercent ?? '0'),
    taxPercent: Number(row.taxPercent ?? '0'),
  };
}

app.get('/:id/items', requirePermission('orders:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [po] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!po) return error.notFound(c, 'Purchase order', id);
    const rows = await db.select().from(items).where(eq(items.purchaseOrderId, id)).orderBy(asc(items.createdAt), asc(items.id));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[stash-api/purchase-orders] list lines failed:', err);
    return error.internal(c, 'Failed to list purchase order lines');
  }
});

app.post('/:id/items', requirePermission('orders:update'), zValidator('json', createPurchaseOrderItemSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [po] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!po) return error.notFound(c, 'Purchase order', id);
    if (data.projectId && !(await liveProjectExists(db, data.projectId))) {
      return error.badRequest(c, `Project ${data.projectId} does not exist`);
    }
    const quantityOrdered = data.quantityOrdered ?? 1;
    const quantityReceived = data.quantityReceived ?? 0;
    const amounts = lineAmounts({
      quantityOrdered,
      quantityReceived,
      unitPrice: data.unitPrice,
      discountPercent: data.discountPercent ?? 0,
      taxPercent: data.taxPercent ?? 0,
    });
    const now = new Date();
    const [row] = await db
      .insert(items)
      .values({
        id: generateId('poi'),
        purchaseOrderId: id,
        productId: data.productId ?? null,
        variantId: data.variantId ?? null,
        sku: data.sku ?? null,
        name: data.name,
        description: data.description ?? null,
        quantityOrdered,
        quantityReceived,
        quantityPending: amounts.quantityPending,
        quantityRejected: data.quantityRejected ?? 0,
        unitPrice: amounts.unitPrice,
        discountPercent: amounts.discountPercent,
        discountAmount: amounts.discountAmount,
        taxPercent: amounts.taxPercent,
        taxAmount: amounts.taxAmount,
        total: amounts.total,
        notes: data.notes ?? null,
        projectId: data.projectId || null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    publishPurchaseOrderUpdated(c, po);
    return success(c, row, 201);
  } catch (err) {
    console.error('[stash-api/purchase-orders] create line failed:', err);
    return error.internal(c, 'Failed to create purchase order line');
  }
});

app.patch('/:id/items/:itemId', requirePermission('orders:update'), zValidator('json', updatePurchaseOrderItemSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');
  const data = c.req.valid('json');
  try {
    const [po] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!po) return error.notFound(c, 'Purchase order', id);
    const [existing] = await db.select().from(items).where(and(eq(items.id, itemId), eq(items.purchaseOrderId, id))).limit(1);
    if (!existing) return error.notFound(c, 'Purchase order line', itemId);
    if (data.projectId && !(await liveProjectExists(db, data.projectId))) {
      return error.badRequest(c, `Project ${data.projectId} does not exist`);
    }
    const before = figuresOf(existing);
    const amounts = lineAmounts({
      quantityOrdered: data.quantityOrdered ?? before.quantityOrdered,
      quantityReceived: data.quantityReceived ?? before.quantityReceived,
      unitPrice: data.unitPrice ?? before.unitPrice,
      discountPercent: data.discountPercent ?? before.discountPercent,
      taxPercent: data.taxPercent ?? before.taxPercent,
    });
    const [row] = await db
      .update(items)
      .set({
        ...(data.productId !== undefined && { productId: data.productId }),
        ...(data.variantId !== undefined && { variantId: data.variantId }),
        ...(data.sku !== undefined && { sku: data.sku }),
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.quantityOrdered !== undefined && { quantityOrdered: data.quantityOrdered }),
        ...(data.quantityReceived !== undefined && { quantityReceived: data.quantityReceived }),
        ...(data.quantityRejected !== undefined && { quantityRejected: data.quantityRejected }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.projectId !== undefined && { projectId: data.projectId || null }),
        quantityPending: amounts.quantityPending,
        unitPrice: amounts.unitPrice,
        discountPercent: amounts.discountPercent,
        discountAmount: amounts.discountAmount,
        taxPercent: amounts.taxPercent,
        taxAmount: amounts.taxAmount,
        total: amounts.total,
        updatedAt: new Date(),
      })
      .where(eq(items.id, itemId))
      .returning();
    publishPurchaseOrderUpdated(c, po);
    return success(c, row);
  } catch (err) {
    console.error('[stash-api/purchase-orders] update line failed:', err);
    return error.internal(c, 'Failed to update purchase order line');
  }
});

app.delete('/:id/items/:itemId', requirePermission('orders:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');
  try {
    const [po] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!po) return error.notFound(c, 'Purchase order', id);
    const [existing] = await db.select({ id: items.id }).from(items).where(and(eq(items.id, itemId), eq(items.purchaseOrderId, id))).limit(1);
    if (!existing) return error.notFound(c, 'Purchase order line', itemId);
    await db.delete(items).where(eq(items.id, itemId));
    publishPurchaseOrderUpdated(c, po);
    return noContent(c);
  } catch (err) {
    console.error('[stash-api/purchase-orders] delete line failed:', err);
    return error.internal(c, 'Failed to delete purchase order line');
  }
});

export const purchaseOrdersRoutes = app;
