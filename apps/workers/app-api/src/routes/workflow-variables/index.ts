/**
 * Workflow variable routes — flat /api/workflow-variables/* surface.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createVariableSchema,
  updateVariableSchema,
} from '@weldsuite/core-api-client/schemas/weldconnect';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as variables from '../../services/workflow-variables';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const result = await variables.listVariables(db, {
      search: q.search,
      workflowId: q.workflowId,
      scope: q.scope,
      isSecret: q.isSecret !== undefined ? q.isSecret === 'true' : undefined,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit, 10) : 25,
    });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/workflow-variables] list failed:', err);
    return error.internal(c, 'Failed to list workflow variables');
  }
});

app.get('/global', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    return success(c, await variables.getGlobalVariables(db));
  } catch (err) {
    console.error('[app-api/workflow-variables] global failed:', err);
    return error.internal(c, 'Failed to fetch global variables');
  }
});

app.get('/workflow/:workflowId', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const workflowId = c.req.param('workflowId');
  try {
    return success(c, await variables.getWorkflowVariables(db, workflowId));
  } catch (err) {
    console.error('[app-api/workflow-variables] workflow failed:', err);
    return success(c, []);
  }
});

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await variables.getVariable(db, id);
    if (!row) return error.notFound(c, 'Workflow variable', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/workflow-variables] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow variable');
  }
});

app.post('/', requirePermission('tasks:create'), zValidator('json', createVariableSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  try {
    const result = await variables.createVariable(db, data, userId);
    publishEntityEvent({
      c,
      entityType: 'workflow_variable',
      entityId: result.id,
      action: 'created',
      data: { id: result.id, name: data.name },
    });
    return success(c, result, 201);
  } catch (err) {
    console.error('[app-api/workflow-variables] create failed:', err);
    return error.internal(c, 'Failed to create workflow variable');
  }
});

for (const method of ['put', 'patch'] as const) {
  app[method]('/:id', requirePermission('tasks:update'), zValidator('json', updateVariableSchema), async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const result = await variables.updateVariable(db, id, data, userId);
      if (!result) return error.notFound(c, 'Workflow variable', id);
      publishEntityEvent({
        c,
        entityType: 'workflow_variable',
        entityId: id,
        action: 'updated',
        data: { id },
      });
      return success(c, result);
    } catch (err) {
      console.error('[app-api/workflow-variables] update failed:', err);
      return error.internal(c, 'Failed to update workflow variable');
    }
  });
}

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await variables.getVariable(db, id);
    if (!existing) return error.notFound(c, 'Workflow variable', id);
    await variables.deleteVariable(db, id);
    publishEntityEvent({
      c,
      entityType: 'workflow_variable',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/workflow-variables] delete failed:', err);
    return error.internal(c, 'Failed to delete workflow variable');
  }
});

export const workflowVariablesRoutes = app;
