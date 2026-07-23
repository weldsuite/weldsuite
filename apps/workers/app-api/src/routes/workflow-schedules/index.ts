/**
 * Workflow schedule routes — flat /api/workflow-schedules/* surface.
 *
 * Folds the legacy `schedules-with-trigger` operations from api-worker into
 * the canonical /api/workflow-schedules/:id endpoint — they were always the
 * same DB ops; the cron sweep in api-worker is what actually fires them.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createScheduleSchema,
  updateScheduleSchema,
} from '@weldsuite/core-api-client/schemas/weldconnect';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as schedules from '../../services/workflow-schedules';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const result = await schedules.listSchedules(db, {
      workflowId: q.workflowId,
      isEnabled: q.isEnabled !== undefined ? q.isEnabled === 'true' : undefined,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit, 10) : 25,
    });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/workflow-schedules] list failed:', err);
    return error.internal(c, 'Failed to list workflow schedules');
  }
});

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await schedules.getSchedule(db, id);
    if (!row) return error.notFound(c, 'Workflow schedule', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/workflow-schedules] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow schedule');
  }
});

app.post('/', requirePermission('tasks:create'), zValidator('json', createScheduleSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const sync = { d1: c.env.SCHEDULE_INDEX, workspaceId: c.get('workspaceId') };
  try {
    const result = await schedules.createSchedule(db, data, userId, sync);
    if ('error' in result) return error.notFound(c, 'Workflow', String(data.workflowId));
    publishEntityEvent({
      c,
      entityType: 'workflow_schedule',
      entityId: result.id,
      action: 'created',
      data: { id: result.id, workflowId: data.workflowId },
    });
    return success(c, result, 201);
  } catch (err) {
    console.error('[app-api/workflow-schedules] create failed:', err);
    return error.internal(c, 'Failed to create workflow schedule');
  }
});

for (const method of ['put', 'patch'] as const) {
  app[method]('/:id', requirePermission('tasks:update'), zValidator('json', updateScheduleSchema), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const sync = { d1: c.env.SCHEDULE_INDEX, workspaceId: c.get('workspaceId') };
    try {
      const result = await schedules.updateSchedule(db, id, data, sync);
      if (!result) return error.notFound(c, 'Workflow schedule', id);
      publishEntityEvent({
        c,
        entityType: 'workflow_schedule',
        entityId: id,
        action: 'updated',
        data: { id },
      });
      return success(c, result);
    } catch (err) {
      console.error('[app-api/workflow-schedules] update failed:', err);
      return error.internal(c, 'Failed to update workflow schedule');
    }
  });
}

app.patch(
  '/:id/toggle',
  requirePermission('tasks:update'),
  zValidator('json', z.object({ enabled: z.boolean() })),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { enabled } = c.req.valid('json');
    const sync = { d1: c.env.SCHEDULE_INDEX, workspaceId: c.get('workspaceId') };
    try {
      const result = await schedules.toggleSchedule(db, id, enabled, sync);
      if (!result) return error.notFound(c, 'Workflow schedule', id);
      publishEntityEvent({
        c,
        entityType: 'workflow_schedule',
        entityId: id,
        action: 'updated',
        data: { id, isEnabled: enabled },
      });
      return success(c, result);
    } catch (err) {
      console.error('[app-api/workflow-schedules] toggle failed:', err);
      return error.internal(c, 'Failed to toggle workflow schedule');
    }
  },
);

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const sync = { d1: c.env.SCHEDULE_INDEX, workspaceId: c.get('workspaceId') };
  try {
    const existing = await schedules.getSchedule(db, id);
    if (!existing) return error.notFound(c, 'Workflow schedule', id);
    await schedules.deleteSchedule(db, id, sync);
    publishEntityEvent({
      c,
      entityType: 'workflow_schedule',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/workflow-schedules] delete failed:', err);
    return error.internal(c, 'Failed to delete workflow schedule');
  }
});

export const workflowSchedulesRoutes = app;
