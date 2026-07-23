/**
 * Sprint routes — flat /api/sprints/* surface backed by `sprints`.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createSprintSchema, updateSprintSchema } from '@weldsuite/core-api-client/schemas/sprints';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { accessibleProjectIds, canAccessProject } from '../../lib/project-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.sprints;

const PROJECT_DENIED = 'You are not a member of this project';

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.projectId !== undefined && q.projectId !== '') conditions.push(eq(t.projectId, q.projectId));
  // Row-level: restrict to projects the caller can access.
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);
  } else {
    const accessible = await accessibleProjectIds(c);
    if (accessible !== null) conditions.push(inArray(t.projectId, accessible.length ? accessible : ['']));
  }
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
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
    console.error('[app-api/sprints] list failed:', err);
    return error.internal(c, 'Failed to list sprints');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Sprint', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/sprints] get failed:', err);
    return error.internal(c, 'Failed to fetch sprint');
  }
});

app.post('/', requirePermission('projects:create'), zValidator('json', createSprintSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('spr');
  const now = new Date();
  // `projectId` is NOT NULL at the DB (FK to projects) — surface a
  // clean 400 instead of a 500 from the Drizzle insert.
  if (!data.projectId) {
    return error.badRequest(c, 'Missing required field: projectId');
  }
  if (!(await canAccessProject(c, data.projectId))) {
    return error.forbidden(c, PROJECT_DENIED);
  }
  try {
    await db
      .insert(t)
      .values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'project_sprint',
      entityId: id,
      action: 'created',
      data: { id, projectId: data.projectId, name: data.name, status: data.status ?? 'planned' },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/sprints] create failed:', err);
    return error.internal(c, 'Failed to create sprint');
  }
});

app.patch('/:id', requirePermission('projects:update'), zValidator('json', updateSprintSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Sprint', id);
    if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'project_sprint',
      entityId: id,
      action: 'updated',
      data: {
        id,
        projectId: existing.projectId,
        name: (update.name as string | undefined) ?? existing.name,
        status: (update.status as string | undefined) ?? existing.status,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/sprints] update failed:', err);
    return error.internal(c, 'Failed to update sprint');
  }
});

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Sprint', id);
    if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_sprint',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/sprints] delete failed:', err);
    return error.internal(c, 'Failed to delete sprint');
  }
});

export const sprintsRoutes = app;
