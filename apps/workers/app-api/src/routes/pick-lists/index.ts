/**
 * Pick list routes — generate from unfulfilled orders, execute picks,
 * pack, and ship. Stock writes go through the inventory ledger.
 *
 * Permissions: picklists:read | picklists:create | picklists:update | picklists:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  assignPickListSchema,
  createPickListSchema,
  generatePickListSchema,
  pickItemSchema,
  updatePickListSchema,
} from '@weldsuite/core-api-client/schemas/pick-lists';
import { shipPickListSchema } from '@weldsuite/app-api-client/schemas/sendcloud';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { StockLedgerError } from '../../services/inventory-ledger';
import {
  assignPickList,
  cancelPickList,
  completePickList,
  confirmPickItem,
  generatePickList,
  getPickListWithItems,
  packPickList,
  PickListError,
  orderRequiresCarrier,
  renderPackingSlipHtml,
  shipPickList,
  startPickList,
} from '../../services/pick-lists';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.pickLists;

function mapPickError(c: Parameters<typeof error.badRequest>[0], err: unknown, fallback: string) {
  if (err instanceof PickListError) {
    if (err.code === 'ORDER_NOT_FOUND') return error.notFound(c, 'Order');
    if (err.code === 'WAREHOUSE_NOT_FOUND') return error.notFound(c, 'Warehouse');
    if (err.code === 'ITEM_NOT_FOUND') return error.notFound(c, 'Pick list item');
    if (err.code === 'ALREADY_PICKING') return error.conflict(c, err.message, { code: err.code });
    if (err.code === 'SHIPPING_NOT_CONFIGURED') return error.conflict(c, err.message, { code: err.code });
    if (err.code === 'SENDCLOUD_FAILED') return error.conflict(c, err.message, { code: err.code });
    return error.badRequest(c, err.message, { code: err.code });
  }
  if (err instanceof StockLedgerError) {
    if (err.code === 'PRODUCT_NOT_FOUND') return error.notFound(c, 'Product');
    if (err.code === 'INSUFFICIENT_STOCK' || err.code === 'INSUFFICIENT_AVAILABLE') {
      return error.conflict(c, err.message, { code: err.code });
    }
    return error.badRequest(c, err.message, { code: err.code });
  }
  console.error(`[app-api/pick-lists] ${fallback}:`, err);
  return error.internal(c, fallback);
}

app.get('/', requirePermission('picklists:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: ReturnType<typeof eq>[] = [isNull(t.deletedAt)] as never[];
  if (q.warehouseId !== undefined && q.warehouseId !== '') conditions.push(eq(t.warehouseId, q.warehouseId));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.assignedTo !== undefined && q.assignedTo !== '') conditions.push(eq(t.assignedTo, q.assignedTo));
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))` as never,
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
    console.error('[app-api/pick-lists] list failed:', err);
    return error.internal(c, 'Failed to list pick lists');
  }
});

app.post('/generate', requirePermission('picklists:create'), zValidator('json', generatePickListSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  try {
    const result = await generatePickList(db, {
      ...body,
      createdBy: c.get('userId'),
    });
    publishEntityEvent({
      c,
      entityType: 'picklist',
      entityId: result.id,
      action: 'created',
      data: result,
    });
    return success(c, result, 201);
  } catch (err) {
    return mapPickError(c, err, 'Failed to generate pick list');
  }
});

app.get('/:id/packing-slip', requirePermission('picklists:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await getPickListWithItems(db, id);
    if (!row) return error.notFound(c, 'Pick list', id);
    const [warehouse] = await db
      .select({ name: schema.warehouses.name })
      .from(schema.warehouses)
      .where(eq(schema.warehouses.id, row.warehouseId))
      .limit(1);
    let orderNumber: string | null = null;
    const orderId = row.orderIds?.[0];
    if (orderId) {
      const [order] = await db
        .select({ orderNumber: schema.orders.orderNumber })
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      orderNumber = order?.orderNumber ?? null;
    }
    const html = renderPackingSlipHtml({
      pickListNumber: row.pickListNumber,
      orderNumber,
      warehouseName: warehouse?.name ?? null,
      packedAt: row.packedAt,
      items: row.items.map((item) => ({
        sku: item.sku,
        name: item.name,
        quantityPicked: item.quantityPicked ?? 0,
        locationCode: item.locationCode,
      })),
    });
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `inline; filename="${row.pickListNumber}-packing-slip.html"`,
      },
    });
  } catch (err) {
    console.error('[app-api/pick-lists] packing slip failed:', err);
    return error.internal(c, 'Failed to generate packing slip');
  }
});

app.patch('/:id/assign', requirePermission('picklists:update'), zValidator('json', assignPickListSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const result = await assignPickList(db, {
      id,
      assignedTo: body.assignedTo ?? null,
      assignedToName: body.assignedToName ?? null,
    });
    if (!result) return error.notFound(c, 'Pick list', id);
    publishEntityEvent({ c, entityType: 'picklist', entityId: id, action: 'updated', data: result });
    return success(c, result);
  } catch (err) {
    return mapPickError(c, err, 'Failed to assign pick list');
  }
});

app.patch('/:id/start', requirePermission('picklists:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const result = await startPickList(db, id);
    if (!result) return error.notFound(c, 'Pick list', id);
    publishEntityEvent({ c, entityType: 'picklist', entityId: id, action: 'updated', data: result });
    return success(c, result);
  } catch (err) {
    return mapPickError(c, err, 'Failed to start pick list');
  }
});

app.patch('/:id/complete', requirePermission('picklists:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const result = await completePickList(db, id, c.get('userId'));
    if (!result) return error.notFound(c, 'Pick list', id);
    publishEntityEvent({ c, entityType: 'picklist', entityId: id, action: 'completed', data: result });
    return success(c, result);
  } catch (err) {
    return mapPickError(c, err, 'Failed to complete pick list');
  }
});

app.post('/:id/pack', requirePermission('picklists:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const result = await packPickList(db, id, c.get('userId'));
    if (!result) return error.notFound(c, 'Pick list', id);
    publishEntityEvent({ c, entityType: 'picklist', entityId: id, action: 'updated', data: result });
    return success(c, result);
  } catch (err) {
    return mapPickError(c, err, 'Failed to pack pick list');
  }
});

app.post('/:id/ship', requirePermission('picklists:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  let body: { senderId?: number; shippingOptionCode?: string; weightKg?: number } = {};
  try {
    const json = await c.req.json();
    const parsed = shipPickListSchema.partial().safeParse(json);
    if (!parsed.success) {
      return error.badRequest(c, 'Invalid ship payload', parsed.error.flatten());
    }
    body = parsed.data;
  } catch {
    // empty body — inventory-only (requiresShipping=false) shipments still work
  }
  try {
    const result = await shipPickList(db, id, c.get('userId'), {
      senderId: body.senderId,
      shippingOptionCode: body.shippingOptionCode,
      weightKg: body.weightKg,
      workspaceId: c.get('workspaceId'),
      keyring: {
        v1: c.env.DATABASE_ENCRYPTION_KEY,
        v2: c.env.DATABASE_ENCRYPTION_KEY_V2,
      },
    });
    if (!result) return error.notFound(c, 'Pick list', id);
    publishEntityEvent({ c, entityType: 'picklist', entityId: id, action: 'updated', data: result });
    if (result.shipmentId) {
      publishEntityEvent({
        c,
        entityType: 'shipment',
        entityId: result.shipmentId,
        action: 'shipped',
        data: result,
      });
    }
    if (result.parcelId) {
      publishEntityEvent({
        c,
        entityType: 'parcel',
        entityId: result.parcelId,
        action: 'updated',
        data: result,
      });
    }
    return success(c, result);
  } catch (err) {
    return mapPickError(c, err, 'Failed to ship pick list');
  }
});

app.post(
  '/:id/items/:itemId/pick',
  requirePermission('picklists:update'),
  zValidator('json', pickItemSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const itemId = c.req.param('itemId');
    const body = c.req.valid('json');
    try {
      const result = await confirmPickItem(db, {
        pickListId: id,
        itemId,
        quantity: body.quantity,
        productBarcode: body.productBarcode,
        locationBarcode: body.locationBarcode,
        short: body.short,
        userId: c.get('userId'),
      });
      if (!result) return error.notFound(c, 'Pick list', id);
      publishEntityEvent({ c, entityType: 'picklist', entityId: id, action: 'updated', data: result });
      return success(c, result);
    } catch (err) {
      return mapPickError(c, err, 'Failed to confirm pick');
    }
  },
);

app.get('/:id', requirePermission('picklists:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await getPickListWithItems(db, id);
    if (!row) return error.notFound(c, 'Pick list', id);
    const orderId = row.orderIds?.[0];
    let recipient: {
      name?: string | null;
      email?: string | null;
      phone?: string | null;
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      postalCode?: string | null;
      country?: string | null;
    } | null = null;
    let requiresShipping = true;
    if (orderId) {
      const [order] = await db
        .select({
          customerName: schema.orders.customerName,
          customerEmail: schema.orders.customerEmail,
          customerPhone: schema.orders.customerPhone,
          shippingAddress: schema.orders.shippingAddress,
        })
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      requiresShipping = await orderRequiresCarrier(db, orderId);
      const shipping = order?.shippingAddress;
      recipient = {
        name: shipping?.name || order?.customerName || null,
        email: order?.customerEmail ?? null,
        phone: shipping?.phone || order?.customerPhone || null,
        line1: shipping?.line1 ?? null,
        line2: shipping?.line2 ?? null,
        city: shipping?.city ?? null,
        postalCode: shipping?.postalCode ?? null,
        country: shipping?.country ?? null,
      };
    }
    return success(c, { ...row, recipient, requiresShipping });
  } catch (err) {
    console.error('[app-api/pick-lists] get failed:', err);
    return error.internal(c, 'Failed to fetch pick list');
  }
});

app.post('/', requirePermission('picklists:create'), zValidator('json', createPickListSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, unknown>;
  const id = generateId('pl');
  const now = new Date();
  const pickListNumber = `PL-${Date.now().toString(36).toUpperCase()}`;
  try {
    await db.insert(t).values({
      id,
      pickListNumber,
      warehouseId: data.warehouseId as string,
      status: 'pending',
      assignedTo: (data.assignedTo as string | null | undefined) ?? null,
      assignedToName: (data.assignedToName as string | null | undefined) ?? null,
      orderIds: (data.orderIds as string[] | undefined) ?? null,
      pickType: (data.pickType as string | undefined) ?? 'order',
      priority: (data.priority as string | undefined) ?? 'normal',
      notes: (data.notes as string | undefined) ?? null,
      createdBy: c.get('userId'),
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({
      c,
      entityType: 'picklist',
      entityId: id,
      action: 'created',
      data: { id, warehouseId: data.warehouseId, status: 'pending' },
    });
    return success(c, { id, pickListNumber }, 201);
  } catch (err) {
    console.error('[app-api/pick-lists] create failed:', err);
    return error.internal(c, 'Failed to create pick list');
  }
});

app.patch('/:id', requirePermission('picklists:update'), zValidator('json', updatePickListSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, unknown>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Pick list', id);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.assignedTo !== undefined) update.assignedTo = data.assignedTo;
    if (data.assignedToName !== undefined) update.assignedToName = data.assignedToName;
    if (data.priority !== undefined) update.priority = data.priority;
    if (data.notes !== undefined) update.notes = data.notes;
    if (data.metadata !== undefined) update.metadata = data.metadata;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'picklist',
      entityId: id,
      action: 'updated',
      data: { id, status: existing.status },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/pick-lists] update failed:', err);
    return error.internal(c, 'Failed to update pick list');
  }
});

app.delete('/:id', requirePermission('picklists:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Pick list', id);
    if (existing.status !== 'shipped' && existing.status !== 'cancelled') {
      await cancelPickList(db, id);
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'picklist', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    return mapPickError(c, err, 'Failed to delete pick list');
  }
});

export const pickListsRoutes = app;
