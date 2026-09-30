/**
 * Order routes — flat /api/orders/* surface backed by `orders`.
 *
 * Permissions: orders:read | orders:create | orders:update | orders:delete.
 *
 * `GET /:id/items` reads the existing `order_items` table (indexed on
 * `order_id`). Read-only for now: writing line items belongs with the order
 * state machine and stock reservation in Phase 3 of
 * `.claude/weldcommerce-plan.md`, since adding an item to a placed order has
 * to move inventory too.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { requirePermission } from '@weldsuite/permissions/server';
import { createOrderSchema, updateOrderSchema } from '@weldsuite/core-api-client/schemas/orders';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { BASE36_UPPER, randomString } from '@weldsuite/worker-kit/random';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.orders;

/** WHERE conditions for the list endpoint's query-string filters (no cursor). */
function buildListFilters(q: Record<string, string>): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt)];
  const equalityFilters: Array<[string | undefined, AnyPgColumn]> = [
    [q.customerId, t.customerId],
    [q.status, t.status],
    [q.fulfillmentStatus, t.fulfillmentStatus],
  ];
  for (const [value, column] of equalityFilters) {
    if (value) conditions.push(eq(column, value));
  }
  if (q.search) {
    conditions.push(like(t.orderNumber, `%${q.search}%`));
  }
  return conditions;
}

/** Keyset condition that resumes after the row identified by `cursorId`, if it exists. */
async function buildCursorCondition(
  db: Variables['tenantDb'],
  cursorId: string,
): Promise<SQL | undefined> {
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursorId)).limit(1);
  if (!cur?.createdAt) return undefined;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

app.get('/', requirePermission('orders:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const filterConditions = buildListFilters(q);
  const cursorCondition = q.cursor ? await buildCursorCondition(db, q.cursor) : undefined;
  const where = and(...filterConditions, cursorCondition);
  const countWhere = and(...filterConditions);

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
    console.error('[app-api/orders] list failed:', err);
    return error.internal(c, 'Failed to list orders');
  }
});

app.get('/:id', requirePermission('orders:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Order', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/orders] get failed:', err);
    return error.internal(c, 'Failed to fetch order');
  }
});

/**
 * Line items for one order. Ordered by insertion (`id`) so the list is stable
 * — `order_items` has no explicit position column.
 */
app.get('/:id/items', requirePermission('orders:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [order] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!order) return error.notFound(c, 'Order', id);

    const rows = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, id))
      .orderBy(schema.orderItems.id);

    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/orders] list items failed:', err);
    return error.internal(c, 'Failed to list order items');
  }
});

app.post('/', requirePermission('orders:create'), zValidator('json', createOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('ord');
  const now = new Date();
  // `orderNumber` is NOT NULL at the DB but optional in Zod. Auto-
  // generate one when missing so the route works without forcing the
  // caller to mint a number.
  const orderNumber =
    typeof data.orderNumber === 'string' && data.orderNumber.length > 0
      ? data.orderNumber
      : `ORD-${Date.now().toString(36).toUpperCase()}-${randomString(4, BASE36_UPPER)}`;
  try {
    await db
      .insert(t)
      .values({ id, ...data, orderNumber, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'commerce_order',
      entityId: id,
      action: 'created',
      data: { id, orderNumber, status: data.status, total: data.total, currency: data.currency, customerId: data.customerId, customerEmail: data.customerEmail },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/orders] create failed:', err);
    return error.internal(c, 'Failed to create order');
  }
});

app.patch('/:id', requirePermission('orders:update'), zValidator('json', updateOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Order', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'commerce_order',
      entityId: id,
      action: 'updated',
      data: {
        id,
        orderNumber: existing.orderNumber,
        status: (update.status as string | null | undefined) ?? existing.status,
        total: (update.total as string | null | undefined) ?? existing.total,
        currency: (update.currency as string | null | undefined) ?? existing.currency,
        customerId: existing.customerId,
        customerEmail: existing.customerEmail,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/orders] update failed:', err);
    return error.internal(c, 'Failed to update order');
  }
});

app.delete('/:id', requirePermission('orders:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Order', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'commerce_order',
      entityId: id,
      action: 'deleted',
      data: { id, orderNumber: existing.orderNumber },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/orders] delete failed:', err);
    return error.internal(c, 'Failed to delete order');
  }
});

export const ordersRoutes = app;
