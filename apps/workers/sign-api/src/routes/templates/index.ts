/**
 * Template routes — /api/sign/templates/*.
 *
 * Templates belong to the workspace: `sign_templates:read` sees them all,
 * `:create` / `:update` / `:delete` change them. The detail has the editor's
 * envelope shape (`kind: 'template'`), with the roles as its recipients.
 *
 *   GET    /                  → list (search, cursor)
 *   POST   /                  → new template
 *   GET    /:id               → the template with documents, roles and fields
 *   PATCH  /:id               → settings (title, message, signing order, reminders)
 *   DELETE /:id               → delete it and its files (requests made from it keep theirs)
 *   POST   /:id/use           → a new draft request with a person in every role
 *                               (`sign_envelopes:create` and `sign_templates:read`)
 *
 * Documents and fields: the draft routes, scoped to templates. Roles: ./roles.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createTemplateSchema,
  listTemplatesQuerySchema,
  updateTemplateSchema,
  useTemplateSchema,
} from '@weldsuite/app-api-client/schemas/weldsign';
import type { SignEnvelope } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { memberProfile, updateEnvelope } from '@weldsuite/sign-domain/envelopes';
import { loadSignSettings } from '@weldsuite/sign-domain/settings';
import { createTemplate, deleteTemplate, getTemplateDetail, listTemplates, loadTemplate, useTemplate } from '@weldsuite/sign-domain/templates';
import type { DraftScope } from '../draft-scope';
import { createDocumentsRoutes } from '../envelopes/documents';
import { createFieldsRoutes } from '../envelopes/fields';
import { detailFor, envelopeEventData, handle, type Ctx } from '../envelopes/shared';
import rolesRoutes from './roles';
import { publishTemplateUpdated, templateEventData } from './shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_LIMIT = 50;

const templateScope: DraftScope = {
  read: 'sign_templates:read',
  update: 'sign_templates:update',
  loadEditable: (c) => loadTemplate(c.get('tenantDb'), c.req.param('id')!),
  loadReadable: (c) => loadTemplate(c.get('tenantDb'), c.req.param('id')!),
  changed: publishTemplateUpdated,
};

async function templateDetail(c: Ctx, template: SignEnvelope) {
  const canEdit = !c.get('readOnly') && (await hasContextPermission(c, 'sign_templates:update'));
  return getTemplateDetail(c.get('tenantDb'), template, canEdit);
}

app.get('/', requirePermission('sign_templates:read'), zValidator('query', listTemplatesQuerySchema), async (c) => {
  const { search, limit = DEFAULT_LIMIT, cursor } = c.req.valid('query');
  const offset = cursor ? Number(cursor) : 0;
  const { rows, total } = await listTemplates(c.get('tenantDb'), { search, limit, offset });
  const next = offset + rows.length;
  return list(c, rows, cursorPagination(total, next < total, next < total ? String(next) : null));
});

app.post('/', requirePermission('sign_templates:create'), zValidator('json', createTemplateSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const db = c.get('tenantDb');
  const [profile, settings] = await Promise.all([memberProfile(db, userId), loadSignSettings(db)]);
  const template = await createTemplate(db, c.req.valid('json'), { userId, ...profile }, settings);
  publishEntityEvent({ c, entityType: 'sign_template', entityId: template.id, action: 'created', data: templateEventData(template) });
  return success(c, await templateDetail(c, template), 201);
});

app.get('/:id', requirePermission('sign_templates:read'), (c) =>
  handle(c, async () => success(c, await templateDetail(c, await loadTemplate(c.get('tenantDb'), c.req.param('id'))))),
);

app.patch('/:id', requirePermission('sign_templates:update'), zValidator('json', updateTemplateSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const template = await loadTemplate(db, c.req.param('id'));
    const updated = await updateEnvelope(db, template, c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'sign_template', entityId: updated.id, action: 'updated', data: templateEventData(updated) });
    return success(c, await templateDetail(c, updated));
  }),
);

app.delete('/:id', requirePermission('sign_templates:delete'), (c) =>
  handle(c, async () => {
    const template = await loadTemplate(c.get('tenantDb'), c.req.param('id'));
    const keys = await deleteTemplate(c.get('tenantDb'), template);
    if (keys.length) c.executionCtx.waitUntil(c.env.PRIVATE_STORAGE.delete(keys));
    publishEntityEvent({ c, entityType: 'sign_template', entityId: template.id, action: 'deleted', data: templateEventData(template) });
    return noContent(c);
  }),
);

app.post(
  '/:id/use',
  requirePermission('sign_envelopes:create'),
  requirePermission('sign_templates:read'),
  zValidator('json', useTemplateSchema),
  (c) =>
    handle(c, async () => {
      const userId = c.get('userId');
      const orgId = c.get('workspaceId');
      if (!userId) return error.unauthorized(c);
      if (!orgId) return error.orgRequired(c);
      const db = c.get('tenantDb');
      const template = await loadTemplate(db, c.req.param('id'));
      const draft = await useTemplate(
        { db, bucket: c.env.PRIVATE_STORAGE, orgId, secret: c.env.SIGN_SESSION_SECRET },
        template,
        c.req.valid('json'),
        { userId, ...(await memberProfile(db, userId)) },
      );
      publishEntityEvent({
        c,
        entityType: 'sign_envelope',
        entityId: draft.id,
        action: 'created',
        data: { ...envelopeEventData(draft), templateId: template.id },
      });
      return success(c, await detailFor(c, draft), 201);
    }),
);

app.route('/:id/documents', createDocumentsRoutes(templateScope));
app.route('/:id/roles', rolesRoutes);
app.route('/:id/fields', createFieldsRoutes(templateScope));

export default app;
