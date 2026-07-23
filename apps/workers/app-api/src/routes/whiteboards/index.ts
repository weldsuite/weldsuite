/**
 * Whiteboard routes — /api/whiteboards/*.
 *
 * Multiple whiteboards per project (`projectWhiteboards`). The body is an
 * `elements[]` array that the editor saves wholesale on every change.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { accessibleProjectIds, canAccessProject } from '../../lib/project-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectWhiteboards;

const PROJECT_DENIED = 'You are not a member of this project';

const createWhiteboardSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).default('Whiteboard'),
  elements: z.array(z.any()).optional(),
});

const updateWhiteboardSchema = z.object({
  name: z.string().min(1).optional(),
  elements: z.array(z.any()).optional(),
});

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 100, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.projectId !== undefined && q.projectId !== '') conditions.push(eq(t.projectId, q.projectId));
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);
  } else {
    const accessible = await accessibleProjectIds(c);
    if (accessible !== null) conditions.push(inArray(t.projectId, accessible.length ? accessible : ['']));
  }
  if (q.search) conditions.push(like(t.name, `%${q.search}%`));
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t)
      .where(eq(t.id, q.cursor))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} > ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} > ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      // Oldest first — UI lists whiteboards in creation order in the project sidebar.
      db.select().from(t).where(where).orderBy(asc(t.createdAt), asc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/whiteboards] list failed:', err);
    return error.internal(c, 'Failed to list whiteboards');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Whiteboard', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/whiteboards] get failed:', err);
    return error.internal(c, 'Failed to fetch whiteboard');
  }
});

app.post(
  '/',
  requirePermission('projects:create'),
  zValidator('json', createWhiteboardSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    // `pwb` prefix to match the id format api-worker has been writing.
    const id = generateId('pwb');
    const now = new Date();
    if (data.projectId && !(await canAccessProject(c, data.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    try {
      await db.insert(t).values({
        id,
        projectId: data.projectId,
        name: data.name,
        elements: data.elements ?? [],
        createdAt: now,
        updatedAt: now,
      });
      const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'project_whiteboard',
        entityId: id,
        action: 'created',
        data: { id, projectId: data.projectId, name: data.name },
      });
      return success(c, created, 201);
    } catch (err) {
      console.error('[app-api/whiteboards] create failed:', err);
      return error.internal(c, 'Failed to create whiteboard');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('projects:update'),
  zValidator('json', updateWhiteboardSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const userId = c.get('userId');
    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Whiteboard', id);
      if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
        return error.forbidden(c, PROJECT_DENIED);
      }

      const update: Record<string, any> = { updatedAt: new Date() };
      if (data.name !== undefined) update.name = data.name;
      if (data.elements !== undefined) {
        update.elements = data.elements;
        update.lastEditedBy = userId ?? null;
      }
      await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

      const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'project_whiteboard',
        entityId: id,
        action: 'updated',
        data: { id, name: updated?.name },
      });
      return success(c, updated);
    } catch (err) {
      console.error('[app-api/whiteboards] update failed:', err);
      return error.internal(c, 'Failed to update whiteboard');
    }
  },
);

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Whiteboard', id);
    if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_whiteboard',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/whiteboards] delete failed:', err);
    return error.internal(c, 'Failed to delete whiteboard');
  }
});

export const whiteboardsRoutes = app;
