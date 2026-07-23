/**
 * Project label routes — flat /api/project-labels/* surface backed by `projectLabels`.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createProjectLabelSchema, updateProjectLabelSchema } from '@weldsuite/core-api-client/schemas/project-labels';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectLabels;

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  // Match api-worker behaviour: when projectId is provided, return that
  // project's labels PLUS workspace-wide labels (projectId IS NULL). Without
  // a projectId (cross-project views like my-tasks / CRM), return everything.
  if (q.projectId !== undefined && q.projectId !== '') {
    conditions.push(sql`(${t.projectId} = ${q.projectId} OR ${t.projectId} IS NULL)`);
  }
  if (q.search) {
    conditions.push(like(t.name, `%${q.search}%`));
  }
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
    const tasks = schema.tasks;
    const [rows, countRes, usageRows] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
      // Aggregate label usage from tasks.labels (jsonb string[]). Cheap
      // workspace-wide scan; this is how api-worker did it.
      db.execute<{ label_id: string; count: number }>(sql`
        SELECT jsonb_array_elements_text(${tasks.labels}) AS label_id,
               COUNT(*)::int AS count
        FROM ${tasks}
        WHERE ${tasks.labels} IS NOT NULL
          AND ${tasks.deletedAt} IS NULL
        GROUP BY label_id
      `),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);

    const counts = new Map<string, number>();
    const usageArr =
      (usageRows as unknown as { rows?: Array<{ label_id: string; count: number }> }).rows ??
      (usageRows as unknown as Array<{ label_id: string; count: number }>);
    for (const r of usageArr ?? []) counts.set(r.label_id, Number(r.count));
    const withUsage = data.map((l) => ({ ...l, usageCount: counts.get(l.id) ?? 0 }));

    return list(c, withUsage, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/project-labels] list failed:', err);
    return error.internal(c, 'Failed to list project labels');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Project label', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/project-labels] get failed:', err);
    return error.internal(c, 'Failed to fetch project label');
  }
});

app.post('/', requirePermission('projects:create'), zValidator('json', createProjectLabelSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('plbl');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'project_label',
      entityId: id,
      action: 'created',
      data: { id, ...data },
    });
    return success(c, { id, ...data }, 201);
  } catch (err) {
    console.error('[app-api/project-labels] create failed:', err);
    return error.internal(c, 'Failed to create project label');
  }
});

app.patch('/:id', requirePermission('projects:update'), zValidator('json', updateProjectLabelSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project label', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'project_label',
      entityId: id,
      action: 'updated',
      data: { id, ...data },
    });
    return success(c, { id, ...data });
  } catch (err) {
    console.error('[app-api/project-labels] update failed:', err);
    return error.internal(c, 'Failed to update project label');
  }
});

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Project label', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_label',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/project-labels] delete failed:', err);
    return error.internal(c, 'Failed to delete project label');
  }
});

export const projectLabelsRoutes = app;
