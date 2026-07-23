/**
 * Task comment routes — /api/task-comments/*.
 *
 * Comments on WeldFlow project tasks. `authorId` is set from the Clerk
 * session; only the author can edit/delete their own comment. The list
 * response includes `authorName` and `authorAvatar` joined from
 * `workspaceMembers` so the UI doesn't need a second round trip.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { accessibleProjectIds, canAccessTaskProject } from '../../lib/project-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.taskComments;

const TASK_DENIED = "You are not a member of this task's project";

const listFiltersSchema = z.object({
  taskId: z.string().optional(),
  authorId: z.string().optional(),
  taskType: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const createCommentSchema = z.object({
  taskId: z.string().min(1),
  taskType: z.string().default('project'),
  content: z.string().min(1),
});

const updateCommentSchema = z.object({
  content: z.string().min(1),
});

app.get('/', requirePermission('tasks:read'), zValidator('query', listFiltersSchema), async (c) => {
  const db = c.get('tenantDb');
  const f = c.req.valid('query');
  const page = f.page ?? 1;
  const limit = f.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [isNull(t.deletedAt)];
  if (f.taskId) conditions.push(eq(t.taskId, f.taskId));
  if (f.taskType) conditions.push(eq(t.taskType, f.taskType));
  if (f.authorId) conditions.push(eq(t.authorId, f.authorId));
  // A comment's access follows its task's project.
  if (f.taskId) {
    if ((await canAccessTaskProject(c, f.taskId)) === 'denied') return error.forbidden(c, TASK_DENIED);
  } else {
    // No task filter: restrict to comments whose task is in an accessible
    // project. taskComments has no projectId, so constrain via a subquery on
    // tasks. NOTE: non-project tasks (null projectId) are included and are NOT
    // owner-scoped — the same known-deferred gap as the tasks route (no
    // per-user gate on personal/CRM tasks yet).
    const accessible = await accessibleProjectIds(c);
    if (accessible !== null) {
      const accessibleTaskIds = db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(
          or(
            isNull(schema.tasks.projectId),
            inArray(schema.tasks.projectId, accessible.length ? accessible : ['']),
          ),
        );
      conditions.push(inArray(t.taskId, accessibleTaskIds));
    }
  }
  const where = and(...conditions);

  try {
    const { workspaceMembers } = schema;
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);

    // Enrich with author display fields.
    const authorIds = [...new Set(rows.map((r) => r.authorId).filter(Boolean) as string[])];
    let enriched: any[] = rows;
    if (authorIds.length > 0) {
      const authors = await db
        .select({
          userId: workspaceMembers.userId,
          name: workspaceMembers.name,
          avatar: workspaceMembers.picture,
        })
        .from(workspaceMembers)
        .where(inArray(workspaceMembers.userId, authorIds));
      const map = new Map(authors.map((a) => [a.userId, a]));
      enriched = rows.map((r) => {
        const author = r.authorId ? map.get(r.authorId) : null;
        return {
          ...r,
          authorName: author?.name ?? r.authorId,
          authorAvatar: author?.avatar ?? null,
        };
      });
    }

    return list(c, enriched, {
      totalCount,
      hasMore: offset + rows.length < totalCount,
      cursor: null,
    });
  } catch (err) {
    console.error('[app-api/task-comments] list failed:', err);
    return error.internal(c, 'Failed to list task comments');
  }
});

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Task comment', id);
    if ((await canAccessTaskProject(c, row.taskId)) === 'denied') {
      return error.forbidden(c, TASK_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/task-comments] get failed:', err);
    return error.internal(c, 'Failed to fetch task comment');
  }
});

app.post(
  '/',
  requirePermission('tasks:create'),
  zValidator('json', createCommentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const data = c.req.valid('json');
    const id = generateId('tcmt');
    const now = new Date();
    const access = await canAccessTaskProject(c, data.taskId);
    if (access === 'not-found') return error.notFound(c, 'Task', data.taskId);
    if (access === 'denied') return error.forbidden(c, TASK_DENIED);
    try {
      await db.insert(t).values({
        id,
        taskId: data.taskId,
        taskType: data.taskType ?? 'project',
        content: data.content,
        authorId: userId,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof t.$inferInsert);
      publishEntityEvent({
        c,
        entityType: 'task_comment',
        entityId: id,
        action: 'created',
        data: { id, taskId: data.taskId, content: data.content },
      });
      return success(c, { id, taskId: data.taskId, content: data.content, authorId: userId }, 201);
    } catch (err) {
      console.error('[app-api/task-comments] create failed:', err);
      return error.internal(c, 'Failed to create task comment');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('tasks:update'),
  zValidator('json', updateCommentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const userId = c.get('userId');
    const { content } = c.req.valid('json');
    try {
      const [existing] = await db
        .select({ authorId: t.authorId })
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Task comment', id);
      if (existing.authorId !== userId) {
        return error.forbidden(c, 'You can only edit your own comments');
      }
      await db.update(t).set({ content, updatedAt: new Date() }).where(eq(t.id, id));
      publishEntityEvent({
        c,
        entityType: 'task_comment',
        entityId: id,
        action: 'updated',
        data: { id, content },
      });
      return success(c, { id, content });
    } catch (err) {
      console.error('[app-api/task-comments] update failed:', err);
      return error.internal(c, 'Failed to update task comment');
    }
  },
);

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');
  try {
    const [existing] = await db
      .select({ authorId: t.authorId })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Task comment', id);
    if (existing.authorId !== userId) {
      return error.forbidden(c, 'You can only delete your own comments');
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'task_comment',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/task-comments] delete failed:', err);
    return error.internal(c, 'Failed to delete task comment');
  }
});

export const taskCommentsRoutes = app;
