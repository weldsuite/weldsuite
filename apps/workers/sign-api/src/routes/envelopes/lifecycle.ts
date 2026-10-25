/**
 * Sending and a sent request — /api/sign/envelopes/:id/*.
 *
 *   POST /:id/send          → send a draft ({ expiresAt? }); 400 when it is not complete
 *                             or the workspace's email limits refuse it
 *   GET  /:id/download      → the signed PDF with its certificate (completed requests)
 *   POST /:id/void          → stop an open request ({ reason }); its links stop at once
 *   POST /:id/remind        → remind every signer whose turn it is; 409 when all were
 *                             emailed in the last hour
 *   GET  /:id/events        → the activity (evidence trail), oldest first
 *   POST /:id/signing-link  → a fresh link for the caller's own turn to sign ("sign now")
 *
 * Void, remind and the activity are for the request's owner (the sender, or
 * `sign_envelopes:manage`); anyone else gets a 404. A request that no longer
 * collects signatures answers 409. Resending to one signer and correcting an
 * email live with the recipients (./recipients.ts).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { error, success } from '@weldsuite/worker-kit/response';
import { sendEnvelopeSchema, voidEnvelopeSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { loadDraft, loadEnvelope, loadOwnEnvelope } from '@weldsuite/sign-domain/envelopes';
import { sendEnvelope } from '@weldsuite/sign-domain/sending';
import { listEvents, memberSigningLink, remindNow, voidRequest } from '@weldsuite/sign-domain/lifecycle';
import { actorOf, detailFor, envelopeEventData, handle, publishEnvelopeUpdated, sendContextOf, viewerOf } from './shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/:id/send', requirePermission('sign_envelopes:send'), zValidator('json', sendEnvelopeSchema), (c) =>
  handle(c, async () => {
    const viewer = await viewerOf(c);
    const draft = await loadDraft(c.get('tenantDb'), c.req.param('id'), viewer);
    const sent = await sendEnvelope(await sendContextOf(c), draft, await actorOf(c), c.req.valid('json').expiresAt);
    publishEntityEvent({ c, entityType: 'sign_envelope', entityId: sent.id, action: 'sent', data: envelopeEventData(sent) });
    return success(c, await detailFor(c, sent, viewer));
  }),
);

app.get('/:id/download', requirePermission('sign_envelopes:read'), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadEnvelope(db, c.req.param('id'), await viewerOf(c));
    if (envelope.status !== 'completed' || !envelope.finalStorageKey) return error.conflict(c, 'The request has not been signed by everyone yet');
    const object = await c.env.PRIVATE_STORAGE.get(envelope.finalStorageKey);
    if (!object) return error.notFound(c, 'Signed document', envelope.id);
    const filename = `${envelope.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'signed'}.pdf`;
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename.replaceAll('"', '')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }),
);

app.post('/:id/void', requirePermission('sign_envelopes:void'), zValidator('json', voidEnvelopeSchema), (c) =>
  handle(c, async () => {
    const viewer = await viewerOf(c);
    const envelope = await loadOwnEnvelope(c.get('tenantDb'), c.req.param('id'), viewer);
    const voided = await voidRequest(await sendContextOf(c), envelope, await actorOf(c), c.req.valid('json').reason);
    publishEntityEvent({ c, entityType: 'sign_envelope', entityId: voided.id, action: 'voided', data: envelopeEventData(voided) });
    return success(c, await detailFor(c, voided, viewer));
  }),
);

app.post('/:id/remind', requirePermission('sign_envelopes:send'), (c) =>
  handle(c, async () => {
    const envelope = await loadOwnEnvelope(c.get('tenantDb'), c.req.param('id'), await viewerOf(c));
    const reminded = await remindNow(await sendContextOf(c), envelope, await actorOf(c));
    publishEnvelopeUpdated(c, envelope);
    return success(c, { reminded });
  }),
);

app.get('/:id/events', requirePermission('sign_envelopes:read'), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadOwnEnvelope(db, c.req.param('id'), await viewerOf(c));
    return success(c, await listEvents(db, envelope.id));
  }),
);

app.post('/:id/signing-link', requirePermission('sign_envelopes:read'), (c) =>
  handle(c, async () => {
    const viewer = await viewerOf(c);
    const envelope = await loadEnvelope(c.get('tenantDb'), c.req.param('id'), viewer);
    return success(c, { url: await memberSigningLink(await sendContextOf(c), envelope, viewer.email) });
  }),
);

export default app;
