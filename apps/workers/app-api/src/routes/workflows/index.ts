/**
 * Workflow routes — flat /api/workflows/* surface backed by `workflows`.
 *
 * Permissions: workflows:read | workflows:create | workflows:update | workflows:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createWorkflowSchema,
  updateWorkflowSchema,
  updateWorkflowStatusSchema,
  triggerWorkflowSchema,
} from '@weldsuite/app-api-client/schemas/weldconnect';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as workflowsService from '../../services/workflows';
import { isSequenceWorkflow, validateWeldConnectWorkflow } from '../../services/weldconnect-mvp';
import { syncWorkflowPollIndex } from '../../lib/tenant-work-index';
import type { ScheduleIndexSync } from '../../lib/schedule-index';
import { registerGenerateWorkflowRoute } from './generate';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type WorkflowsContext = Context<{ Bindings: Env; Variables: Variables }>;

/** D1 schedule-index handle for keeping schedule triggers firing (see services/workflow-schedule-sync.ts). */
function scheduleSyncFor(c: WorkflowsContext): ScheduleIndexSync {
  return { d1: c.env.SCHEDULE_INDEX, workspaceId: c.get('workspaceId') };
}

/**
 * The WeldConnect MVP gate: a workflow may only go live with the supported
 * triggers/actions, fully configured (services/weldconnect-mvp.ts). Returns a
 * 400 response when it may not, `null` when it may. CRM sequences share this
 * table and route but are exempt.
 */
function rejectUnsupportedActivation(
  c: WorkflowsContext,
  workflow: { triggers?: unknown; steps?: unknown; tags?: unknown },
) {
  if (isSequenceWorkflow(workflow.tags)) return null;
  const issues = validateWeldConnectWorkflow(workflow);
  if (issues.length === 0) return null;
  return error.badRequest(c, 'This workflow cannot be activated: it uses unsupported or incomplete triggers or actions', {
    reason: 'weldconnect_unsupported',
    issues,
  });
}

// POST /generate — AI workflow generation (draft only, not persisted). See
// ./generate.ts. Registered first so its static path can't be shadowed by
// the param routes below (Hono's router prioritizes static paths regardless
// of registration order, but this keeps intent obvious).
registerGenerateWorkflowRoute(app);

app.get('/', requirePermission('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const result = await workflowsService.listWorkflows(db, {
      search: q.search,
      status: q.status,
      triggerType: q.triggerType,
      folderId: q.folderId,
      tags: q.tags,
      excludeTags: q.excludeTags,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit, 10) : 25,
    });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/workflows] list failed:', err);
    return error.internal(c, 'Failed to list workflows');
  }
});

app.get('/stats', requirePermission('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const stats = await workflowsService.getWorkflowStats(db);
    return success(c, stats);
  } catch (err) {
    console.error('[app-api/workflows] stats failed:', err);
    return error.internal(c, 'Failed to get workflow stats');
  }
});

app.get('/for-chaining', requirePermission('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const exclude = c.req.query('exclude');
  try {
    const rows = await workflowsService.listWorkflowsForChaining(db, exclude);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/workflows] for-chaining failed:', err);
    return error.internal(c, 'Failed to list workflows for chaining');
  }
});

app.get('/:id', requirePermission('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const workflow = await workflowsService.getWorkflow(db, id);
    if (!workflow) return error.notFound(c, 'Workflow', id);
    return success(c, workflow);
  } catch (err) {
    console.error('[app-api/workflows] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow');
  }
});

app.get('/:id/metrics', requirePermission('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const metrics = await workflowsService.getWorkflowMetrics(db, id);
    if (!metrics) return error.notFound(c, 'Workflow', id);
    return success(c, metrics);
  } catch (err) {
    console.error('[app-api/workflows] metrics failed:', err);
    return error.internal(c, 'Failed to get workflow metrics');
  }
});

app.post('/', requirePermission('workflows:create'), zValidator('json', createWorkflowSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  if (data.status === 'active') {
    const rejection = rejectUnsupportedActivation(c, data);
    if (rejection) return rejection;
  }
  try {
    const result = await workflowsService.createWorkflow(db, data, userId, scheduleSyncFor(c));
    await syncWorkflowPollIndex(c.env, db, c.get('workspaceId'));
    publishEntityEvent({
      c,
      entityType: 'workflow',
      entityId: result.id,
      action: 'created',
      data: { id: result.id, name: data.name },
    });
    return success(c, result, 201);
  } catch (err) {
    console.error('[app-api/workflows] create failed:', err);
    return error.internal(c, 'Failed to create workflow');
  }
});

for (const method of ['put', 'patch'] as const) {
  app[method]('/:id', requirePermission('workflows:update'), zValidator('json', updateWorkflowSchema), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json') as Record<string, unknown>;
    try {
      const existing = await workflowsService.getWorkflow(db, id);
      if (!existing) return error.notFound(c, 'Workflow', id);

      // Gate the result when it will be live: on activation, or when the
      // triggers/steps of an already-active workflow change. Metadata-only
      // edits (rename, folder) of an active workflow pass through.
      const nextStatus = (data.status as string | undefined) ?? existing.status;
      const activating = nextStatus === 'active' && existing.status !== 'active';
      const flowChanged = data.triggers !== undefined || data.steps !== undefined;
      if (nextStatus === 'active' && (activating || flowChanged)) {
        const rejection = rejectUnsupportedActivation(c, {
          triggers: data.triggers ?? existing.triggers,
          steps: data.steps ?? existing.steps,
          tags: data.tags ?? existing.tags,
        });
        if (rejection) return rejection;
      }

      const result = await workflowsService.updateWorkflow(db, id, data, scheduleSyncFor(c));
      if (!result) return error.notFound(c, 'Workflow', id);
      await syncWorkflowPollIndex(c.env, db, c.get('workspaceId'));
      const after = await workflowsService.getWorkflow(db, id);
      publishEntityEvent({
        c,
        entityType: 'workflow',
        entityId: id,
        action: 'updated',
        data: { id, name: after?.name ?? '', status: after?.status ?? null },
      });
      return success(c, result);
    } catch (err) {
      console.error('[app-api/workflows] update failed:', err);
      return error.internal(c, 'Failed to update workflow');
    }
  });
}

