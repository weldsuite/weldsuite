/**
 * Warehouse location routes — flat /api/warehouse-locations/* surface backed by
 * `warehouseLocations`. Locations are physical bin/shelf positions within a
 * warehouse zone and share the `locations:*` permission prefix.
 *
 * Permissions: locations:read | locations:create | locations:update | locations:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull, like, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createWarehouseLocationSchema,
  updateWarehouseLocationSchema,
} from '@weldsuite/app-api-client/schemas/warehouse-locations';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.warehouseLocations;

/** Push `column = value` when the query param is present and non-empty. */
function pushEqFilter(conditions: SQL[], column: AnyColumn, value: string | undefined): void {
  if (value) conditions.push(eq(column, value));
}

/** Push `column = (param === 'true')` when the boolean query param is present. */
function pushBooleanFilter(conditions: SQL[], column: AnyColumn, value: string | undefined): void {
  if (value !== undefined) conditions.push(eq(column, value === 'true'));
}

/** List filters from the query string (always excludes soft-deleted rows). */
function buildFilterConditions(q: Record<string, string>): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.code, term), like(t.barcode, term))!);
  }
  pushEqFilter(conditions, t.warehouseId, q.warehouseId);
  pushEqFilter(conditions, t.zoneId, q.zoneId);
  pushEqFilter(conditions, t.locationType, q.locationType);
  pushBooleanFilter(conditions, t.isActive, q.isActive);
  pushBooleanFilter(conditions, t.isEmpty, q.isEmpty);
  pushBooleanFilter(conditions, t.isBlocked, q.isBlocked);
  pushEqFilter(conditions, t.abcClass, q.abcClass);
  pushEqFilter(conditions, t.barcode, q.barcode);
  return conditions;
}

/** Keyset condition for "rows after this cursor row"; null when the cursor row is gone. */
async function buildCursorCondition(db: Database, cursor: string): Promise<SQL | null> {
  const [cur] = await db
    .select({ pickingSequence: t.pickingSequence, id: t.id })
    .from(t).where(eq(t.id, cursor)).limit(1);
  if (!cur) return null;
  return sql`(${t.pickingSequence} > ${cur.pickingSequence} OR (${t.pickingSequence} = ${cur.pickingSequence} AND ${t.id} > ${cur.id}))`;
}

app.get('/', requirePermission('locations:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions = buildFilterConditions(q);
  const cursorCondition = q.cursor ? await buildCursorCondition(db, q.cursor) : null;
  if (cursorCondition) conditions.push(cursorCondition);
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(asc(t.pickingSequence), asc(t.code)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data.at(-1)!.id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/warehouse-locations] list failed:', err);
    return error.internal(c, 'Failed to list warehouse locations');
  }
});

app.get('/:id', requirePermission('locations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Warehouse location', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/warehouse-locations] get failed:', err);
    return error.internal(c, 'Failed to fetch warehouse location');
  }
});

app.post('/', requirePermission('locations:create'), zValidator('json', createWarehouseLocationSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('loc');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      warehouseId: data.warehouseId as string,
      zoneId: data.zoneId as string | undefined,
      name: data.name as string,
      code: data.code as string,
      barcode: data.barcode as string | undefined,
      aisle: data.aisle as string | undefined,
      rack: data.rack as string | undefined,
      shelf: data.shelf as string | undefined,
      bin: data.bin as string | undefined,
      level: data.level as number | undefined,
      locationType: (data.locationType as string | undefined) ?? 'storage',
      length: data.length !== undefined ? String(data.length) : undefined,
      width: data.width !== undefined ? String(data.width) : undefined,
      height: data.height !== undefined ? String(data.height) : undefined,
      dimensionUnit: (data.dimensionUnit as string | undefined) ?? 'cm',
      maxWeight: data.maxWeight !== undefined ? String(data.maxWeight) : undefined,
      weightUnit: (data.weightUnit as string | undefined) ?? 'kg',
      maxItems: data.maxItems as number | undefined,
      currentItems: 0,
      isActive: (data.isActive as boolean | undefined) ?? true,
      isEmpty: true,
      isBlocked: false,
      pickingSequence: (data.pickingSequence as number | undefined) ?? 0,
      isPrimaryPick: (data.isPrimaryPick as boolean | undefined) ?? false,
      abcClass: data.abcClass as string | undefined,
      metadata: data.metadata as Record<string, unknown> | undefined,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'wms_location',
      entityId: id,
      action: 'created',
      data: { id, name: data.name as string, code: data.code as string, warehouseId: data.warehouseId as string },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/warehouse-locations] create failed:', err);
    return error.internal(c, 'Failed to create warehouse location');
  }
});

app.patch('/:id', requirePermission('locations:update'), zValidator('json', updateWarehouseLocationSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Warehouse location', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    const simpleFields = [
      'zoneId', 'name', 'code', 'barcode', 'aisle', 'rack', 'shelf', 'bin',
      'level', 'locationType', 'dimensionUnit', 'weightUnit', 'maxItems',
      'isActive', 'pickingSequence', 'isPrimaryPick', 'abcClass', 'metadata',
    ];
    for (const key of simpleFields) {
      if (data[key] !== undefined) update[key] = data[key];
    }
    if (data.length !== undefined) update.length = String(data.length);
    if (data.width !== undefined) update.width = String(data.width);
    if (data.height !== undefined) update.height = String(data.height);
    if (data.maxWeight !== undefined) update.maxWeight = String(data.maxWeight);
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'wms_location',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name,
        code: (update.code as string | undefined) ?? existing.code,
        warehouseId: existing.warehouseId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/warehouse-locations] update failed:', err);
    return error.internal(c, 'Failed to update warehouse location');
  }
});

app.delete('/:id', requirePermission('locations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Warehouse location', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'wms_location',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/warehouse-locations] delete failed:', err);
    return error.internal(c, 'Failed to delete warehouse location');
  }
});

export const warehouseLocationsRoutes = app;
