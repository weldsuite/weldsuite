/**
 * Workflow execution routes — flat /api/workflow-executions/* surface.
 *
 * Permissions: workflow-executions:read | workflow-executions:update;
 * workflows:create | workflows:delete for trigger/delete operations. Deciding
 * an approval takes being one of its approvers, or `workflow-executions:update`
 * when it lists none.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createWorkflowExecutionSchema,
  updateWorkflowExecutionSchema,
} from '@weldsuite/core-api-client/schemas/workflow-executions';
import { approvalDecisionSchema } from '@weldsuite/app-api-client/schemas/weldconnect';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { eq } from 'drizzle-orm';
import * as executions from '../../services/workflow-executions';
import * as approvals from '../../services/workflow-approvals';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.workflowExecutions;

app.get('/', requirePermission('workflow-executions:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const result = await executions.listExecutions(db, {
      workflowId: q.workflowId,
      status: q.status,
      triggerType: q.triggerType,
      startDate: q.startDate,
      endDate: q.endDate,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit, 10) : 25,
    });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/workflow-executions] list failed:', err);
    return error.internal(c, 'Failed to list workflow executions');
  }
});

app.get('/recent', requirePermission('workflow-executions:read'), async (c) => {
  const db = c.get('tenantDb');
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 10;
  try {
    return success(c, await executions.getRecentExecutions(db, limit));
  } catch (err) {
    console.error('[app-api/workflow-executions] recent failed:', err);
    return error.internal(c, 'Failed to fetch recent executions');
  }
});

app.get('/trends', requirePermission('workflow-executions:read'), async (c) => {
  const db = c.get('tenantDb');
  const period = c.req.query('period') ?? 'week';
  try {
    const trends = await executions.getExecutionTrends(db, period);
    return success(c, { trends });
  } catch (err) {
    console.error('[app-api/workflow-executions] trends failed:', err);
    return error.internal(c, 'Failed to fetch execution trends');
  }
});

app.get('/slow', requirePermission('workflow-executions:read'), async (c) => {
  const db = c.get('tenantDb');
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 10;
  try {
    return success(c, await executions.getSlowExecutions(db, limit));
  } catch (err) {
    console.error('[app-api/workflow-executions] slow failed:', err);
    return error.internal(c, 'Failed to fetch slow executions');
  }
});

app.get('/:id', requirePermission('workflow-executions:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await executions.getExecution(db, id);
    if (!row) return error.notFound(c, 'Workflow execution', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/workflow-executions] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow execution');
  }
});

app.get('/:id/steps', requirePermission('workflow-executions:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    return success(c, await executions.getExecutionSteps(db, id));
  } catch (err) {
    console.error('[app-api/workflow-executions] steps failed:', err);
    return error.internal(c, 'Failed to fetch execution steps');
  }
});

app.get('/:id/logs', requirePermission('workflow-executions:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    return success(c, await executions.getExecutionLogs(db, id));
  } catch (err) {
    console.error('[app-api/workflow-executions] logs failed:', err);
    return error.internal(c, 'Failed to fetch execution logs');
  }
});

app.patch('/:id/cancel', requirePermission('workflow-executions:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const result = await executions.cancelExecution(db, id, c.env.EXECUTE_WORKFLOW);
    if (result.kind === 'not_found') return error.notFound(c, 'Workflow execution', id);
    if (result.kind === 'not_cancellable') {
      return error.badRequest(c, `A ${result.status} run can no longer be cancelled`, {
        reason: 'not_cancellable',
        status: result.status,
      });
    }
    publishEntityEvent({
      c,
      entityType: 'workflow_execution',
      entityId: id,
      action: 'cancelled',
      data: { id, workflowId: result.workflowId, status: 'cancelled' },
    });
    return success(c, { id: result.id, status: result.status });
  } catch (err) {
    console.error('[app-api/workflow-executions] cancel failed:', err);
    return error.internal(c, 'Failed to cancel execution');
  }
});

// GET /:id/approval — the approval step the run is waiting on (null when none)
// and whether the caller may decide it. See services/workflow-approvals.ts.
app.get('/:id/approval', requirePermission('workflow-executions:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const execution = await executions.getExecution(db, id);
    if (!execution) return error.notFound(c, 'Workflow execution', id);
    const approval = execution.status === 'waiting_for_input' ? await approvals.getPendingApproval(db, id) : null;
    const mayUpdateRuns = approval ? await hasContextPermission(c, 'workflow-executions:update') : false;
    return success(c, {
      approval: approval
        ? {
            stepId: approval.stepId,
            title: approval.title,
            description: approval.description,
            approverIds: approval.approverIds,
          }
        : null,
      canDecide: approval ? approvals.canDecide(approval, c.get('userId'), mayUpdateRuns) : false,
    });
  } catch (err) {
    console.error('[app-api/workflow-executions] approval failed:', err);
    return error.internal(c, 'Failed to fetch the approval');
  }
});

// POST /:id/decision — approve or reject the approval step the run waits on,
// and resume the run (sends the CF Workflow `resume-step` event).
app.post(
  '/:id/decision',
  requirePermission('workflow-executions:read'),
  zValidator('json', approvalDecisionSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const body = c.req.valid('json');
    try {
      const result = await approvals.decideApproval(db, c.env.EXECUTE_WORKFLOW, {
        executionId: id,
        userId: c.get('userId'),
        decision: body.decision,
        comment: body.comment,
        mayUpdateRuns: await hasContextPermission(c, 'workflow-executions:update'),
      });
      switch (result.kind) {
        case 'not_found':
          return error.notFound(c, 'Workflow execution', id);
        case 'not_waiting':
          return error.badRequest(c, 'This run is not waiting for an approval', {
            reason: 'not_waiting',
            status: result.status,
          });
        case 'forbidden':
          return error.forbidden(c, 'You are not an approver of this step');
        case 'already_decided':
          return error.conflict(c, 'Someone already decided on this approval');
        case 'runtime_unavailable':
          return error.internal(c, 'Workflow runtime not available');
        default:
          break;
      }
      // The decision moves the run on: waiting → running.
      publishEntityEvent({
        c,
        entityType: 'workflow_execution',
        entityId: id,
        action: 'updated',
        data: { id, workflowId: result.workflowId, status: 'running' },
      });
      return success(c, result.payload);
    } catch (err) {
      console.error('[app-api/workflow-executions] decision failed:', err);
      return error.internal(c, 'Failed to record the decision');
    }
  },
);

app.post('/:id/retry', requirePermission('workflows:create'), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return error.badRequest(c, 'Organization context required');
  if (!c.env.EXECUTE_WORKFLOW) return error.internal(c, 'Workflow runtime not available');

  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const result = await executions.retryExecution(db, id, orgId, userId, c.env.EXECUTE_WORKFLOW);
    if (result.kind === 'not_found') return error.notFound(c, 'Execution', id);
    if (result.kind === 'not_failed') return error.badRequest(c, 'Only failed executions can be retried');
    if (result.kind === 'workflow_missing') return error.notFound(c, 'Workflow', result.workflowId);
    if (result.kind === 'workflow_inactive') {
      return error.badRequest(c, 'This workflow is not active, so the run would not start. Activate it first.', {
        reason: 'workflow_inactive',
        workflowId: result.workflowId,
        status: result.status,
      });
    }

    publishEntityEvent({
      c,
      entityType: 'workflow_execution',
      entityId: result.id,
      action: 'created',
      data: { id: result.id, workflowId: '', status: 'queued' },
    });
    return success(
      c,
      { id: result.id, executionId: result.executionId, instanceId: result.instanceId, retryOf: result.retryOf },
      201,
    );
  } catch (err) {
    console.error('[app-api/workflow-executions] retry failed:', err);
    return error.internal(c, 'Failed to retry execution');
  }
});

app.post('/', requirePermission('workflows:create'), zValidator('json', createWorkflowExecutionSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('wfex');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'workflow_execution',
      entityId: id,
      action: 'created',
      data: { id, workflowId: data.workflowId ?? '', status: data.status ?? 'queued' },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/workflow-executions] create failed:', err);
    return error.internal(c, 'Failed to create workflow execution');
  }
});

app.patch('/:id', requirePermission('workflow-executions:update'), zValidator('json', updateWorkflowExecutionSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Workflow execution', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'workflow_execution',
      entityId: id,
      action: 'updated',
      data: { id, workflowId: existing.workflowId, status: data.status ?? existing.status },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/workflow-executions] update failed:', err);
    return error.internal(c, 'Failed to update workflow execution');
  }
});

app.delete('/:id', requirePermission('workflows:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Workflow execution', id);
    await db.delete(t).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'workflow_execution',
      entityId: id,
      action: 'deleted',
      data: { id, workflowId: existing.workflowId },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/workflow-executions] delete failed:', err);
    return error.internal(c, 'Failed to delete workflow execution');
  }
});

export const workflowExecutionsRoutes = app;
