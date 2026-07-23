/**
 * Inventory routes — flat /api/inventory/* surface backed by `inventory`.
 *
 * Permissions: inventory:read | inventory:create | inventory:update | inventory:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createInventorySchema, updateInventorySchema } from '@weldsuite/core-api-client/schemas/inventory';
import { adjustStockSchema } from '@weldsuite/core-api-client/schemas/weldstash';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.inventory;

app.get('/', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const { products, warehouses, warehouseLocations } = schema;

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.productId !== undefined && q.productId !== '') conditions.push(eq(t.productId, q.productId));
  if (q.warehouseId !== undefined && q.warehouseId !== '') conditions.push(eq(t.warehouseId, q.warehouseId));
  if (q.lowStockOnly === 'true') {
    conditions.push(sql`${t.quantityOnHand} <= COALESCE(${products.lowStockThreshold}, 5)`);
  }
  // Snapshot the filter set BEFORE the cursor predicate is (conditionally)
  // pushed — a stale cursor id finds no row and pushes nothing, so slicing
  // the last element off afterwards would drop a real filter (e.g.
  // lowStockOnly) from the count query instead.
  const filterConditions = [...conditions];
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
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({
          inventory: t,
          productName: products.name,
          productSku: products.sku,
          warehouseName: warehouses.name,
          locationCode: warehouseLocations.code,
        })
        .from(t)
        .leftJoin(products, eq(t.productId, products.id))
        .leftJoin(warehouses, eq(t.warehouseId, warehouses.id))
        .leftJoin(warehouseLocations, eq(t.locationId, warehouseLocations.id))
        .where(where)
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit + 1),
      db
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .leftJoin(products, eq(t.productId, products.id))
        .where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1].inventory.id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    const data = trimmed.map((row) => ({
      ...row.inventory,
      productName: row.productName,
      productSku: row.productSku,
      warehouseName: row.warehouseName,
      locationCode: row.locationCode,
    }));
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/inventory] list failed:', err);
    return error.internal(c, 'Failed to list inventorys');
  }
});

app.get('/:id', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Inventory', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/inventory] get failed:', err);
    return error.internal(c, 'Failed to fetch inventory');
  }
});

app.post('/', requirePermission('inventory:create'), zValidator('json', createInventorySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('inv');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'inventory',
      entityId: id,
      action: 'created',
      data: { id, productId: data.productId ?? '', locationId: data.locationId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/inventory] create failed:', err);
    return error.internal(c, 'Failed to create inventory');
  }
});

/**
 * Adjust stock by a delta — ported from core-api POST /weldstash/inventory/adjust.
 * Upserts the matching inventory row and records an `inventoryMovements` entry.
 */
app.post('/adjust', requirePermission('inventory:update'), zValidator('json', adjustStockSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const { products, inventoryMovements } = schema;
  const now = new Date();

  try {
    const [product] = await db
      .select({ id: products.id, name: products.name, sku: products.sku })
      .from(products)
      .where(and(eq(products.id, data.productId), isNull(products.deletedAt)))
      .limit(1);
    if (!product) return error.badRequest(c, 'Product not found');

    const locationCondition = data.locationId
      ? eq(t.locationId, data.locationId)
      : isNull(t.locationId);

    const [existing] = await db
      .select()
      .from(t)
      .where(and(
        eq(t.productId, data.productId),
        eq(t.warehouseId, data.warehouseId),
        locationCondition,
        data.lotNumber ? eq(t.lotNumber, data.lotNumber) : sql`TRUE`,
        isNull(t.deletedAt),
      ))
      .limit(1);

    let inventoryId: string;
    let newOnHand: number;

    if (existing) {
      inventoryId = existing.id;
      newOnHand = (existing.quantityOnHand ?? 0) + data.delta;
      const allocated = existing.quantityAllocated ?? 0;
      await db
        .update(t)
        .set({
          quantityOnHand: newOnHand,
          quantityAvailable: newOnHand - allocated,
          unitCost: data.unitCost !== undefined ? String(data.unitCost) : existing.unitCost,
          updatedAt: now,
        })
        .where(eq(t.id, existing.id));
    } else {
      inventoryId = generateId('inv');
      newOnHand = data.delta;
      await db.insert(t).values({
        id: inventoryId,
        productId: data.productId,
        warehouseId: data.warehouseId,
        locationId: data.locationId,
        lotNumber: data.lotNumber,
        quantityOnHand: newOnHand,
        quantityAllocated: 0,
        quantityAvailable: newOnHand,
        quantityIncoming: 0,
        quantityOutgoing: 0,
        unitCost: data.unitCost !== undefined ? String(data.unitCost) : undefined,
        status: 'available',
        receivedDate: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    const movementId = generateId('mov');
    const movementNumber = `ADJ-${Date.now().toString(36).toUpperCase()}`;
    await db.insert(inventoryMovements).values({
      id: movementId,
      movementNumber,
      movementType: 'adjustment',
      status: 'completed',
      destWarehouseId: data.warehouseId,
      destLocationId: data.locationId,
      productId: data.productId,
      sku: product.sku,
      name: product.name,
      quantity: data.delta,
      lotNumber: data.lotNumber,
      reason: data.reason,
      createdBy: userId,
      completedBy: userId,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    publishEntityEvent({
      c,
      entityType: 'inventory',
      entityId: inventoryId,
      action: 'updated',
      data: {
        id: inventoryId,
        productId: data.productId,
        productName: product.name,
        locationId: data.locationId,
        quantity: newOnHand,
        adjustmentType: 'adjustment',
      },
    });
    return success(c, { inventoryId, movementId, quantityOnHand: newOnHand });
  } catch (err) {
    console.error('[app-api/inventory] adjust failed:', err);
    return error.internal(c, 'Failed to adjust stock');
  }
});

app.patch('/:id', requirePermission('inventory:update'), zValidator('json', updateInventorySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Inventory', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'inventory',
      entityId: id,
      action: 'updated',
      data: { id, productId: existing.productId, locationId: (update.locationId as string | null | undefined) ?? existing.locationId },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/inventory] update failed:', err);
    return error.internal(c, 'Failed to update inventory');
  }
});

app.delete('/:id', requirePermission('inventory:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Inventory', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'inventory',
      entityId: id,
      action: 'deleted',
      data: { id, productId: existing.productId },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/inventory] delete failed:', err);
    return error.internal(c, 'Failed to delete inventory');
  }
});

export const inventoryRoutes = app;
