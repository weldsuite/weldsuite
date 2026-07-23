/**
 * Workflow template routes — flat /api/workflow-templates/* surface.
 *
 * Permissions: tasks:read | tasks:create | tasks:update | tasks:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createTemplateSchema,
  updateTemplateSchema,
} from '@weldsuite/core-api-client/schemas/weldconnect';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as templates from '../../services/workflow-templates';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const result = await templates.listTemplates(db, {
      search: q.search,
      category: q.category,
      difficulty: q.difficulty,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit, 10) : 25,
    });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/workflow-templates] list failed:', err);
    return error.internal(c, 'Failed to list workflow templates');
  }
});

app.get('/categories', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    return success(c, await templates.getTemplateCategories(db));
  } catch (err) {
    console.error('[app-api/workflow-templates] categories failed:', err);
    return error.internal(c, 'Failed to get template categories');
  }
});

app.get('/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await templates.getTemplate(db, id);
    if (!row) return error.notFound(c, 'Workflow template', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/workflow-templates] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow template');
  }
});

app.post('/', requirePermission('tasks:create'), zValidator('json', createTemplateSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  try {
    const result = await templates.createTemplate(db, data, userId);
    publishEntityEvent({
      c,
      entityType: 'workflow_template',
      entityId: result.id,
      action: 'created',
      data: { id: result.id, name: data.name },
    });
    return success(c, result, 201);
  } catch (err) {
    console.error('[app-api/workflow-templates] create failed:', err);
    return error.internal(c, 'Failed to create workflow template');
  }
});

app.post('/from-workflow/:workflowId', requirePermission('tasks:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const workflowId = c.req.param('workflowId');
  const body = await c.req.json().catch(() => ({} as { name?: string; description?: string; category?: string }));
  try {
    const result = await templates.createTemplateFromWorkflow(db, workflowId, userId, body);
    if (!result) return error.notFound(c, 'Workflow', workflowId);
    publishEntityEvent({
      c,
      entityType: 'workflow_template',
      entityId: result.id,
      action: 'created',
      data: { id: result.id, fromWorkflow: workflowId },
    });
    return success(c, result, 201);
  } catch (err) {
    console.error('[app-api/workflow-templates] from-workflow failed:', err);
    return error.internal(c, 'Failed to create template from workflow');
  }
});

app.post('/:id/use', requirePermission('tasks:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({} as { name?: string; description?: string; activate?: boolean }));
  try {
    const result = await templates.useTemplate(db, id, userId, body);
    if (!result) return error.notFound(c, 'Workflow template', id);
    publishEntityEvent({
      c,
      entityType: 'workflow',
      entityId: result.id,
      action: 'created',
      data: { id: result.id, name: result.name, status: body?.activate ? 'active' : 'draft' },
    });
    return success(c, result, 201);
  } catch (err) {
    console.error('[app-api/workflow-templates] use failed:', err);
    return error.internal(c, 'Failed to use template');
  }
});

for (const method of ['put', 'patch'] as const) {
  app[method]('/:id', requirePermission('tasks:update'), zValidator('json', updateTemplateSchema), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const result = await templates.updateTemplate(db, id, data);
      if (!result) return error.notFound(c, 'Workflow template', id);
      publishEntityEvent({
        c,
        entityType: 'workflow_template',
        entityId: id,
        action: 'updated',
        data: { id },
      });
      return success(c, result);
    } catch (err) {
      console.error('[app-api/workflow-templates] update failed:', err);
      return error.internal(c, 'Failed to update workflow template');
    }
  });
}

app.delete('/:id', requirePermission('tasks:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await templates.getTemplate(db, id);
    if (!existing) return error.notFound(c, 'Workflow template', id);
    await templates.deleteTemplate(db, id);
    publishEntityEvent({
      c,
      entityType: 'workflow_template',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/workflow-templates] delete failed:', err);
    return error.internal(c, 'Failed to delete workflow template');
  }
});

export const workflowTemplatesRoutes = app;
