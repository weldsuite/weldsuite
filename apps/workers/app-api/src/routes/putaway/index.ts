/**
 * Putaway routes — flat /api/putaway/* surface backed by `inventory_movements`
 * rows with `movementType = 'putaway'`.
 *
 * Ported from api-worker `src/routes/wms/putaway.ts` (W3 legacy-worker
 * phase-out) with fixes — the legacy file referenced columns/tables that do
 * not exist in @weldsuite/db (`inventoryMovements.deletedAt`,
 * `schema.locations`, `stockAdjustments.adjustmentType/quantity/createdBy`),
 * so several legacy endpoints could never have executed successfully:
 *   - joins use `warehouseLocations` (the real table behind location codes)
 *   - cancellation is status-based (`status = 'cancelled'`) — there is no
 *     deletedAt column on inventory_movements
 *   - the completion audit trail writes the real stock_adjustments columns
 *     (type/previousQuantity/adjustmentQuantity/newQuantity/performedBy)
 *
 * List pagination follows the app-api cursor convention instead of the
 * legacy page/pageSize convention; the status `counts` block is kept as an
 * extra top-level field alongside { data, pagination }.
 *
 * Permissions: inventory:read | inventory:create | inventory:update | inventory:delete
 * (same prefixes as the legacy route).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, like, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

// ============================================================================
// Schemas (Zod v3)
// ============================================================================

const createPutawaySchema = z.object({
  warehouseId: z.string().min(1),
  productId: z.string().min(1),
  quantity: z.number().int().min(1),
  sourceLocationId: z.string().optional(),
  targetLocationId: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  assignedTo: z.string().optional(),
  assignedToName: z.string().optional(),
  notes: z.string().optional(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
});

const completePutawaySchema = z.object({
  locationId: z.string().min(1),
  quantity: z.number().int().min(0).optional(),
});

const assignPutawaySchema = z.object({
  assignedTo: z.string().nullable().optional(),
  assignedToName: z.string().nullable().optional(),
});

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.inventoryMovements;

const putawaySelection = (products: typeof schema.products, locations: typeof schema.warehouseLocations) => ({
  id: t.id,
  movementNumber: t.movementNumber,
  productId: t.productId,
  productName: products.name,
  productSku: products.sku,
  quantity: t.quantity,
  sourceLocationId: t.sourceLocationId,
  destLocationId: t.destLocationId,
  destLocationCode: locations.code,
  status: t.status,
  priority: t.priority,
  assignedTo: t.assignedTo,
  assignedToName: t.assignedToName,
  notes: t.notes,
  createdAt: t.createdAt,
  completedAt: t.completedAt,
});

/**
 * GET / — List putaway tasks (cursor pagination + status counts).
 */
app.get('/', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const { products, warehouseLocations } = schema;

  const conditions: any[] = [eq(t.movementType, 'putaway')];

  if (q.search) {
    const searchTerm = `%${q.search}%`;
    conditions.push(or(like(t.movementNumber, searchTerm), like(t.notes, searchTerm))!);
  }
  if (q.status && q.status !== 'all') {
    conditions.push(eq(t.status, q.status));
  } else if (!q.status) {
    // No deletedAt column exists on inventory_movements — cancelled rows ARE
    // the soft-deleted rows, so hide them from the default listing (the
    // legacy deletedAt filter had the same intent).
    conditions.push(ne(t.status, 'cancelled'));
  }
  if (q.warehouseId && q.warehouseId !== 'all') conditions.push(eq(t.destWarehouseId, q.warehouseId));
  if (q.assignedTo) conditions.push(eq(t.assignedTo, q.assignedTo));
  if (q.priority && q.priority !== 'all') conditions.push(eq(t.priority, q.priority));

  // Snapshot the filter set BEFORE the cursor predicate is (conditionally)
  // pushed — a stale cursor id finds no row and pushes nothing, so slicing
  // the last element off afterwards would drop a real filter instead.
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
  const where = and(...conditions);
  const countWhere = and(...filterConditions);

  try {
    const [rows, countRes, countsRes] = await Promise.all([
      db
        .select(putawaySelection(products, warehouseLocations))
        .from(t)
        .leftJoin(products, eq(t.productId, products.id))
        .leftJoin(warehouseLocations, eq(t.destLocationId, warehouseLocations.id))
        .where(where)
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
      db
        .select({
          total: sql<number>`count(*)::int`,
          pending: sql<number>`count(*) filter (where ${t.status} = 'pending')::int`,
          in_progress: sql<number>`count(*) filter (where ${t.status} = 'in_progress')::int`,
          completed: sql<number>`count(*) filter (where ${t.status} = 'completed')::int`,
          cancelled: sql<number>`count(*) filter (where ${t.status} = 'cancelled')::int`,
        })
        .from(t)
        .where(eq(t.movementType, 'putaway')),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    const counts = countsRes[0] || { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 };

    return c.json({
      data,
      pagination: cursorPagination(totalCount, hasMore, nextCursor),
      counts,
    });
  } catch (err) {
    console.error('[app-api/putaway] Failed to list putaway tasks:', err);
    return error.internal(c, 'Failed to fetch putaway tasks');
  }
});

/**
 * GET /:id — Get single putaway task.
 */
app.get('/:id', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const putawayId = c.req.param('id');
  const { products, warehouseLocations } = schema;

  try {
    const result = await db
      .select({
        ...putawaySelection(products, warehouseLocations),
        sourceType: t.sourceType,
        sourceId: t.sourceId,
        startedAt: t.startedAt,
      })
      .from(t)
      .leftJoin(products, eq(t.productId, products.id))
      .leftJoin(warehouseLocations, eq(t.destLocationId, warehouseLocations.id))
      .where(and(eq(t.id, putawayId), eq(t.movementType, 'putaway')))
      .limit(1);

    if (result.length === 0) {
      return error.notFound(c, 'Putaway Task', putawayId);
    }

    return success(c, result[0]);
  } catch (err) {
    console.error('[app-api/putaway] Failed to fetch putaway task:', err);
    return error.internal(c, 'Failed to fetch putaway task');
  }
});

