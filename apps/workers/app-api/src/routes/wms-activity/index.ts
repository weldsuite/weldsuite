/**
 * WMS Activity routes — read-only /api/wms-activity/* surface backed by
 * `activityLogs`. This is an append-only audit log; no mutations.
 *
 * Permissions: inventory:read (all endpoints).
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.activityLogs;

// ---------------------------------------------------------------------------
// GET / — list activity logs with filters + counts block
// ---------------------------------------------------------------------------
app.get('/', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 50, 100);

  const conditions: any[] = [];

  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.description, term), like(t.entityId, term))!);
  }
  if (q.activityType && q.activityType !== 'all') conditions.push(eq(t.activityType, q.activityType));
  if (q.entityType && q.entityType !== 'all') conditions.push(eq(t.entityType, q.entityType));
  if (q.entityId) conditions.push(eq(t.entityId, q.entityId));
  if (q.userId) conditions.push(eq(t.userId, q.userId));
  if (q.warehouseId && q.warehouseId !== 'all') conditions.push(eq(t.warehouseId, q.warehouseId));
  if (q.dateFrom) conditions.push(gte(t.createdAt, new Date(q.dateFrom)));
  if (q.dateTo) conditions.push(lte(t.createdAt, new Date(q.dateTo)));

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
    const [rows, countRes, countsRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
      db.select({
        total: sql<number>`count(*)::int`,
        create: sql<number>`count(*) filter (where ${t.activityType} = 'create')::int`,
        update: sql<number>`count(*) filter (where ${t.activityType} = 'update')::int`,
        delete: sql<number>`count(*) filter (where ${t.activityType} = 'delete')::int`,
        receive: sql<number>`count(*) filter (where ${t.activityType} = 'receive')::int`,
        ship: sql<number>`count(*) filter (where ${t.activityType} = 'ship')::int`,
        pick: sql<number>`count(*) filter (where ${t.activityType} = 'pick')::int`,
        pack: sql<number>`count(*) filter (where ${t.activityType} = 'pack')::int`,
        adjust: sql<number>`count(*) filter (where ${t.activityType} = 'adjust')::int`,
        transfer: sql<number>`count(*) filter (where ${t.activityType} = 'transfer')::int`,
      }).from(t),
    ]);

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    const counts = countsRes[0] ?? {
      total: 0, create: 0, update: 0, delete: 0,
      receive: 0, ship: 0, pick: 0, pack: 0, adjust: 0, transfer: 0,
    };

    return c.json({
      data,
      pagination: cursorPagination(totalCount, hasMore, nextCursor),
      counts,
    });
  } catch (err) {
    console.error('[app-api/wms-activity] list failed:', err);
    return error.internal(c, 'Failed to list activity logs');
  }
});

// ---------------------------------------------------------------------------
// GET /summary — aggregate stats for a period
// ---------------------------------------------------------------------------
app.get('/summary', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const { warehouseId, period = '7d' } = c.req.query();

  const now = new Date();
  const startDate = new Date(now);
  if (period === '1d') startDate.setDate(startDate.getDate() - 1);
  else if (period === '30d') startDate.setDate(startDate.getDate() - 30);
  else startDate.setDate(startDate.getDate() - 7); // default: 7d

  const conditions: any[] = [gte(t.createdAt, startDate)];
  if (warehouseId && warehouseId !== 'all') conditions.push(eq(t.warehouseId, warehouseId));
  const where = conditions.length ? and(...conditions) : undefined;

  try {
    const [res] = await db.select({
      totalActivities: sql<number>`count(*)::int`,
      receives: sql<number>`count(*) filter (where ${t.activityType} = 'receive')::int`,
      shipments: sql<number>`count(*) filter (where ${t.activityType} = 'ship')::int`,
      picks: sql<number>`count(*) filter (where ${t.activityType} = 'pick')::int`,
      packs: sql<number>`count(*) filter (where ${t.activityType} = 'pack')::int`,
      adjustments: sql<number>`count(*) filter (where ${t.activityType} = 'adjust')::int`,
      transfers: sql<number>`count(*) filter (where ${t.activityType} = 'transfer')::int`,
      uniqueUsers: sql<number>`count(distinct ${t.userId})::int`,
    }).from(t).where(where);

    return success(c, {
      period,
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      ...(res ?? { totalActivities: 0, receives: 0, shipments: 0, picks: 0, packs: 0, adjustments: 0, transfers: 0, uniqueUsers: 0 }),
    });
  } catch (err) {
    console.error('[app-api/wms-activity] summary failed:', err);
    return error.internal(c, 'Failed to fetch activity summary');
  }
});

// ---------------------------------------------------------------------------
// GET /entity/:entityType/:entityId — activity for a specific entity
// ---------------------------------------------------------------------------
app.get('/entity/:entityType/:entityId', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');
  const rawLimit = c.req.query('limit');
  const limit = Math.min(rawLimit ? parseInt(rawLimit, 10) : 50, 100);

  try {
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.entityType, entityType), eq(t.entityId, entityId)))
      .orderBy(desc(t.createdAt))
      .limit(limit);

    return success(c, rows);
  } catch (err) {
    console.error('[app-api/wms-activity] entity activity failed:', err);
    return error.internal(c, 'Failed to fetch entity activity');
  }
});

// ---------------------------------------------------------------------------
// GET /user/:userId — activity by a specific user
// ---------------------------------------------------------------------------
app.get('/user/:userId', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.req.param('userId');
  const rawLimit = c.req.query('limit');
  const limit = Math.min(rawLimit ? parseInt(rawLimit, 10) : 50, 100);

  try {
    const rows = await db
      .select()
      .from(t)
      .where(eq(t.userId, userId))
      .orderBy(desc(t.createdAt))
      .limit(limit);

    return success(c, rows);
  } catch (err) {
    console.error('[app-api/wms-activity] user activity failed:', err);
    return error.internal(c, 'Failed to fetch user activity');
  }
});

// ---------------------------------------------------------------------------
// GET /recent — most recent activity log entries
// ---------------------------------------------------------------------------
app.get('/recent', requirePermission('inventory:read'), async (c) => {
  const db = c.get('tenantDb');
  const rawLimit = c.req.query('limit');
  const limit = Math.min(rawLimit ? parseInt(rawLimit, 10) : 20, 50);
  const { warehouseId } = c.req.query();

  const conditions: any[] = [];
  if (warehouseId && warehouseId !== 'all') conditions.push(eq(t.warehouseId, warehouseId));
  const where = conditions.length ? and(...conditions) : undefined;

  try {
    const rows = await db
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.createdAt))
      .limit(limit);

    return success(c, rows);
  } catch (err) {
    console.error('[app-api/wms-activity] recent failed:', err);
    return error.internal(c, 'Failed to fetch recent activity');
  }
});

export const wmsActivityRoutes = app;
