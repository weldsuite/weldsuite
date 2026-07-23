/**
 * Return reason routes — flat /api/return-reasons/* surface backed by `returnReasons`.
 *
 * Permissions: returns:read | returns:create | returns:update | returns:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createReturnReasonSchema, updateReturnReasonSchema } from '@weldsuite/core-api-client/schemas/return-reasons';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.returnReasons;

app.get('/', requirePermission('returns:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.groupId !== undefined && q.groupId !== '') conditions.push(eq(t.groupId, q.groupId));
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
    console.error('[app-api/return-reasons] list failed:', err);
    return error.internal(c, 'Failed to list return reasons');
  }
});

app.get('/:id', requirePermission('returns:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Return reason', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/return-reasons] get failed:', err);
    return error.internal(c, 'Failed to fetch return reason');
  }
});

app.post('/', requirePermission('returns:create'), zValidator('json', createReturnReasonSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('rsn');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'return_reason',
      entityId: id,
      action: 'created',
      data: { id, label: data.label, code: data.code, groupId: data.groupId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/return-reasons] create failed:', err);
    return error.internal(c, 'Failed to create return reason');
  }
});

app.patch('/:id', requirePermission('returns:update'), zValidator('json', updateReturnReasonSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Return reason', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'return_reason',
      entityId: id,
      action: 'updated',
      data: { id, label: (data.label as string | undefined) ?? existing.label, code: existing.code, groupId: data.groupId ?? existing.groupId },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/return-reasons] update failed:', err);
    return error.internal(c, 'Failed to update return reason');
  }
});

app.delete('/:id', requirePermission('returns:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Return reason', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'return_reason',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/return-reasons] delete failed:', err);
    return error.internal(c, 'Failed to delete return reason');
  }
});

export const returnReasonsRoutes = app;
