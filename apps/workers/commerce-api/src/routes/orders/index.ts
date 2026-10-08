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
 *
 * Sales tax (docs/plans/weldbooks-us.md, phase 6): `POST /calculate-tax`
 * prices a cart or draft, `POST /:id/calculate-tax` recalculates a stored
 * order (and with `apply` writes it), and `POST` / `PATCH` take
 * `calculateTax: true` to do the same as they write. The engine is WeldBooks'
 * (services/order-sales-tax.ts); a failing engine answers 503 and writes
 * nothing, it never turns into zero tax.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { createOrderSchema, updateOrderSchema } from '@weldsuite/core-api-client/schemas/orders';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { BASE36_UPPER, randomString } from '@weldsuite/worker-kit/random';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import {
  OrderSalesTaxError,
  calculateOrderSalesTax,
  calculateOrderTax,
  loadOrderTaxItems,
  orderItemTaxStatements,
  orderTaxLockReason,
  persistOrderTax,
  toTaxResponse,
  type OrderTaxApplication,
  type OrderSalesTaxResult,
} from '../../services/order-sales-tax';
import { calculateCartTaxSchema, calculateOrderTaxSchema } from './calculate-tax-schemas';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.orders;

/** An engine failure as the API answers it: 503 `TAX_ENGINE_UNAVAILABLE`, or 422 `TAX_REQUEST_INVALID` for a request the engine can't place. */
function taxErrorResponse(c: Context, err: OrderSalesTaxError) {
  return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
}

/** What a stored order holds of its tax after an application, for the response. */
function appliedOrder(id: string, application: OrderTaxApplication) {
  const { taxLines, taxTotal, total } = application.order;
  return { id, taxLines, taxTotal, total };
}

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

/**
 * Prices a cart or draft that is not stored. Nothing is written, so a
 * checkout can call it on every change of address or basket.
 */
app.post('/calculate-tax', requirePermission('orders:create'), zValidator('json', calculateCartTaxSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  try {
    const result = await calculateOrderSalesTax(db, c.env, {
      lines: body.lines,
      shippingAmount: body.shippingAmount,
      shipTo: body.shipTo,
      billTo: body.billTo,
      customerPartyId: body.customerPartyId,
      customerUse: body.customerUse,
      date: body.date,
      currency: body.currency,
      marketplaceFacilitated: body.marketplaceFacilitated,
    });
    return success(c, toTaxResponse(result));
  } catch (err) {
    if (err instanceof OrderSalesTaxError) return taxErrorResponse(c, err);
    console.error('[commerce-api/orders] calculate cart tax failed:', err);
    return error.internal(c, 'Failed to calculate tax');
  }
});

/**
 * Recalculates a stored order from its items, shipping and addresses. With
 * `apply: true` (needs `orders:update`) it writes `taxLines`, `taxTotal`,
 * `total` and each item's `taxAmount`, and keeps the engine's detail in
 * `metadata.salesTax`. A paid or cancelled order can be previewed, not applied.
 */
app.post('/:id/calculate-tax', requirePermission('orders:read'), zValidator('json', calculateOrderTaxSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const apply = body.apply === true;
  try {
    if (apply && !(await hasContextPermission(c, 'orders:update'))) {
      return error.forbidden(c, 'You do not have permission to apply tax to an order');
    }
    const [order] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!order) return error.notFound(c, 'Order', id);
    if (apply) {
      const locked = orderTaxLockReason(order);
      if (locked) return c.json({ error: { code: 'ORDER_TAX_LOCKED', message: locked } }, 409);
    }

    const items = await loadOrderTaxItems(db, id);
    const { result, application } = await calculateOrderTax(db, c.env, order, items, {
      date: body.date,
      customerUse: body.customerUse,
      marketplaceFacilitated: body.marketplaceFacilitated,
    });
    if (!apply || !application) return success(c, { ...toTaxResponse(result), applied: false });

    await persistOrderTax(db, id, application);
    publishEntityEvent({
      c,
      entityType: 'commerce_order',
      entityId: id,
      action: 'updated',
      data: {
        id,
        orderNumber: order.orderNumber,
        status: order.status,
        total: application.order.total,
        currency: order.currency,
        customerId: order.customerId,
        customerEmail: order.customerEmail,
      },
    });
    return success(c, { ...toTaxResponse(result), applied: true, order: appliedOrder(id, application) });
  } catch (err) {
    if (err instanceof OrderSalesTaxError) return taxErrorResponse(c, err);
    console.error('[commerce-api/orders] calculate order tax failed:', err);
    return error.internal(c, 'Failed to calculate order tax');
  }
});

app.post('/', requirePermission('orders:create'), zValidator('json', createOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  // `calculateTax` is a request flag, not an order column.
  const { calculateTax, ...data } = c.req.valid('json') as Record<string, any>;
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
    // Tax first: an engine failure refuses the order instead of storing it with a guessed tax.
    let tax: OrderSalesTaxResult | undefined;
    let taxColumns: Partial<OrderTaxApplication['order']> = {};
    if (calculateTax === true) {
      const calculated = await calculateOrderTax(db, c.env, { ...data, id, createdAt: now }, []);
      tax = calculated.result;
      if (calculated.application) taxColumns = calculated.application.order;
    }
    await db
      .insert(t)
      .values({ id, ...data, ...taxColumns, orderNumber, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'commerce_order',
      entityId: id,
      action: 'created',
      data: { id, orderNumber, status: data.status, total: taxColumns.total ?? data.total, currency: data.currency, customerId: data.customerId, customerEmail: data.customerEmail },
    });
    return success(c, tax ? { id, tax: toTaxResponse(tax) } : { id }, 201);
  } catch (err) {
    if (err instanceof OrderSalesTaxError) return taxErrorResponse(c, err);
    console.error('[app-api/orders] create failed:', err);
    return error.internal(c, 'Failed to create order');
  }
});

app.patch('/:id', requirePermission('orders:update'), zValidator('json', updateOrderSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  // `calculateTax` is a request flag, not an order column.
  const { calculateTax, ...data } = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Order', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;

    // Tax first, on the order as it will be after this write: an engine failure refuses the update.
    let tax: OrderSalesTaxResult | undefined;
    let application: OrderTaxApplication | undefined;
    if (calculateTax === true) {
      const locked = orderTaxLockReason(existing);
      if (locked) return c.json({ error: { code: 'ORDER_TAX_LOCKED', message: locked } }, 409);
      const items = await loadOrderTaxItems(db, id);
      const calculated = await calculateOrderTax(db, c.env, { ...existing, ...update }, items);
      tax = calculated.result;
      application = calculated.application;
      if (application) Object.assign(update, application.order);
    }
    if (application) {
      const taxed = application;
      await atomically(db, (h) => [
        h.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt))),
        ...orderItemTaxStatements(h, taxed),
      ]);
    } else {
      await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    }
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
    return success(c, tax ? { id, tax: toTaxResponse(tax), ...(application ? { order: appliedOrder(id, application) } : {}) } : { id });
  } catch (err) {
    if (err instanceof OrderSalesTaxError) return taxErrorResponse(c, err);
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
