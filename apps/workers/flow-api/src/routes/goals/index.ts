/**
 * Goal routes — flat /api/goals/* surface backed by `projectGoals`.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createGoalSchema, updateGoalSchema } from '@weldsuite/core-api-client/schemas/goals';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { accessibleProjectIds, canAccessProject, canWriteProject } from '../../lib/project-access';
import { schema } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectGoals;

const PROJECT_DENIED = 'You are not a member of this project';
const PROJECT_WRITE_DENIED = 'You do not have write access to this project';

type GoalsCtx = Context<{ Bindings: Env; Variables: Variables }>;

/** Adds the project filter (or the caller's accessible-project scope); returns a 403 response when denied. */
async function applyProjectScope(
  c: GoalsCtx,
  projectId: string | undefined,
  conditions: SQL[],
): Promise<Response | null> {
  if (projectId) {
    conditions.push(eq(t.projectId, projectId));
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    return null;
  }
  const accessible = await accessibleProjectIds(c);
  if (accessible !== null) conditions.push(inArray(t.projectId, accessible.length ? accessible : ['']));
  return null;
}

/** Keyset-pagination condition for the row identified by `cursorId`, if it exists. */
async function cursorCondition(c: GoalsCtx, cursorId: string): Promise<SQL | null> {
  const db = c.get('tenantDb');
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursorId)).limit(1);
  if (!cur?.createdAt) return null;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const conditions: SQL[] = [isNull(t.deletedAt)];
  const denied = await applyProjectScope(c, q.projectId, conditions);
  if (denied) return denied;
  const filterConditions = [...conditions];
  if (q.cursor) {
    const cursorCond = await cursorCondition(c, q.cursor);
    if (cursorCond) conditions.push(cursorCond);
  }
  const where = conditions.length ? and(...conditions) : undefined;
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
    console.error('[app-api/goals] list failed:', err);
    return error.internal(c, 'Failed to list goals');
  }
});

// ============================================================================
// By-project canvas API — WeldFlow stores goals as a single JSONB blob per
// project (mission + freeform goals array, see project-goals canvas). These
// two endpoints mirror the api-worker /:projectId/goals surface so the UI
// doesn't need to learn the multi-row model.
// ============================================================================

const goalsCanvasSchema = z
  .object({
    mission: z.unknown(),
    goals: z.array(z.unknown()).default([]),
  })
  .passthrough();

const DEFAULT_CANVAS = {
  mission: {
    id: 'mission-1',
    title: 'Project Mission',
    description: 'Our mission',
    x: 600,
    y: 50,
    width: 320,
    height: 160,
    subGoals: [] as string[],
  },
  goals: [] as unknown[],
};

app.get('/by-project/:projectId', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.param('projectId');
  if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.projectId, projectId), isNull(t.deletedAt)))
      .orderBy(desc(t.createdAt))
      .limit(1);
    if (!row) return success(c, DEFAULT_CANVAS);
    return success(c, {
      mission: row.mission ?? DEFAULT_CANVAS.mission,
      goals: row.goals ?? [],
    });
  } catch (err) {
    console.error('[app-api/goals] by-project get failed:', err);
    return error.internal(c, 'Failed to fetch project goals');
  }
});

app.put(
  '/by-project/:projectId',
  requirePermission('projects:update'),
  zValidator('json', goalsCanvasSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const projectId = c.req.param('projectId');
    if (!(await canWriteProject(c, projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
    const userId = c.get('userId');
    const payload = c.req.valid('json');
    const mission = (payload.mission ?? null) as Record<string, unknown> | null;
    const goals = (payload.goals ?? []) as unknown[];
    try {
      const [existing] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.projectId, projectId), isNull(t.deletedAt)))
        .limit(1);
      const now = new Date();
      if (existing) {
        await db
          .update(t)
          .set({ mission, goals, lastEditedBy: userId ?? null, updatedAt: now })
          .where(eq(t.id, existing.id));
        publishEntityEvent({
          c,
          entityType: 'project_goal',
          entityId: existing.id,
          action: 'updated',
          data: { id: existing.id, projectId },
        });
        return success(c, { id: existing.id });
      }
      const id = generateId('goal');
      await db.insert(t).values({
        id,
        projectId,
        mission,
        goals,
        lastEditedBy: userId ?? null,
        createdAt: now,
        updatedAt: now,
      });
      publishEntityEvent({
        c,
        entityType: 'project_goal',
        entityId: id,
        action: 'created',
        data: { id, projectId },
      });
      return success(c, { id }, 201);
    } catch (err) {
      console.error('[app-api/goals] by-project save failed:', err);
      return error.internal(c, 'Failed to save project goals');
    }
  },
);

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Goal', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/goals] get failed:', err);
    return error.internal(c, 'Failed to fetch goal');
  }
});

app.post('/', requirePermission('projects:create'), zValidator('json', createGoalSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('goal');
  const now = new Date();
  if (data.projectId && !(await canWriteProject(c, data.projectId))) {
    return error.forbidden(c, PROJECT_WRITE_DENIED);
  }
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'project_goal',
      entityId: id,
      action: 'created',
      data: { id, projectId: data.projectId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/goals] create failed:', err);
    return error.internal(c, 'Failed to create goal');
  }
});

app.patch('/:id', requirePermission('projects:update'), zValidator('json', updateGoalSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Goal', id);
    if (existing.projectId && !(await canWriteProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'project_goal',
      entityId: id,
      action: 'updated',
      data: { id, projectId: existing.projectId },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/goals] update failed:', err);
    return error.internal(c, 'Failed to update goal');
  }
});

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Goal', id);
    if (existing.projectId && !(await canWriteProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_goal',
      entityId: id,
      action: 'deleted',
      data: { id, projectId: existing.projectId },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/goals] delete failed:', err);
    return error.internal(c, 'Failed to delete goal');
  }
});

export const goalsRoutes = app;
