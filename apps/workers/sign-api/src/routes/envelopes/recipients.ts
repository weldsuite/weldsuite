/**
 * Recipients of a draft — /api/sign/envelopes/:id/recipients/*.
 *
 *   POST   /                → add a signer or copy recipient
 *   PATCH  /:recipientId    → change them (role, order, auth mode, …)
 *   DELETE /:recipientId    → remove them and their fields
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { noContent, success } from '@weldsuite/worker-kit/response';
import { createRecipientSchema, updateRecipientSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { loadDraft, toRecipientDto, touchEnvelope } from '../../services/envelopes';
import { addRecipient, removeRecipient, updateRecipient } from '../../services/recipients';
import { handle, publishEnvelopeUpdated, viewerOf } from './shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', requirePermission('sign_envelopes:update'), zValidator('json', createRecipientSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadDraft(db, c.req.param('id')!, await viewerOf(c));
    const recipient = await addRecipient(db, envelope.id, c.req.valid('json'), 'en', c.env.SIGN_SESSION_SECRET);
    await touchEnvelope(db, envelope.id);
    publishEnvelopeUpdated(c, envelope);
    return success(c, toRecipientDto(recipient), 201);
  }),
);

app.patch('/:recipientId', requirePermission('sign_envelopes:update'), zValidator('json', updateRecipientSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadDraft(db, c.req.param('id')!, await viewerOf(c));
    const recipient = await updateRecipient(db, envelope.id, c.req.param('recipientId'), c.req.valid('json'), c.env.SIGN_SESSION_SECRET);
    await touchEnvelope(db, envelope.id);
    publishEnvelopeUpdated(c, envelope);
    return success(c, toRecipientDto(recipient));
  }),
);

app.delete('/:recipientId', requirePermission('sign_envelopes:update'), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadDraft(db, c.req.param('id')!, await viewerOf(c));
    await removeRecipient(db, envelope.id, c.req.param('recipientId'));
    await touchEnvelope(db, envelope.id);
    publishEnvelopeUpdated(c, envelope);
    return noContent(c);
  }),
);

export default app;
