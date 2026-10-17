/**
 * Task project routes — flat /api/task-projects/* surface backed by `taskProjects`.
 *
 * Task projects are PERSONAL saved-project views: every read and write is
 * scoped to the calling user's `userId`. The DB column is NOT NULL, and
 * cross-user visibility is a data leak — no elevated grant exists today.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTaskProjectSchema, updateTaskProjectSchema } from '@weldsuite/core-api-client/schemas/task-projects';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { containsPattern, parseLimit } from '../../lib/query-params';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.taskProjects;

app.get('/', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.query();
  const limit = parseLimit(q.limit, 25, 100);

  const conditions: any[] = [isNull(t.deletedAt), eq(t.userId, userId)];
  if (q.search) {
    conditions.push(ilike(t.name, containsPattern(q.search)));
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
    console.error('[app-api/task-projects] list failed:', err);
    return error.internal(c, 'Failed to list task projects');
  }
});

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.userId, userId)))
      .limit(1);
    if (!row) return error.notFound(c, 'Task project', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/task-projects] get failed:', err);
    return error.internal(c, 'Failed to fetch task project');
  }
});

app.post('/', requirePermission('tasks:create'), zValidator('json', createTaskProjectSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('tpr');
  const now = new Date();
  try {
    // Allow-list: the schema is passthrough, so spreading the body would let a
    // client choose the primary key (`id`) or other server-owned columns.
    await db.insert(t).values({
      id,
      name: data.name,
      description: data.description ?? null,
      color: data.color ?? null,
      userId,
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({
      c,
      entityType: 'task_project',
      entityId: id,
      action: 'created',
      data: { id, name: data.name, userId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/task-projects] create failed:', err);
    return error.internal(c, 'Failed to create task project');
  }
});

app.patch('/:id', requirePermission('tasks:update'), zValidator('json', updateTaskProjectSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Task project', id);
    // Allow-list, not a copy of the body: the schema is passthrough, and a loop
    // over its keys could rewrite `id`, `userId` or `deletedAt`.
    const update: { updatedAt: Date; name?: string; description?: string; color?: string } = {
      updatedAt: new Date(),
    };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.color !== undefined) update.color = data.color;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.userId, userId)));
    publishEntityEvent({
      c,
      entityType: 'task_project',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name,
        userId: existing.userId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/task-projects] update failed:', err);
    return error.internal(c, 'Failed to update task project');
  }
});

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Task project', id);
    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.userId, userId)));
    publishEntityEvent({
      c,
      entityType: 'task_project',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/task-projects] delete failed:', err);
    return error.internal(c, 'Failed to delete task project');
  }
});

export const taskProjectsRoutes = app;
