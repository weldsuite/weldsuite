/**
 * Sending and the signed result — /api/sign/envelopes/:id/{send,download}.
 *
 *   POST /:id/send       → send a draft ({ expiresAt? }); 400 when it is not complete
 *                          or the workspace's email limits refuse it
 *   GET  /:id/download   → the signed PDF with its certificate (completed requests)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { error, success } from '@weldsuite/worker-kit/response';
import { getMasterDb, getWorkspaceForOrg } from '@weldsuite/worker-kit/db';
import { sendEnvelopeSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { getEnvelopeDetail, loadDraft, loadEnvelope, memberProfile } from '../../services/envelopes';
import { sendEnvelope } from '../../services/sending';
import { envelopeEventData, handle, mayEdit, viewerOf } from './shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/:id/send', requirePermission('sign_envelopes:send'), zValidator('json', sendEnvelopeSchema), (c) =>
  handle(c, async () => {
    const userId = c.get('userId');
    const orgId = c.get('workspaceId');
    if (!userId) return error.unauthorized(c);
    if (!orgId) return error.orgRequired(c);
    const db = c.get('tenantDb');
    const draft = await loadDraft(db, c.req.param('id'), await viewerOf(c));
    const workspace = await getWorkspaceForOrg(c.env, orgId);
    const profile = await memberProfile(db, userId);
    const sent = await sendEnvelope(
      { env: c.env, db, master: getMasterDb(c.env), clerkOrgId: orgId, workspaceId: workspace.id },
      draft,
      { userId, ...profile },
      c.req.valid('json').expiresAt,
    );
    publishEntityEvent({ c, entityType: 'sign_envelope', entityId: sent.id, action: 'sent', data: envelopeEventData(sent) });
    return success(c, await getEnvelopeDetail(db, sent, await mayEdit(c)));
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

export default app;
