/**
 * Inventory routes — flat /api/inventory/* surface backed by `inventory`.
 *
 * `inventory` rows (per warehouse / location / lot) are the source of truth for
 * stock. Quantity changes go through the ledger service rather than being
 * written here, so the audit trail and the `products.inventory_quantity`
 * roll-up stay consistent — see services/inventory-ledger.ts.
 *
 * Permissions: inventory:read | inventory:create | inventory:update | inventory:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  adjustInventorySchema,
  createInventoryBucketSchema,
  inventoryLedgerQuerySchema,
  transferInventorySchema,
  updateInventoryBucketSchema,
} from '@weldsuite/app-api-client/schemas/inventory-ledger';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../db';
import { applyStockChange, StockLedgerError, transferStock } from '../../services/inventory-ledger';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.inventory;

/**
 * Ledger errors name a condition the caller can fix (unknown product,
 * insufficient stock, missing lot). Anything else is ours, and stays a 500.
 */
function ledgerError(c: Parameters<typeof error.badRequest>[0], err: unknown, fallback: string) {
  if (err instanceof StockLedgerError) {
    if (err.code === 'PRODUCT_NOT_FOUND') return error.notFound(c, 'Product');
    if (err.code === 'INSUFFICIENT_STOCK') return error.conflict(c, err.message, { code: err.code });
    return error.badRequest(c, err.message, { code: err.code });
  }
  console.error(`[app-api/inventory] ${fallback}:`, err);
  return error.internal(c, fallback);
}

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

/**
 * Stock ledger — the movement history behind current quantities, read from
 * `stock_adjustments` and enriched with product / warehouse / location names.
 *
 * `/api/stock-adjustments` remains the raw table surface (and the only way to
 * write a standalone audit row); this endpoint is the reporting view, filtered
 * by bucket and date range.
 */