app.patch(
  '/:id/status',
  requirePermission('workflows:update'),
  zValidator('json', updateWorkflowStatusSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { status } = c.req.valid('json');
    try {
      if (status === 'active') {
        const existing = await workflowsService.getWorkflow(db, id);
        if (!existing) return error.notFound(c, 'Workflow', id);
        const rejection = rejectUnsupportedActivation(c, existing);
        if (rejection) return rejection;
      }
      const result = await workflowsService.updateWorkflowStatus(db, id, status, scheduleSyncFor(c));
      if (!result) return error.notFound(c, 'Workflow', id);
      await syncWorkflowPollIndex(c.env, db, c.get('workspaceId'));
      const after = await workflowsService.getWorkflow(db, id);
      publishEntityEvent({
        c,
        entityType: 'workflow',
        entityId: id,
        action: 'updated',
        data: { id, name: after?.name ?? '', status },
      });
      return success(c, result);
    } catch (err) {
      console.error('[app-api/workflows] status failed:', err);
      return error.internal(c, 'Failed to update workflow status');
    }
  },
);

app.post('/:id/duplicate', requirePermission('workflows:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({} as { name?: string }));
  try {
    const result = await workflowsService.duplicateWorkflow(db, id, userId, body.name);
    if (!result) return error.notFound(c, 'Workflow', id);
    const after = await workflowsService.getWorkflow(db, result.id);
    publishEntityEvent({
      c,
      entityType: 'workflow',
      entityId: result.id,
      action: 'created',
      data: { id: result.id, name: after?.name ?? '', status: after?.status ?? null },
    });
    return success(c, result, 201);
  } catch (err) {
    console.error('[app-api/workflows] duplicate failed:', err);
    return error.internal(c, 'Failed to duplicate workflow');
  }
});

app.delete('/:id', requirePermission('workflows:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await workflowsService.getWorkflow(db, id);
    if (!existing) return error.notFound(c, 'Workflow', id);
    await workflowsService.deleteWorkflow(db, id, scheduleSyncFor(c));
    await syncWorkflowPollIndex(c.env, db, c.get('workspaceId'));
    publishEntityEvent({
      c,
      entityType: 'workflow',
      entityId: id,
      action: 'deleted',
      data: { id, name: existing.name, status: existing.status },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/workflows] delete failed:', err);
    return error.internal(c, 'Failed to delete workflow');
  }
});

// POST /:id/test — fire a one-off test execution via the EXECUTE_WORKFLOW
// CF Workflow binding (class lives in apps/workers/workflow-worker, weldsuite-workflow,
// bound cross-worker via script_name).
app.post(
  '/:id/test',
  requirePermission('workflows:create'),
  zValidator('json', triggerWorkflowSchema),
  async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    if (!orgId) return error.badRequest(c, 'Organization context required');
    if (!c.env.EXECUTE_WORKFLOW) return error.internal(c, 'Workflow runtime not available');

    const id = c.req.param('id');
    const body = c.req.valid('json');
    const source = id.startsWith('hwf_') ? 'helpdesk' : 'task';

    try {
      const instance = await c.env.EXECUTE_WORKFLOW.create({
        params: {
          workspaceId: orgId,
          userId,
          workflowId: id,
          triggerType: 'manual' as const,
          triggerData: body.testData ?? body.data ?? {},
          source,
          // Lets the editor try a draft before publishing — the worker skips
          // runs of non-active workflows otherwise.
          isTest: true,
        },
      });
      return success(c, { executionId: instance.id, instanceId: instance.id });
    } catch (err) {
      console.error('[app-api/workflows] test failed:', err);
      return error.internal(c, 'Failed to test workflow');
    }
  },
);

// POST /:id/trigger — manual run via EXECUTE_WORKFLOW binding.
app.post(
  '/:id/trigger',
  requirePermission('workflows:create'),
  zValidator('json', triggerWorkflowSchema),
  async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    if (!orgId) return error.badRequest(c, 'Organization context required');
    if (!c.env.EXECUTE_WORKFLOW) return error.internal(c, 'Workflow runtime not available');

    const id = c.req.param('id');
    const body = c.req.valid('json');
    const source = id.startsWith('hwf_') ? 'helpdesk' : 'task';

    try {
      const instance = await c.env.EXECUTE_WORKFLOW.create({
        params: {
          workspaceId: orgId,
          userId,
          workflowId: id,
          triggerType: 'manual' as const,
          triggerData: body.data ?? body.testData ?? {},
          source,
        },
      });
      return success(c, { executionId: instance.id, instanceId: instance.id });
    } catch (err) {
      console.error('[app-api/workflows] trigger failed:', err);
      return error.internal(c, 'Failed to trigger workflow');
    }
  },
);

export const workflowsRoutes = app;
