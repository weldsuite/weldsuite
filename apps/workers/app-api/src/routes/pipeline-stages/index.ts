/**
 * Pipeline Stages routes — flat /api/pipeline-stages/* surface backed by
 * `crm_pipeline_stages`. Includes POST /reorder to renumber `position`
 * atomically for a given pipeline.
 *
 * Permissions: pipelines:read | pipelines:create | pipelines:update | pipelines:delete | pipelines:manage.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createPipelineStageSchema,
  reorderPipelineStagesSchema,
  updatePipelineStageSchema,
} from '@weldsuite/core-api-client/schemas/pipeline-stages';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmPipelineStages;

app.get('/', requirePermission('pipelines:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 100, 200);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.pipeline) conditions.push(eq(t.pipeline, q.pipeline));
  const where = and(...conditions);

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(asc(t.position), asc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(where),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/pipeline-stages] list failed:', err);
    return error.internal(c, 'Failed to list pipeline stages');
  }
});

app.get('/:id', requirePermission('pipelines:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Pipeline stage', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/pipeline-stages] get failed:', err);
    return error.internal(c, 'Failed to fetch pipeline stage');
  }
});

app.post('/', requirePermission('pipelines:create'), zValidator('json', createPipelineStageSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const id = generateId('pls');
  const now = new Date();
  try {
    const values: typeof t.$inferInsert = {
      id,
      name: data.name,
      description: data.description,
      position: data.position ?? 0,
      probability: data.probability ?? 0,
      color: data.color,
      pipeline: data.pipeline ?? 'default',
      isDefault: data.isDefault ?? false,
      isWon: data.isWon ?? false,
      isLost: data.isLost ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(t).values(values);
    publishEntityEvent({
      c,
      entityType: 'pipeline_stage',
      entityId: id,
      action: 'created',
      data: { id, name: values.name, pipeline: values.pipeline, position: values.position },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/pipeline-stages] create failed:', err);
    return error.internal(c, 'Failed to create pipeline stage');
  }
});

app.patch('/:id', requirePermission('pipelines:update'), zValidator('json', updatePipelineStageSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Pipeline stage', id);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'pipeline_stage',
      entityId: id,
      action: 'updated',
      data: { id, pipeline: existing.pipeline, ...update },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/pipeline-stages] update failed:', err);
    return error.internal(c, 'Failed to update pipeline stage');
  }
});

app.delete('/:id', requirePermission('pipelines:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Pipeline stage', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'pipeline_stage',
      entityId: id,
      action: 'deleted',
      data: { id, pipeline: existing.pipeline, name: existing.name },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/pipeline-stages] delete failed:', err);
    return error.internal(c, 'Failed to delete pipeline stage');
  }
});

/**
 * POST /pipeline-stages/reorder — renumber `position` for the given pipeline
 * using the order in `ids` (0-based). Stages absent from `ids` are untouched.
 */
app.post('/reorder', requirePermission('pipelines:manage'), zValidator('json', reorderPipelineStagesSchema), async (c) => {
  const db = c.get('tenantDb');
  const { pipeline, ids } = c.req.valid('json');
  try {
    await Promise.all(
      ids.map((id, position) =>
        db
          .update(t)
          .set({ position, updatedAt: new Date() })
          .where(and(eq(t.id, id), eq(t.pipeline, pipeline), isNull(t.deletedAt))),
      ),
    );
    ids.forEach((id, position) => {
      publishEntityEvent({
        c,
        entityType: 'pipeline_stage',
        entityId: id,
        action: 'updated',
        data: { id, pipeline, position },
      });
    });
    return success(c, { pipeline, ids });
  } catch (err) {
    console.error('[app-api/pipeline-stages] reorder failed:', err);
    return error.internal(c, 'Failed to reorder pipeline stages');
  }
});

export const pipelineStagesRoutes = app;