app.get('/ledger', requirePermission('inventory:read'), zValidator('query', inventoryLedgerQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const limit = q.limit ?? 25;
  const { stockAdjustments, products, warehouses, warehouseLocations } = schema;

  const conditions: any[] = [];
  if (q.productId) conditions.push(eq(stockAdjustments.productId, q.productId));
  if (q.variantId) conditions.push(eq(stockAdjustments.variantId, q.variantId));
  if (q.warehouseId) conditions.push(eq(stockAdjustments.warehouseId, q.warehouseId));
  if (q.locationId) conditions.push(eq(stockAdjustments.locationId, q.locationId));
  if (q.lotNumber) conditions.push(eq(stockAdjustments.lotNumber, q.lotNumber));
  if (q.type) conditions.push(eq(stockAdjustments.type, q.type));
  if (q.sourceType) conditions.push(eq(stockAdjustments.sourceType, q.sourceType));
  if (q.from) conditions.push(gte(stockAdjustments.createdAt, q.from));
  if (q.to) conditions.push(lte(stockAdjustments.createdAt, q.to));

  // Snapshot the filters before the cursor predicate joins them — a stale
  // cursor matches no row and pushes nothing, so trimming the last element
  // afterwards would drop a real filter from the count instead.
  const filterConditions = [...conditions];
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: stockAdjustments.createdAt, id: stockAdjustments.id })
      .from(stockAdjustments)
      .where(eq(stockAdjustments.id, q.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${stockAdjustments.createdAt} < ${cur.createdAt} OR (${stockAdjustments.createdAt} = ${cur.createdAt} AND ${stockAdjustments.id} < ${cur.id}))`,
      );
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({
          entry: stockAdjustments,
          productName: products.name,
          productSku: products.sku,
          warehouseName: warehouses.name,
          locationCode: warehouseLocations.code,
        })
        .from(stockAdjustments)
        .leftJoin(products, eq(stockAdjustments.productId, products.id))
        .leftJoin(warehouses, eq(stockAdjustments.warehouseId, warehouses.id))
        .leftJoin(warehouseLocations, eq(stockAdjustments.locationId, warehouseLocations.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(stockAdjustments.createdAt), desc(stockAdjustments.id))
        .limit(limit + 1),
      db
        .select({ count: sql<number>`count(*)` })
        .from(stockAdjustments)
        .where(filterConditions.length ? and(...filterConditions) : undefined),
    ]);

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1].entry.id : null;
    const data = trimmed.map((row) => ({
      ...row.entry,
      productName: row.productName,
      productSku: row.productSku,
      warehouseName: row.warehouseName,
      locationCode: row.locationCode,
    }));
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/inventory] ledger failed:', err);
    return error.internal(c, 'Failed to list stock ledger');
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

/**
 * Create an empty stock bucket. Quantities start at zero and are filled by
 * `POST /adjust` — creating a bucket pre-loaded with stock would put units on
 * the shelf with no audit row explaining where they came from.
 */
app.post('/', requirePermission('inventory:create'), zValidator('json', createInventoryBucketSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const id = generateId('inv');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      productId: data.productId,
      variantId: data.variantId ?? null,
      warehouseId: data.warehouseId,
      locationId: data.locationId ?? null,
      lotNumber: data.lotNumber ?? null,
      batchNumber: data.batchNumber ?? null,
      serialNumber: data.serialNumber ?? null,
      expiryDate: data.expiryDate ?? null,
      manufactureDate: data.manufactureDate ?? null,
      unitCost: data.unitCost !== null && data.unitCost !== undefined ? String(data.unitCost) : null,
      currency: data.currency,
      status: data.status ?? 'available',
      qualityStatus: data.qualityStatus,
      metadata: data.metadata,
      quantityOnHand: 0,
      quantityAllocated: 0,
      quantityAvailable: 0,
      quantityIncoming: 0,
      quantityOutgoing: 0,
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({
      c,
      entityType: 'inventory',
      entityId: id,
      action: 'created',
      data: { id, productId: data.productId, locationId: data.locationId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/inventory] create failed:', err);
    return error.internal(c, 'Failed to create inventory');
  }
});

/**
 * Adjust stock by a signed delta.
 *
 * Delegates to the ledger, so the increment is atomic, the change is audited in
 * `stock_adjustments`, and `products.inventory_quantity` is recomputed. An
 * issue that would oversell a product without `allowBackorder` is rejected with
 * 409 rather than driving stock negative.
 */
app.post('/adjust', requirePermission('inventory:update'), zValidator('json', adjustInventorySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');

  try {
    const result = await applyStockChange(db, {
      productId: data.productId,
      variantId: data.variantId,
      warehouseId: data.warehouseId,
      locationId: data.locationId,
      lotNumber: data.lotNumber,
      batchNumber: data.batchNumber,
      expiryDate: data.expiryDate,
      delta: data.delta,
      type: data.type ?? (data.delta > 0 ? 'increase' : 'decrease'),
      reason: data.reason,
      reasonCode: data.reasonCode,
      notes: data.notes,
      unitCost: data.unitCost,
      sourceType: data.sourceType ?? 'manual',
      sourceId: data.sourceId,
      sourceNumber: data.sourceNumber,
      performedBy: userId,
    });

    publishEntityEvent({
      c,
      entityType: 'inventory',
      entityId: result.inventoryId,
      action: 'updated',
      data: {
        id: result.inventoryId,
        productId: data.productId,
        locationId: data.locationId,
        quantity: result.newQuantity,
        previousQuantity: result.previousQuantity,
        adjustmentType: data.type ?? (data.delta > 0 ? 'increase' : 'decrease'),
      },
    });

    return success(c, {
      inventoryId: result.inventoryId,
      adjustmentId: result.adjustmentId,
      previousQuantity: result.previousQuantity,
      quantityOnHand: result.newQuantity,
      productQuantity: result.productQuantity,
    });
  } catch (err) {
    return ledgerError(c, err, 'Failed to adjust stock');
  }
});

/**
 * Move stock between two buckets (warehouse / location / lot).
 *
 * Writes both legs through the ledger and records one `inventory_movements`
 * row tying them together.
 */
app.post('/transfer', requirePermission('inventory:update'), zValidator('json', transferInventorySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');

  try {
    const result = await transferStock(db, {
      productId: data.productId,
      variantId: data.variantId,
      quantity: data.quantity,
      from: data.from,
      to: data.to,
      reason: data.reason,
      notes: data.notes,
      performedBy: userId,
    });

    publishEntityEvent({
      c,
      entityType: 'wms_inventory_movement',
      entityId: result.movementId,
      action: 'created',
      data: {
        id: result.movementId,
        movementNumber: result.movementNumber,
        movementType: 'transfer',
        productId: data.productId,
        quantity: data.quantity,
        sourceWarehouseId: data.from.warehouseId,
        destWarehouseId: data.to.warehouseId,
      },
    });

    return success(c, {
      movementId: result.movementId,
      movementNumber: result.movementNumber,
      from: { inventoryId: result.out.inventoryId, quantityOnHand: result.out.newQuantity },
      to: { inventoryId: result.in.inventoryId, quantityOnHand: result.in.newQuantity },
    }, 201);
  } catch (err) {
    return ledgerError(c, err, 'Failed to transfer stock');
  }
});

/**
 * Patch a bucket's attributes — lot metadata, quality status, quarantine.
 *
 * Quantities are not patchable here: `updateInventoryBucketSchema` has no
 * quantity fields, so the only way to move stock is through `/adjust` and
 * `/transfer`, which audit it.
 */
app.patch('/:id', requirePermission('inventory:update'), zValidator('json', updateInventoryBucketSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Inventory', id);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      // `unitCost` is numeric in Postgres and round-trips as a string.
      update[k] = k === 'unitCost' && typeof v === 'number' ? String(v) : v;
    }
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
