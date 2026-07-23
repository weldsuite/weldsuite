/**
 * Mail template routes — /api/mail-templates/*.
 *
 * CRUD plus three extras kept from the legacy api-worker surface:
 *   - GET /categories — distinct values of the `category` column.
 *   - POST /:id/duplicate — clone with `(Copy)` suffix.
 *   - POST /:id/render — `{{var}}` substitution, HTML-escapes into htmlContent.
 *
 * Entity events: `email_template:created | updated | deleted` (the
 * catalog uses `email_template`, not `mail_template`).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as templates from '../../services/mail/templates';
import { MailTemplateError } from '../../services/mail/templates';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const typeEnum = z.enum(['marketing', 'transactional', 'notification', 'newsletter', 'welcome', 'custom']);

const listQuery = z.object({
  type: typeEnum.optional(),
  category: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const variableSchema = z.object({
  name: z.string(),
  type: z.enum(['text', 'number', 'date', 'boolean', 'list']),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  description: z.string().optional(),
});

const baseBody = {
  name: z.string().min(1).max(255),
  subject: z.string().min(1).max(998),
  htmlContent: z.string().min(1),
  textContent: z.string().optional(),
  category: z.string().max(100).optional(),
  description: z.string().optional(),
  type: typeEnum.optional(),
  purpose: z.string().max(255).optional(),
  variables: z.array(variableSchema).optional(),
  requiredVariables: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
} as const;

const createBody = z.object(baseBody);
const updateBody = z.object(baseBody).partial();

const renderBody = z.object({ variables: z.record(z.unknown()) });

function mapTemplateError(c: Parameters<typeof error.badRequest>[0], err: MailTemplateError) {
  switch (err.code) {
    case 'NOT_FOUND':
      return error.notFound(c, 'Template');
    case 'MISSING_VARIABLES':
      return error.badRequest(c, err.message, err.details);
  }
}

// Static paths first so the /:id catch-all can't shadow them.
app.get('/categories', requirePermission('templates:read'), async (c) => {
  try {
    const rows = await templates.listTemplateCategories(c.get('tenantDb'));
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/mail-templates] categories failed:', err);
    return error.internal(c, 'Failed to fetch template categories');
  }
});

app.get('/', requirePermission('templates:read'), zValidator('query', listQuery), async (c) => {
  try {
    const result = await templates.listTemplates(c.get('tenantDb'), c.req.valid('query'));
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/mail-templates] list failed:', err);
    return error.internal(c, 'Failed to list templates');
  }
});

app.get('/:id', requirePermission('templates:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await templates.getTemplate(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Template', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-templates] get failed:', err);
    return error.internal(c, 'Failed to fetch template');
  }
});

app.post('/', requirePermission('templates:create'), zValidator('json', createBody), async (c) => {
  try {
    const row = await templates.createTemplate(c.get('tenantDb'), c.req.valid('json'));
    publishEntityEvent({
      c,
      entityType: 'email_template',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, name: row.name, type: row.type },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/mail-templates] create failed:', err);
    return error.internal(c, 'Failed to create template');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  try {
    const result = await templates.updateTemplate(c.get('tenantDb'), id, data);
    publishEntityEvent({
      c,
      entityType: 'email_template',
      entityId: id,
      action: 'updated',
      data: { id, name: result.after.name, type: result.after.type },
    });
    return success(c, result.after);
  } catch (err) {
    if (err instanceof MailTemplateError) return mapTemplateError(c, err);
    console.error('[app-api/mail-templates] update failed:', err);
    return error.internal(c, 'Failed to update template');
  }
};

app.put('/:id', requirePermission('templates:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('templates:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('templates:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const deleted = await templates.softDeleteTemplate(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'Template', id);
    publishEntityEvent({
      c,
      entityType: 'email_template',
      entityId: id,
      action: 'deleted',
      data: { id, name: deleted.name, type: deleted.type },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-templates] delete failed:', err);
    return error.internal(c, 'Failed to delete template');
  }
});

app.post('/:id/duplicate', requirePermission('templates:create'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await templates.duplicateTemplate(c.get('tenantDb'), id);
    publishEntityEvent({
      c,
      entityType: 'email_template',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, name: row.name, type: row.type },
    });
    return success(c, row, 201);
  } catch (err) {
    if (err instanceof MailTemplateError) return mapTemplateError(c, err);
    console.error('[app-api/mail-templates] duplicate failed:', err);
    return error.internal(c, 'Failed to duplicate template');
  }
});

app.post(
  '/:id/render',
  requirePermission('templates:read'),
  zValidator('json', renderBody),
  async (c) => {
    const id = c.req.param('id');
    const { variables } = c.req.valid('json');
    try {
      const result = await templates.renderTemplate(c.get('tenantDb'), id, variables);
      return success(c, result);
    } catch (err) {
      if (err instanceof MailTemplateError) return mapTemplateError(c, err);
      console.error('[app-api/mail-templates] render failed:', err);
      return error.internal(c, 'Failed to render template');
    }
  },
);

export const mailTemplatesRoutes = app;
