/**
 * Workflow trigger routes — flat /api/workflow-triggers/* surface.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.workflowTriggers;
const wf = schema.workflows;
const ws = schema.workflowSchedules;

const triggerCategory = z.enum(['schedule', 'entity_event', 'webhook', 'manual', 'api']);

const createTriggerSchema = z.object({
  workflowId: z.string(),
  name: z.string().min(1).max(255),
  category: triggerCategory,
  config: z.record(z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
});

const updateTriggerSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  category: triggerCategory.optional(),
  config: z.record(z.unknown()).optional(),
  isEnabled: z.boolean().optional(),
});

app.get('/', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const filterConditions: any[] = [isNull(t.deletedAt)];
  if (q.workflowId) filterConditions.push(eq(t.workflowId, q.workflowId));
  if (q.category) filterConditions.push(eq(t.category, q.category));
  if (q.isEnabled !== undefined) filterConditions.push(eq(t.isEnabled, q.isEnabled === 'true'));

  const conditions = [...filterConditions];
  if (q.cursor) conditions.push(lt(t.id, q.cursor));

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({ trigger: t, workflowName: wf.name })
        .from(t)
        .leftJoin(wf, eq(t.workflowId, wf.id))
        .where(and(...conditions))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...filterConditions)),
    ]);

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const data = sliced.map((r) => ({ ...r.trigger, workflowName: r.workflowName }));
    const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data, cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, cursor));
  } catch (err) {
    console.error('[app-api/workflow-triggers] list failed:', err);
    return error.internal(c, 'Failed to list workflow triggers');
  }
});

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select({ trigger: t, workflowName: wf.name })
      .from(t)
      .leftJoin(wf, eq(t.workflowId, wf.id))
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Workflow trigger', id);
    return success(c, { ...row.trigger, workflowName: row.workflowName });
  } catch (err) {
    console.error('[app-api/workflow-triggers] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow trigger');
  }
});

async function verifyWorkflow(db: any, workflowId: string) {
  const [row] = await db.select().from(wf).where(and(eq(wf.id, workflowId), isNull(wf.deletedAt))).limit(1);
  return row ?? null;
}

app.post('/', requirePermission('tasks:create'), zValidator('json', createTriggerSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    if (!(await verifyWorkflow(db, data.workflowId))) return error.notFound(c, 'Workflow', data.workflowId);

    const id = generateId('trg');
    const now = new Date();
    await db.insert(t).values({
      id,
      workflowId: data.workflowId,
      name: data.name,
      category: data.category,
      config: (data.config ?? {}) as any,
      isEnabled: data.isEnabled ?? true,
      createdAt: now,
      updatedAt: now,
    });
    const [trigger] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'workflow_trigger',
      entityId: id,
      action: 'created',
      data: { id, workflowId: data.workflowId, category: data.category },
    });
    return success(c, trigger, 201);
  } catch (err) {
    console.error('[app-api/workflow-triggers] create failed:', err);
    return error.internal(c, 'Failed to create workflow trigger');
  }
});

app.post(
  '/entity',
  requirePermission('tasks:create'),
  zValidator(
    'json',
    z.object({
      workflowId: z.string(),
      name: z.string().optional(),
      entityType: z.string(),
      eventType: z.string(),
      filters: z.record(z.unknown()).optional(),
    }),
  ),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    try {
      if (!(await verifyWorkflow(db, data.workflowId))) return error.notFound(c, 'Workflow', data.workflowId);

      const id = generateId('trg');
      const now = new Date();
      await db.insert(t).values({
        id,
        workflowId: data.workflowId,
        name: data.name || 'Entity Event Trigger',
        category: 'entity_event',
        config: { entityType: data.entityType, eventType: data.eventType, filters: data.filters } as any,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      });
      const [trigger] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'workflow_trigger',
        entityId: id,
        action: 'created',
        data: { id, workflowId: data.workflowId, category: 'entity_event' },
      });
      return success(c, trigger, 201);
    } catch (err) {
      console.error('[app-api/workflow-triggers] create entity failed:', err);
      return error.internal(c, 'Failed to create entity trigger');
    }
  },
);

app.post(
  '/schedule',
  requirePermission('tasks:create'),
  zValidator(
    'json',
    z.object({
      workflowId: z.string(),
      name: z.string().optional(),
      cronExpression: z.string(),
      timezone: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
  ),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    try {
      if (!(await verifyWorkflow(db, data.workflowId))) return error.notFound(c, 'Workflow', data.workflowId);

      const triggerId = generateId('trg');
      const scheduleId = generateId('sched');
      const now = new Date();

      await db.insert(t).values({
        id: triggerId,
        workflowId: data.workflowId,
        name: data.name || 'Schedule Trigger',
        category: 'schedule',
        config: {
          cronExpression: data.cronExpression,
          timezone: data.timezone || 'UTC',
          startDate: data.startDate,
          endDate: data.endDate,
        } as any,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(ws).values({
        id: scheduleId,
        workflowId: data.workflowId,
        triggerId,
        name: data.name || 'Schedule',
        cronExpression: data.cronExpression,
        timezone: data.timezone || 'UTC',
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: data.endDate ? new Date(data.endDate) : undefined,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      });

      const [trigger] = await db.select().from(t).where(eq(t.id, triggerId)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'workflow_trigger',
        entityId: triggerId,
        action: 'created',
        data: { id: triggerId, workflowId: data.workflowId, category: 'schedule', scheduleId },
      });
      return success(c, trigger, 201);
    } catch (err) {
      console.error('[app-api/workflow-triggers] create schedule failed:', err);
      return error.internal(c, 'Failed to create schedule trigger');
    }
  },
);

for (const method of ['put', 'patch'] as const) {
  app[method]('/:id', requirePermission('tasks:update'), zValidator('json', updateTriggerSchema), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
      if (!existing) return error.notFound(c, 'Workflow trigger', id);

      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) update.name = data.name;
      if (data.category !== undefined) update.category = data.category;
      if (data.config !== undefined) update.config = data.config;
      if (data.isEnabled !== undefined) update.isEnabled = data.isEnabled;

      await db.update(t).set(update).where(eq(t.id, id));
      const [trigger] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'workflow_trigger',
        entityId: id,
        action: 'updated',
        data: { id, workflowId: existing.workflowId },
      });
      return success(c, trigger);
    } catch (err) {
      console.error('[app-api/workflow-triggers] update failed:', err);
      return error.internal(c, 'Failed to update workflow trigger');
    }
  });
}

async function setEnabled(c: any, id: string, enabled: boolean) {
  const db = c.get('tenantDb');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Workflow trigger', id);

    await db.update(t).set({ isEnabled: enabled, updatedAt: new Date() }).where(eq(t.id, id));
    const [trigger] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'workflow_trigger',
      entityId: id,
      action: 'updated',
      data: { id, workflowId: existing.workflowId, isEnabled: enabled },
    });
    return success(c, trigger);
  } catch (err) {
    console.error('[app-api/workflow-triggers] enable/disable failed:', err);
    return error.internal(c, 'Failed to toggle workflow trigger');
  }
}

app.patch('/:id/enable', requirePermission('tasks:update'), (c) => setEnabled(c, c.req.param('id'), true));
app.patch('/:id/disable', requirePermission('tasks:update'), (c) => setEnabled(c, c.req.param('id'), false));

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Workflow trigger', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'workflow_trigger',
      entityId: id,
      action: 'deleted',
      data: { id, workflowId: existing.workflowId },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/workflow-triggers] delete failed:', err);
    return error.internal(c, 'Failed to delete workflow trigger');
  }
});

export const workflowTriggersRoutes = app;
