/**
 * Recipients — /api/sign/envelopes/:id/recipients/*.
 *
 * Of a draft:
 *   POST   /                       → add a signer or copy recipient
 *   PATCH  /:recipientId           → change them (role, order, auth mode, …)
 *   DELETE /:recipientId           → remove them and their fields
 *
 *   GET    /suggestions            → people on the draft's CRM source, to add in one click
 *
 * Of a sent request (its owner, `sign_envelopes:send`; 409 once it is closed):
 *   POST   /:recipientId/resend    → email a signer whose turn it is a new link
 *   POST   /:recipientId/correct   → fix a name or email ({ name?, email }); a new email
 *                                    revokes their old links and, on their turn, mails a new one
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { noContent, success } from '@weldsuite/worker-kit/response';
import {
  correctRecipientSchema,
  createRecipientSchema,
  updateRecipientSchema,
  type SignSourceType,
} from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { loadDraft, loadOwnEnvelope, toRecipientDto, touchEnvelope } from '../../services/envelopes';
import { addRecipient, removeRecipient, updateRecipient } from '../../services/recipients';
import { correctRecipient, resendLink } from '../../services/lifecycle';
import { SOURCE_READ_PERMISSION, recipientSuggestions } from '../../services/sources';
import { actorOf, handle, mayDo, publishEnvelopeUpdated, sendContextOf, viewerOf } from './shared';

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

// The people on the draft's CRM record, for the recipients step: none for a
// file source or none at all, nor when the member may not read that record.
app.get('/suggestions', requirePermission('sign_envelopes:read'), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadOwnEnvelope(db, c.req.param('id')!, await viewerOf(c));
    const source = envelope.source;
    if (!source || source.entityType === 'file') return success(c, []);
    if (!(await mayDo(c, SOURCE_READ_PERMISSION[source.entityType as SignSourceType]))) return success(c, []);
    return success(c, await recipientSuggestions(db, source));
  }),
);

app.post('/:recipientId/resend', requirePermission('sign_envelopes:send'), (c) =>
  handle(c, async () => {
    const envelope = await loadOwnEnvelope(c.get('tenantDb'), c.req.param('id')!, await viewerOf(c));
    const recipient = await resendLink(await sendContextOf(c), envelope, c.req.param('recipientId'), await actorOf(c));
    publishEnvelopeUpdated(c, envelope);
    return success(c, toRecipientDto(recipient));
  }),
);

app.post('/:recipientId/correct', requirePermission('sign_envelopes:send'), zValidator('json', correctRecipientSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadOwnEnvelope(db, c.req.param('id')!, await viewerOf(c));
    const recipient = await correctRecipient(await sendContextOf(c), envelope, c.req.param('recipientId'), c.req.valid('json'), await actorOf(c));
    await touchEnvelope(db, envelope.id);
    publishEnvelopeUpdated(c, envelope);
    return success(c, toRecipientDto(recipient));
  }),
);

export default app;
