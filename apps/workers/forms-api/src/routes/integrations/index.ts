/**
 * Integration routes — mounted at /api/forms/forms, under a form:
 *
 *   GET    /:id/integrations                          → the form's integrations
 *   POST   /:id/integrations                          → add one (crm | desk | flow)
 *   PATCH  /:id/integrations/:integrationId           → switch it on or off, or change its settings
 *   DELETE /:id/integrations/:integrationId           → remove it (earlier runs stay on their responses)
 *   POST   /:id/integrations/:integrationId/test      → a dry run against the latest completed response
 *
 * Changing an integration needs `forms:update` and the right to edit the form;
 * the steps then act as the member who last changed its settings (ADR FORMS-006).
 * The test also needs the right to read the form's responses: it shows one.
 * 422 `INVALID_CONFIG` (`details.fields`) when the settings do not fit the form.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { noContent, success } from '@weldsuite/worker-kit/response';
import { formIntegrationInputSchema, updateFormIntegrationSchema } from '@weldsuite/app-api-client/schemas/weldforms';
import { handle } from '../../lib/errors';
import { supportEventData } from '../../services/events';
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  presentIntegration,
  updateIntegration,
} from '../../services/integrations';
import { testIntegration } from '../../services/integration-test';
import type { Env, Variables } from '../../types';
import { loadForm } from '../forms/shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:id/integrations', requirePermission('forms:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'));
    return success(c, await listIntegrations(loaded.ctx, loaded.form.id));
  }),
);

app.post('/:id/integrations', requirePermission('forms:update'), zValidator('json', formIntegrationInputSchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'edit');
    const row = await createIntegration(loaded.ctx, loaded.form, loaded.userId, c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'form_integration', entityId: row.id, action: 'created', data: supportEventData({ id: row.id, name: row.kind }) });
    return success(c, await presentIntegration(loaded.ctx, row), 201);
  }),
);

app.patch('/:id/integrations/:integrationId', requirePermission('forms:update'), zValidator('json', updateFormIntegrationSchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'edit');
    const current = await getIntegration(loaded.ctx, loaded.form.id, c.req.param('integrationId'));
    const row = await updateIntegration(loaded.ctx, loaded.form, current, loaded.userId, c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'form_integration', entityId: row.id, action: 'updated', data: supportEventData({ id: row.id, name: row.kind }) });
    return success(c, await presentIntegration(loaded.ctx, row));
  }),
);

app.delete('/:id/integrations/:integrationId', requirePermission('forms:update'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'edit');
    const row = await getIntegration(loaded.ctx, loaded.form.id, c.req.param('integrationId'));
    await deleteIntegration(loaded.ctx, row);
    publishEntityEvent({ c, entityType: 'form_integration', entityId: row.id, action: 'deleted', data: supportEventData({ id: row.id, name: row.kind }) });
    return noContent(c);
  }),
);

// The dry run renders the settings against the latest response (the ticket's
// subject, the respondent's address), so it also takes the right to read answers.
app.post('/:id/integrations/:integrationId/test', requirePermission('forms:update'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), ['edit', 'readResponses']);
    const row = await getIntegration(loaded.ctx, loaded.form.id, c.req.param('integrationId'));
    return success(c, await testIntegration(loaded.ctx, row));
  }),
);

export default app;
