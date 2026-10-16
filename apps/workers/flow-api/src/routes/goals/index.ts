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
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { accessibleProjectIds, canAccessProject, canWriteProject } from '../../lib/project-access';
import { schema, type Database } from '@weldsuite/worker-kit/db';

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

/**
 * `project_goals` has no unique key on `projectId`, so older data may hold more
 * than one row for a project. Every read and write goes through this one
 * ordering so they all agree on the same row: a row that actually holds canvas
 * data wins over an empty one, then the most recently written, then the id.
 */
const canvasRowOrder = [
  sql`(CASE WHEN ${t.mission} IS NOT NULL OR jsonb_array_length(coalesce(${t.goals}, '[]'::jsonb)) > 0 THEN 0 ELSE 1 END)`,
  desc(t.updatedAt),
  desc(t.id),
];

async function findCanvasRow(db: Database, projectId: string) {
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.projectId, projectId), isNull(t.deletedAt)))
    .orderBy(...canvasRowOrder)
    .limit(1);
  return row ?? null;
}

/**
 * Id of the project's canvas row when it has to be created. Derived from the
 * project so two simultaneous first saves hit the same primary key (the second
 * becomes an update) instead of creating two rows. Falls back to a random id
 * when the project id is too long to embed in a varchar(30).
 */
function canvasRowId(projectId: string): string {
  const id = `gcv_${projectId}`;
  return id.length <= 30 ? id : generateId('goal');
}

/** Writes the project's canvas, updating its row or creating it. Returns the row id and whether it was created. */
async function saveCanvas(
  db: Database,
  projectId: string,
  canvas: { mission: Record<string, unknown> | null; goals: unknown[] },
  userId: string | undefined,
): Promise<{ id: string; created: boolean }> {
  const now = new Date();
  const existing = await findCanvasRow(db, projectId);
  if (existing) {
    await db
      .update(t)
      .set({ mission: canvas.mission, goals: canvas.goals, lastEditedBy: userId ?? null, updatedAt: now })
      .where(eq(t.id, existing.id));
    return { id: existing.id, created: false };
  }
  const id = canvasRowId(projectId);
  await db
    .insert(t)
    .values({
      id,
      projectId,
      mission: canvas.mission,
      goals: canvas.goals,
      lastEditedBy: userId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: t.id,
      // A concurrent first save (or a soft-deleted canvas row) already owns the id.
      set: {
        mission: canvas.mission,
        goals: canvas.goals,
        lastEditedBy: userId ?? null,
        updatedAt: now,
        deletedAt: null,
      },
    });
  return { id, created: true };
}

const GOAL_STATUSES = ['on-track', 'at-risk', 'off-track', 'not-started', 'completed'] as const;

/** Body of POST /: one goal card to add to a project's canvas. Unknown keys are dropped. */
const createGoalBodySchema = z.object({
  projectId: z.string().min(1).max(30),
  title: z.string().trim().min(1).max(255).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(5000).optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  dueDate: z.string().max(40).optional(),
  ownerId: z.string().max(255).nullish(),
});

/** Body of PATCH /:id: only the canvas columns can change; `id`, `projectId` and timestamps never do. */
const updateGoalBodySchema = z.object({
  mission: z.record(z.unknown()).nullable().optional(),
  goals: z.array(z.unknown()).optional(),
});

/** `Q4 2026`-style label for the card's time period. */
function quarterLabel(date: Date): string {
  return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
}

function newGoalCard(input: z.infer<typeof createGoalBodySchema>, position: number) {
  const due = input.dueDate && !Number.isNaN(Date.parse(input.dueDate))
    ? new Date(input.dueDate)
    : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  return {
    id: generateId('goal'),
    title: input.title ?? input.name ?? 'Untitled goal',
    description: input.description ?? '',
    owner: { name: 'Unassigned', initials: '?', color: '#94a3b8' },
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    status: input.status ?? 'not-started',
    progress: input.progress ?? 0,
    dueDate: due.toISOString(),
    timePeriod: quarterLabel(due),
    type: 'company',
    x: 100 + position * 350,
    y: 300,
    width: 320,
    height: 200,
    subGoals: [] as string[],
    updates: 0,
    comments: 0,
    attachments: 0,
  };
}

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
    const row = await findCanvasRow(db, projectId);
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
      const { id, created } = await saveCanvas(db, projectId, { mission, goals }, userId);
      publishEntityEvent({
        c,
        entityType: 'project_goal',
        entityId: id,
        action: created ? 'created' : 'updated',
        data: { id, projectId },
      });
      return success(c, { id }, created ? 201 : 200);
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

// POST / — add one goal card to the project's canvas. A project has a single
// canvas row, so this appends to it (creating it on first use) instead of
// inserting a second, empty row that the canvas would never read. `projectId`
// is required. Answers `{ id }` (the canvas row) plus `goalId` (the new card).
app.post('/', requirePermission('projects:create'), zValidator('json', createGoalBodySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  if (!(await canWriteProject(c, data.projectId))) {
    return error.forbidden(c, PROJECT_WRITE_DENIED);
  }
  try {
    const existing = await findCanvasRow(db, data.projectId);
    const goals = Array.isArray(existing?.goals) ? [...existing.goals] : [];
    const card = newGoalCard(data, goals.length);
    goals.push(card);
    const { id, created } = await saveCanvas(
      db,
      data.projectId,
      { mission: existing?.mission ?? null, goals },
      c.get('userId'),
    );
    publishEntityEvent({
      c,
      entityType: 'project_goal',
      entityId: id,
      action: created ? 'created' : 'updated',
      data: { id, projectId: data.projectId },
    });
    return success(c, { id, goalId: card.id }, 201);
  } catch (err) {
    console.error('[app-api/goals] create failed:', err);
    return error.internal(c, 'Failed to create goal');
  }
});

app.patch('/:id', requirePermission('projects:update'), zValidator('json', updateGoalBodySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Goal', id);
    if (existing.projectId && !(await canWriteProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_WRITE_DENIED);
    }
    // Allow-list: only the canvas columns, never id / projectId / timestamps.
    const update: Partial<typeof t.$inferInsert> = { updatedAt: new Date(), lastEditedBy: c.get('userId') ?? null };
    if (data.mission !== undefined) update.mission = data.mission;
    if (data.goals !== undefined) update.goals = data.goals;
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