/**
 * POST / — Create new putaway task.
 */
app.post('/', requirePermission('inventory:create'), zValidator('json', createPutawaySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');

  const id = generateId('put');
  const movementNumber = `PUT-${Date.now().toString(36).toUpperCase()}`;
  const now = new Date();

  try {
    await db.insert(t).values({
      id,
      movementNumber,
      movementType: 'putaway',
      productId: data.productId,
      quantity: data.quantity,
      sourceLocationId: data.sourceLocationId,
      destWarehouseId: data.warehouseId,
      destLocationId: data.targetLocationId,
      status: 'pending',
      priority: data.priority,
      assignedTo: data.assignedTo,
      assignedToName: data.assignedToName,
      notes: data.notes,
      sourceType: data.sourceType,
      sourceId: data.sourceId,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    publishEntityEvent({
      c,
      entityType: 'putaway',
      entityId: id,
      action: 'created',
      data: { id, movementNumber, ...data },
    });

    return success(c, { id, movementNumber }, 201);
  } catch (err) {
    console.error('[app-api/putaway] Failed to create putaway task:', err);
    return error.internal(c, 'Failed to create putaway task');
  }
});

/**
 * PATCH /:id/start — Start putaway task.
 */
app.patch('/:id/start', requirePermission('inventory:update'), async (c) => {
  const db = c.get('tenantDb');
  const putawayId = c.req.param('id');

  try {
    const updated = await db
      .update(t)
      .set({
        status: 'in_progress',
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(t.id, putawayId), eq(t.movementType, 'putaway'), ne(t.status, 'cancelled')))
      .returning({ id: t.id });

    if (updated.length === 0) {
      return error.notFound(c, 'Putaway Task', putawayId);
    }

    publishEntityEvent({
      c,
      entityType: 'putaway',
      entityId: putawayId,
      action: 'updated',
      data: { id: putawayId, status: 'in_progress' },
    });

    return success(c, { id: putawayId, status: 'in_progress' });
  } catch (err) {
    console.error('[app-api/putaway] Failed to start putaway task:', err);
    return error.internal(c, 'Failed to start putaway task');
  }
});

/**
 * PATCH /:id/complete — Complete putaway task: stock lands at the chosen
 * location, an audit stock adjustment is written, the task closes.
 */
app.patch('/:id/complete', requirePermission('inventory:update'), zValidator('json', completePutawaySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const putawayId = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const { inventory, stockAdjustments } = schema;

    // Get putaway task
    const task = await db
      .select()
      .from(t)
      .where(and(eq(t.id, putawayId), eq(t.movementType, 'putaway'), ne(t.status, 'cancelled')))
      .limit(1);

    if (task.length === 0) {
      return error.notFound(c, 'Putaway Task', putawayId);
    }

    const putawayTask = task[0];
    if (!putawayTask.destWarehouseId) {
      return error.badRequest(c, 'Putaway task has no destination warehouse');
    }
    const now = new Date();
    const quantity = data.quantity ?? putawayTask.quantity ?? 0;

    // Update inventory at target location
    const existingInv = await db
      .select()
      .from(inventory)
      .where(
        and(
          eq(inventory.warehouseId, putawayTask.destWarehouseId),
          eq(inventory.productId, putawayTask.productId),
          eq(inventory.locationId, data.locationId),
          sql`${inventory.deletedAt} IS NULL`,
        ),
      )
      .limit(1);

    let previousQuantity = 0;
    let newQuantity = quantity;

    if (existingInv.length > 0) {
      previousQuantity = existingInv[0].quantityOnHand || 0;
      newQuantity = previousQuantity + quantity;
      await db
        .update(inventory)
        .set({
          quantityOnHand: newQuantity,
          quantityAvailable: newQuantity - (existingInv[0].quantityAllocated || 0),
          updatedAt: now,
        })
        .where(eq(inventory.id, existingInv[0].id));
    } else {
      const invId = generateId('inv');
      await db.insert(inventory).values({
        id: invId,
        warehouseId: putawayTask.destWarehouseId,
        locationId: data.locationId,
        productId: putawayTask.productId,
        quantityOnHand: quantity,
        quantityAllocated: 0,
        quantityAvailable: quantity,
        quantityIncoming: 0,
        quantityOutgoing: 0,
        status: 'available',
        isQuarantined: false,
        qualityStatus: 'passed',
        currency: 'USD',
        receivedDate: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Create stock adjustment (audit trail)
    const adjId = generateId('adj');
    await db.insert(stockAdjustments).values({
      id: adjId,
      productId: putawayTask.productId,
      warehouseId: putawayTask.destWarehouseId,
      locationId: data.locationId,
      type: 'increase',
      previousQuantity,
      adjustmentQuantity: quantity,
      newQuantity,
      reason: `Putaway ${putawayTask.movementNumber}`,
      sourceType: 'putaway',
      sourceId: putawayId,
      performedBy: userId,
      createdAt: now,
    });

    // Update putaway task
    await db
      .update(t)
      .set({
        destLocationId: data.locationId,
        status: 'completed',
        completedAt: now,
        completedBy: userId,
        updatedAt: now,
      })
      .where(eq(t.id, putawayId));

    publishEntityEvent({
      c,
      entityType: 'putaway',
      entityId: putawayId,
      action: 'completed',
      data: { id: putawayId, status: 'completed', locationId: data.locationId },
    });

    return success(c, { id: putawayId, status: 'completed', locationId: data.locationId });
  } catch (err) {
    console.error('[app-api/putaway] Failed to complete putaway task:', err);
    return error.internal(c, 'Failed to complete putaway task');
  }
});

/**
 * PATCH /:id/assign — Assign putaway task.
 */
app.patch('/:id/assign', requirePermission('inventory:update'), zValidator('json', assignPutawaySchema), async (c) => {
  const db = c.get('tenantDb');
  const putawayId = c.req.param('id');
  const { assignedTo, assignedToName } = c.req.valid('json');

  try {
    const updated = await db
      .update(t)
      .set({
        assignedTo,
        assignedToName,
        updatedAt: new Date(),
      })
      .where(and(eq(t.id, putawayId), eq(t.movementType, 'putaway'), ne(t.status, 'cancelled')))
      .returning({ id: t.id });

    if (updated.length === 0) {
      return error.notFound(c, 'Putaway Task', putawayId);
    }

    publishEntityEvent({
      c,
      entityType: 'putaway',
      entityId: putawayId,
      action: 'updated',
      data: { id: putawayId, assignedTo: assignedTo ?? undefined, assignedToName: assignedToName ?? undefined },
    });

    return success(c, { id: putawayId, assignedTo });
  } catch (err) {
    console.error('[app-api/putaway] Failed to assign putaway task:', err);
    return error.internal(c, 'Failed to assign putaway task');
  }
});

/**
 * DELETE /:id — Cancel putaway task. Status-based (no deletedAt column on
 * inventory_movements); returns 204 per app-api convention.
 */
app.delete('/:id', requirePermission('inventory:delete'), async (c) => {
  const db = c.get('tenantDb');
  const putawayId = c.req.param('id');

  try {
    const updated = await db
      .update(t)
      .set({
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(and(eq(t.id, putawayId), eq(t.movementType, 'putaway')))
      .returning({ id: t.id });

    if (updated.length === 0) {
      return error.notFound(c, 'Putaway Task', putawayId);
    }

    publishEntityEvent({
      c,
      entityType: 'putaway',
      entityId: putawayId,
      action: 'deleted',
      data: { id: putawayId },
    });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/putaway] Failed to cancel putaway task:', err);
    return error.internal(c, 'Failed to cancel putaway task');
  }
});

export const putawayRoutes = app;
