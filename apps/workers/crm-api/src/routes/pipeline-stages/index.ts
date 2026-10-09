/**
 * Pipeline Stages routes — flat /api/pipeline-stages/* surface backed by
 * `crm_pipeline_stages`. Includes POST /reorder to renumber `position`
 * atomically for a given pipeline.
 *
 * Permissions: pipelines:read | pipelines:create | pipelines:update | pipelines:delete | pipelines:manage.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createPipelineStageSchema,
  reorderPipelineStagesSchema,
  updatePipelineStageSchema,
} from '@weldsuite/core-api-client/schemas/pipeline-stages';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmPipelineStages;

/** SQL for "this stage is a closed (won/lost) stage"; the flags are nullable. */
const isClosedStage = sql`(COALESCE(${t.isWon}, false) OR COALESCE(${t.isLost}, false))`;

app.get('/', requirePermission('pipelines:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 100, 200);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.pipeline) conditions.push(eq(t.pipeline, q.pipeline));
  const where = and(...conditions);

  try {
    const [rows, countRes] = await Promise.all([
      // Ties on `position` (legacy data: a stage added next to Won used to
      // share its position) list open stages before won/lost ones, then by
      // creation order, so the board never shows `Stage 3 | Won | Negotiation`.
      db
        .select()
        .from(t)
        .where(where)
        .orderBy(
          asc(t.position),
          asc(sql`CASE WHEN ${isClosedStage} THEN 1 ELSE 0 END`),
          asc(t.createdAt),
          asc(t.id),
        )
        .limit(limit + 1),
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

/**
 * Default `position` for a new stage when the caller doesn't supply one.
 *
 * - open stage: the slot right after the last *open* stage, i.e. before any
 *   won/lost stage. `shiftClosedBy` is how far the won/lost stages must move
 *   right (applied in the same transaction as the insert) so none of them ties
 *   with, or sits in front of, the new stage. Also repairs legacy pipelines
 *   where a stage already shares a position with Won.
 * - won/lost stage: after every existing stage, nothing to shift.
 */
async function nextStagePosition(
  db: Variables['tenantDb'],
  pipeline: string,
  closed: boolean,
): Promise<{ position: number; shiftClosedBy: number }> {
  const existing = await db
    .select({ position: t.position, isWon: t.isWon, isLost: t.isLost })
    .from(t)
    .where(and(eq(t.pipeline, pipeline), isNull(t.deletedAt)));
  if (closed) {
    const all = existing.map((s) => s.position);
    return { position: all.length > 0 ? Math.max(...all) + 1 : 0, shiftClosedBy: 0 };
  }
  const openPositions = existing.filter((s) => !s.isWon && !s.isLost).map((s) => s.position);
  const closedPositions = existing.filter((s) => s.isWon || s.isLost).map((s) => s.position);
  // No open stages yet: still land before any won/lost stage.
  const position =
    openPositions.length > 0
      ? Math.max(...openPositions) + 1
      : closedPositions.length > 0
        ? Math.min(...closedPositions)
        : 0;
  const shiftClosedBy =
    closedPositions.length > 0 ? Math.max(0, position + 1 - Math.min(...closedPositions)) : 0;
  return { position, shiftClosedBy };
}

app.post('/', requirePermission('pipelines:create'), zValidator('json', createPipelineStageSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const id = generateId('pls');
  const now = new Date();
  try {
    const pipeline = data.pipeline ?? 'default';
    const placement =
      data.position === undefined || data.position === null
        ? await nextStagePosition(db, pipeline, Boolean(data.isWon || data.isLost))
        : { position: data.position, shiftClosedBy: 0 };
    const { position, shiftClosedBy } = placement;
    const values: typeof t.$inferInsert = {
      id,
      name: data.name,
      description: data.description,
      position,
      probability: data.probability ?? 0,
      color: data.color,
      pipeline,
      isDefault: data.isDefault ?? false,
      isWon: data.isWon ?? false,
      isLost: data.isLost ?? false,
      createdAt: now,
      updatedAt: now,
    };
    // Inserting before the closed stages pushes them right in the same
    // transaction, so Won/Lost never share a position with the new stage.
    await atomically(db, (handle) => [
      ...(shiftClosedBy === 0
        ? []
        : [
            handle
              .update(t)
              .set({ position: sql`${t.position} + ${shiftClosedBy}`, updatedAt: now })
              .where(and(eq(t.pipeline, pipeline), isNull(t.deletedAt), isClosedStage)),
          ]),
      handle.insert(t).values(values),
    ]);
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
    // Guard: deleting a stage that still holds deals would orphan them
    // (stageId pointing at a soft-deleted stage). Block and tell the caller
    // how many deals are in the way instead of silently dropping them.
    const [{ count: dealCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.crmOpportunities)
      .where(
        and(
          or(eq(schema.crmOpportunities.stageId, id), eq(schema.crmOpportunities.stage, id)),
          isNull(schema.crmOpportunities.deletedAt),
        ),
      );
    if (Number(dealCount) > 0) {
      return error.badRequest(
        c,
        `Cannot delete stage "${existing.name}": it still has ${dealCount} deal(s). Move them to another stage first.`,
      );
    }
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
    const now = new Date();
    if (ids.length > 0) {
      await atomically(db, (handle) =>
        ids.map((id, position) =>
          handle
            .update(t)
            .set({ position, updatedAt: now })
            .where(and(eq(t.id, id), eq(t.pipeline, pipeline), isNull(t.deletedAt))),
        ),
      );
    }
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
