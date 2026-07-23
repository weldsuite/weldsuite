/**
 * FX rate routes — flat /api/fx-rates/* surface backed by `fxRates`.
 *
 * Permissions: reports:read | reports:create | reports:update | reports:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createFxRateSchema, updateFxRateSchema } from '@weldsuite/core-api-client/schemas/fx-rates';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.fxRates;

app.get('/', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [];
  if (q.fromCurrency !== undefined && q.fromCurrency !== '') conditions.push(eq(t.fromCurrency, q.fromCurrency));
  if (q.toCurrency !== undefined && q.toCurrency !== '') conditions.push(eq(t.toCurrency, q.toCurrency));
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
    console.error('[app-api/fx-rates] list failed:', err);
    return error.internal(c, 'Failed to list fx rates');
  }
});

app.get('/:id', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'FX rate', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/fx-rates] get failed:', err);
    return error.internal(c, 'Failed to fetch fx rate');
  }
});

app.post('/', requirePermission('reports:create'), zValidator('json', createFxRateSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('fx');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({ c, entityType: 'fx_rate', entityId: id, action: 'created', data: { id, fromCurrency: data.fromCurrency, toCurrency: data.toCurrency, rate: data.rate } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/fx-rates] create failed:', err);
    return error.internal(c, 'Failed to create fx rate');
  }
});

app.patch('/:id', requirePermission('reports:update'), zValidator('json', updateFxRateSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'FX rate', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'fx_rate', entityId: id, action: 'updated', data: { id, fromCurrency: (update.fromCurrency as string | undefined) ?? existing.fromCurrency, toCurrency: (update.toCurrency as string | undefined) ?? existing.toCurrency, rate: (update.rate as string | undefined) ?? existing.rate } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/fx-rates] update failed:', err);
    return error.internal(c, 'Failed to update fx rate');
  }
});

app.delete('/:id', requirePermission('reports:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'FX rate', id);
    await db.delete(t).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'fx_rate', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/fx-rates] delete failed:', err);
    return error.internal(c, 'Failed to delete fx rate');
  }
});

export const fxRatesRoutes = app;
