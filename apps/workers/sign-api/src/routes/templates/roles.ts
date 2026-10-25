/**
 * Roles of a template — /api/sign/templates/:id/roles/*.
 *
 *   POST   /          → add a role ({ roleName, role?, routingOrder?, authMode?, locale?, name?, email? })
 *   PATCH  /:roleId   → change it
 *   DELETE /:roleId   → remove it and its fields
 *
 * Role names are unique per template. A template never holds an access code:
 * a role with `access_code` gets one when the template is used.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { noContent, success } from '@weldsuite/worker-kit/response';
import { createTemplateRoleSchema, updateTemplateRoleSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { toRecipientDto, touchEnvelope } from '../../services/envelopes';
import { removeRecipient } from '../../services/recipients';
import { addRole, loadTemplate, updateRole } from '../../services/templates';
import { handle } from '../envelopes/shared';
import { publishTemplateUpdated } from './shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', requirePermission('sign_templates:update'), zValidator('json', createTemplateRoleSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const template = await loadTemplate(db, c.req.param('id')!);
    const role = await addRole(db, template.id, c.req.valid('json'));
    await touchEnvelope(db, template.id);
    publishTemplateUpdated(c, template);
    return success(c, toRecipientDto(role), 201);
  }),
);

app.patch('/:roleId', requirePermission('sign_templates:update'), zValidator('json', updateTemplateRoleSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const template = await loadTemplate(db, c.req.param('id')!);
    const role = await updateRole(db, template.id, c.req.param('roleId'), c.req.valid('json'));
    await touchEnvelope(db, template.id);
    publishTemplateUpdated(c, template);
    return success(c, toRecipientDto(role));
  }),
);

app.delete('/:roleId', requirePermission('sign_templates:update'), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const template = await loadTemplate(db, c.req.param('id')!);
    await removeRecipient(db, template.id, c.req.param('roleId'));
    await touchEnvelope(db, template.id);
    publishTemplateUpdated(c, template);
    return noContent(c);
  }),
);

export default app;
