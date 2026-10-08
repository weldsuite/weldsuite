/**
 * Workflow template routes — flat /api/workflow-templates/* surface.
 *
 * The gallery lists the built-in starter templates (ids `builtin_*`, code in
 * `@weldsuite/app-api-client/schemas/weldconnect-templates`, read-only) next to
 * the workspace's own `workflow_templates` rows. `?locale=nl` (and `locale` in
 * the "use" body) picks the language of the built-ins.
 *
 * Permissions: workflow-templates:read | workflow-templates:create |
 * workflow-templates:update | workflow-templates:delete. POST /:id/use needs
 * workflow-templates:read + workflows:create (it creates a workflow, not a
 * template).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTemplateSchema, updateTemplateSchema } from '@weldsuite/app-api-client/schemas/weldconnect';
import {
  createFromTemplateSchema,
  isBuiltInTemplateId,
  saveWorkflowAsTemplateSchema,
} from '@weldsuite/app-api-client/schemas/weldconnect-templates';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import * as templates from '../../services/workflow-templates';
import { scheduleSyncFor, webhookSyncFor } from '../workflows/index';
import { syncWorkflowPollIndex } from '../../lib/tenant-work-index';
import { parseLimit } from '../../lib/query-params';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const BUILT_IN_READ_ONLY = 'Built-in templates cannot be changed. Use the template to make your own copy.';

app.get('/', requirePermission('workflow-templates:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const result = await templates.listTemplates(db, {
      search: q.search,
      category: q.category,
      source: q.source,
      locale: q.locale,
      cursor: q.cursor,
      limit: parseLimit(q.limit, 25, 100),
    });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[connect-api/workflow-templates] list failed:', err);
    return error.internal(c, 'Failed to list workflow templates');
  }
});

app.get('/categories', requirePermission('workflow-templates:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    return success(c, await templates.getTemplateCategories(db));
  } catch (err) {
    console.error('[connect-api/workflow-templates] categories failed:', err);
    return error.internal(c, 'Failed to get template categories');
  }
});

app.get('/:id', requirePermission('workflow-templates:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const template = await templates.getTemplate(db, id, c.req.query('locale'));
    if (!template) return error.notFound(c, 'Workflow template', id);
    return success(c, template);
  } catch (err) {
    console.error('[connect-api/workflow-templates] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow template');
  }
});

app.post('/', requirePermission('workflow-templates:create'), zValidator('json', createTemplateSchema), async (c) => {
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
    console.error('[connect-api/workflow-templates] create failed:', err);
    return error.internal(c, 'Failed to create workflow template');
  }
});

// "Save as template" from a workflow (settings page).
app.post(
  '/from-workflow/:workflowId',
  requirePermission('workflow-templates:create'),
  requirePermission('workflows:read'),
  zValidator('json', saveWorkflowAsTemplateSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const workflowId = c.req.param('workflowId');
    const body = c.req.valid('json');
    try {
      const result = await templates.createTemplateFromWorkflow(db, workflowId, userId, body);
      if (!result) return error.notFound(c, 'Workflow', workflowId);
      publishEntityEvent({
        c,
        entityType: 'workflow_template',
        entityId: result.id,
        action: 'created',
        data: { id: result.id, name: result.name, fromWorkflow: workflowId },
      });
      return success(c, result, 201);
    } catch (err) {
      if (err instanceof templates.SequenceTemplateError) return error.badRequest(c, err.message);
      console.error('[connect-api/workflow-templates] from-workflow failed:', err);
      return error.internal(c, 'Failed to create template from workflow');
    }
  },
);

// "Use template": a new draft workflow, opened in the editor by the client.
app.post(
  '/:id/use',
  requirePermission('workflow-templates:read'),
  requirePermission('workflows:create'),
  zValidator('json', createFromTemplateSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = c.req.valid('json');
    try {
      const result = await templates.createWorkflowFromTemplate(db, id, userId, {
        ...body,
        scheduleSync: scheduleSyncFor(c),
        webhookSync: webhookSyncFor(c),
      });
      if (!result) return error.notFound(c, 'Workflow template', id);
      await syncWorkflowPollIndex(c.env, db, c.get('workspaceId'));
      publishEntityEvent({
        c,
        entityType: 'workflow',
        entityId: result.id,
        action: 'created',
        data: { id: result.id, name: result.name, status: 'draft' },
      });
      return success(c, result, 201);
    } catch (err) {
      console.error('[connect-api/workflow-templates] use failed:', err);
      return error.internal(c, 'Failed to use template');
    }
  },
);

for (const method of ['put', 'patch'] as const) {
  app[method]('/:id', requirePermission('workflow-templates:update'), zValidator('json', updateTemplateSchema), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    if (isBuiltInTemplateId(id)) return error.forbidden(c, BUILT_IN_READ_ONLY);
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
      console.error('[connect-api/workflow-templates] update failed:', err);
      return error.internal(c, 'Failed to update workflow template');
    }
  });
}

app.delete('/:id', requirePermission('workflow-templates:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (isBuiltInTemplateId(id)) return error.forbidden(c, BUILT_IN_READ_ONLY);
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
    console.error('[connect-api/workflow-templates] delete failed:', err);
    return error.internal(c, 'Failed to delete workflow template');
  }
});

export const workflowTemplatesRoutes = app;
