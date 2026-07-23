/**
 * Pipelines routes — flat /api/pipelines/* surface backed by `crm_pipelines`.
 *
 * Permissions: pipelines:read | pipelines:create | pipelines:update | pipelines:delete | pipelines:manage.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createPipelineSchema,
  updatePipelineSchema,
} from '@weldsuite/core-api-client/schemas/pipelines-crm';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmPipelines;

app.get('/', requirePermission('pipelines:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 50, 100);
  const archived = (q.archived as 'active' | 'archived' | 'all' | undefined) ?? 'active';

  const conditions: any[] = [isNull(t.deletedAt)];
  if (archived === 'active') conditions.push(eq(t.isArchived, false));
  if (archived === 'archived') conditions.push(eq(t.isArchived, true));
  if (q.search) conditions.push(like(t.name, `%${q.search}%`));
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
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/pipelines] list failed:', err);
    return error.internal(c, 'Failed to list pipelines');
  }
});

app.get('/:id', requirePermission('pipelines:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Pipeline', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/pipelines] get failed:', err);
    return error.internal(c, 'Failed to fetch pipeline');
  }
});

app.post('/', requirePermission('pipelines:create'), zValidator('json', createPipelineSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const id = generateId('pl');
  const now = new Date();
  try {
    const values: typeof t.$inferInsert = {
      id,
      name: data.name,
      description: data.description,
      icon: data.icon,
      color: data.color,
      template: data.template,
      settings: data.settings as Record<string, unknown> | null | undefined,
      isDefault: data.isDefault ?? false,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    };
    const [created] = await db.insert(t).values(values).returning();
    publishEntityEvent({
      c,
      entityType: 'pipeline',
      entityId: id,
      action: 'created',
      data: { id, name: values.name, icon: values.icon, color: values.color },
    });
    return success(c, created, 201);
  } catch (err) {
    console.error('[app-api/pipelines] create failed:', err);
    return error.internal(c, 'Failed to create pipeline');
  }
});

app.patch('/:id', requirePermission('pipelines:update'), zValidator('json', updatePipelineSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Pipeline', id);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    const [updated] = await db
      .update(t)
      .set(update)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();
    publishEntityEvent({
      c,
      entityType: 'pipeline',
      entityId: id,
      action: 'updated',
      data: { id, ...update },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/pipelines] update failed:', err);
    return error.internal(c, 'Failed to update pipeline');
  }
});

app.delete('/:id', requirePermission('pipelines:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Pipeline', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'pipeline',
      entityId: id,
      action: 'deleted',
      data: { id, name: existing.name },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/pipelines] delete failed:', err);
    return error.internal(c, 'Failed to delete pipeline');
  }
});

export const pipelinesRoutes = app;
