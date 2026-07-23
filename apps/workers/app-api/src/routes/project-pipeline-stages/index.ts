/**
 * Project pipeline stage routes — /api/project-pipeline-stages/*.
 *
 * Stages map 1:1 to the kanban columns in the project pipeline view, and
 * each stage's `systemStatus` is what `tasks.status` carries. Default-seeded
 * on first list per project so the kanban is never empty.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { canAccessProject } from '../../lib/project-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectPipelineStages;

const PROJECT_DENIED = 'You are not a member of this project';

const DEFAULT_STAGES: { name: string; color: string; systemStatus: string }[] = [
  { name: 'Backlog', color: '#94a3b8', systemStatus: 'backlog' },
  { name: 'To Do', color: '#c4b5fd', systemStatus: 'todo' },
  { name: 'In Progress', color: '#93c5fd', systemStatus: 'in_progress' },
  { name: 'In Review', color: '#fcd34d', systemStatus: 'review' },
  { name: 'Done', color: '#5eead4', systemStatus: 'done' },
  { name: 'Cancelled', color: '#f87171', systemStatus: 'cancelled' },
];

function slugifyStage(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}_${suffix}`;
}

const createStageSchema = z.object({
  projectId: z.string().min(1),
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  color: z.string().optional(),
  position: z.number().int().min(0).optional(),
  systemStatus: z.string().optional(),
});

const updateStageSchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().optional(),
  systemStatus: z.string().optional(),
});

const reorderStagesSchema = z.object({
  stageIds: z.array(z.string().min(1)).min(1),
});

// ============================================================================
// GET / — list stages for a project (auto-seeds defaults on first call),
// includes `usageCount` per stage so the settings view can show task counts.
// ============================================================================

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const projectId = c.req.query('projectId');
  if (!projectId) return error.badRequest(c, 'Missing required query param: projectId');
  // Guard before the auto-seed below so a non-member can't seed + read stages.
  if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);

  try {
    const tasks = schema.tasks;

    let results = await db
      .select()
      .from(t)
      .where(and(eq(t.projectId, projectId), isNull(t.deletedAt)))
      .orderBy(asc(t.position));

    // Auto-seed when a project has no stages yet. Single source of truth for
    // settings, kanban, and task-create dropdowns.
    if (results.length === 0) {
      const now = new Date();
      try {
        await db.insert(t).values(
          DEFAULT_STAGES.map((s, i) => ({
            id: generateId('stg'),
            projectId,
            name: s.name,
            color: s.color,
            position: i,
            systemStatus: s.systemStatus,
            createdAt: now,
            updatedAt: now,
          })),
        );
      } catch (seedErr) {
        // Concurrent seed — tolerate unique-key collisions.
        console.warn('[app-api/project-pipeline-stages] seed skipped (likely concurrent):', seedErr);
      }
      results = await db
        .select()
        .from(t)
        .where(and(eq(t.projectId, projectId), isNull(t.deletedAt)))
        .orderBy(asc(t.position));
    }

    // Aggregate task counts per stage. Tasks without `stageId` fall back to
    // matching by `status` (either a stage whose id equals the status or whose
    // systemStatus equals the status), mirroring the kanban view's resolution.
    const countRows = await db
      .select({ stageId: tasks.stageId, status: tasks.status, count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .groupBy(tasks.stageId, tasks.status);

    const counts = new Map<string, number>();
    for (const r of countRows) {
      let targetStageId: string | null = r.stageId ?? null;
      if (!targetStageId && r.status) {
        const fallback =
          results.find((s) => s.id === r.status) ||
          results.find((s) => s.systemStatus === r.status);
        targetStageId = fallback?.id ?? null;
      }
      if (targetStageId) {
        counts.set(targetStageId, (counts.get(targetStageId) ?? 0) + Number(r.count));
      }
    }

    const withUsage = results.map((s) => ({ ...s, usageCount: counts.get(s.id) ?? 0 }));
    return list(c, withUsage, { totalCount: withUsage.length, hasMore: false, cursor: null });
  } catch (err) {
    console.error('[app-api/project-pipeline-stages] list failed:', err);
    return error.internal(c, 'Failed to list project pipeline stages');
  }
});

// ============================================================================
// GET /:id
// ============================================================================

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Project pipeline stage', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/project-pipeline-stages] get failed:', err);
    return error.internal(c, 'Failed to fetch project pipeline stage');
  }
});

// ============================================================================
// POST / — create a stage. Uses `stg` id prefix to match api-worker IDs (the
// frontend kanban serializes stage ids into task.status, so the prefix is
// load-bearing).
// ============================================================================

app.post(
  '/',
  requirePermission('projects:create'),
  zValidator('json', createStageSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const id = data.id || slugifyStage(data.name);
    const now = new Date();
    if (!(await canAccessProject(c, data.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }

    try {
      // Append at end if no explicit position.
      let position = data.position;
      if (position === undefined) {
        const [row] = await db
          .select({ maxPos: sql<number>`COALESCE(MAX(position), -1)::int` })
          .from(t)
          .where(and(eq(t.projectId, data.projectId), isNull(t.deletedAt)));
        position = (row?.maxPos ?? -1) + 1;
      }

      await db.insert(t).values({
        id,
        projectId: data.projectId,
        name: data.name,
        color: data.color,
        position,
        systemStatus: data.systemStatus ?? id,
        createdAt: now,
        updatedAt: now,
      });

      const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);

      publishEntityEvent({
        c,
        entityType: 'project_pipeline_stage',
        entityId: id,
        action: 'created',
        data: { id, projectId: data.projectId, name: data.name },
      });

      return success(c, created, 201);
    } catch (err) {
      console.error('[app-api/project-pipeline-stages] create failed:', err);
      return error.internal(c, 'Failed to create project pipeline stage');
    }
  },
);

// ============================================================================
// PATCH /reorder — accept ordered stageIds, persist as positions 0..N
// (registered BEFORE /:id so Hono matches the literal first).
// ============================================================================

app.patch(
  '/reorder',
  requirePermission('projects:update'),
  zValidator('json', reorderStagesSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const { stageIds } = c.req.valid('json');
    const now = new Date();
    try {
      // Verify access to EVERY stage's project, not just the first — a foreign
      // stage id later in the array would otherwise be silently rewritten.
      const stages = await db
        .select({ projectId: t.projectId })
        .from(t)
        .where(and(inArray(t.id, stageIds), isNull(t.deletedAt)));
      const projectIds = [...new Set(stages.map((s) => s.projectId).filter(Boolean))] as string[];
      for (const pid of projectIds) {
        if (!(await canAccessProject(c, pid))) return error.forbidden(c, PROJECT_DENIED);
      }
      for (let i = 0; i < stageIds.length; i++) {
        await db
          .update(t)
          .set({ position: i, updatedAt: now })
          .where(and(eq(t.id, stageIds[i]), isNull(t.deletedAt)));
      }
      return success(c, { reordered: true });
    } catch (err) {
      console.error('[app-api/project-pipeline-stages] reorder failed:', err);
      return error.internal(c, 'Failed to reorder project pipeline stages');
    }
  },
);

// ============================================================================
// PATCH /:id
// ============================================================================

app.patch(
  '/:id',
  requirePermission('projects:update'),
  zValidator('json', updateStageSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Project pipeline stage', id);
      if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
        return error.forbidden(c, PROJECT_DENIED);
      }

      const update: Record<string, any> = { updatedAt: new Date() };
      if (data.name !== undefined) update.name = data.name;
      if (data.color !== undefined) update.color = data.color;
      if (data.systemStatus !== undefined) update.systemStatus = data.systemStatus;
      await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

      const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);

      publishEntityEvent({
        c,
        entityType: 'project_pipeline_stage',
        entityId: id,
        action: 'updated',
        data: { id, ...data },
      });

      return success(c, updated);
    } catch (err) {
      console.error('[app-api/project-pipeline-stages] update failed:', err);
      return error.internal(c, 'Failed to update project pipeline stage');
    }
  },
);

// ============================================================================
// DELETE /:id — soft-delete + optional bulk-move of tasks via
// `?moveTasksToStageId=...`. Mirrors api-worker behaviour so dropping a
// stage with tasks in it doesn't strand them.
// ============================================================================

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const moveTasksToStageId = c.req.query('moveTasksToStageId') || null;

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Project pipeline stage', id);
    if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }

    const now = new Date();
    const tasks = schema.tasks;

    if (moveTasksToStageId) {
      const [target] = await db
        .select({ id: t.id, systemStatus: t.systemStatus })
        .from(t)
        .where(and(eq(t.id, moveTasksToStageId), isNull(t.deletedAt)))
        .limit(1);
      if (target) {
        await db
          .update(tasks)
          .set({ stageId: target.id, status: target.systemStatus, updatedAt: now })
          .where(
            and(
              eq(tasks.projectId, existing.projectId),
              eq(tasks.stageId, id),
              isNull(tasks.deletedAt),
            ),
          );
      }
    }

    await db.update(t).set({ deletedAt: now, updatedAt: now }).where(eq(t.id, id));

    publishEntityEvent({
      c,
      entityType: 'project_pipeline_stage',
      entityId: id,
      action: 'deleted',
      data: { id },
    });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/project-pipeline-stages] delete failed:', err);
    return error.internal(c, 'Failed to delete project pipeline stage');
  }
});

export const projectPipelineStagesRoutes = app;
