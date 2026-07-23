/**
 * Enrichments routes — flat /api/enrichments/* surface for the data
 * enrichment subsystem. Read-only views over `enrich_field_results`,
 * `enrich_field_definitions`, and `enrichment_logs`.
 *
 * Triggering an enrichment is a Trigger.dev job that stays in api-worker.
 */

import { Hono } from 'hono';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /enrichments?entityType=contact&entityId=cnt_... — latest result per
 * enabled field for the entity.
 */
app.get('/', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  if (!q.entityType || !q.entityId) {
    return error.badRequest(c, 'entityType and entityId are required');
  }
  const r = schema.enrichFieldResults;
  try {
    const rows = await db
      .select()
      .from(r)
      .where(and(eq(r.entityType, q.entityType), eq(r.entityId, q.entityId)))
      .orderBy(asc(r.provider), asc(r.operation));
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/enrichments] list results failed:', err);
    return error.internal(c, 'Failed to list enrichment results');
  }
});

/**
 * GET /enrichments/definitions?entityType=contact — enabled enrichment
 * fields for the given entity type.
 */
app.get('/definitions', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  if (!q.entityType) {
    return error.badRequest(c, 'entityType is required');
  }
  const enabledOnly = q.enabled === 'true';
  const d = schema.enrichFieldDefinitions;
  const conditions: any[] = [isNull(d.deletedAt), eq(d.entityType, q.entityType)];
  if (enabledOnly) conditions.push(eq(d.enabled, true));
  try {
    const rows = await db
      .select()
      .from(d)
      .where(and(...conditions))
      .orderBy(asc(d.sortOrder), asc(d.name));
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/enrichments] list definitions failed:', err);
    return error.internal(c, 'Failed to list enrichment definitions');
  }
});

/**
 * GET /enrichments/logs — audit trail of enrichment API calls (paginated).
 */
app.get('/logs', requirePermission('contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 50, 100);
  const l = schema.enrichmentLogs;

  const conditions: any[] = [];
  if (q.entityType) conditions.push(eq(l.entityType, q.entityType));
  if (q.entityId) conditions.push(eq(l.entityId, q.entityId));
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: l.createdAt, id: l.id })
      .from(l).where(eq(l.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${l.createdAt} < ${cur.createdAt} OR (${l.createdAt} = ${cur.createdAt} AND ${l.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(l).where(where).orderBy(desc(l.createdAt), desc(l.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(l).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/enrichments] list logs failed:', err);
    return error.internal(c, 'Failed to list enrichment logs');
  }
});

export const enrichmentsRoutes = app;
