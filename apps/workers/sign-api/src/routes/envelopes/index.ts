/**
 * Envelope routes — /api/sign/envelopes/*.
 *
 * Without `sign_envelopes:manage` a member sees only the envelopes they sent;
 * one they may not see is a 404. Only drafts can be changed (409 otherwise).
 *
 *   GET    /api/sign/envelopes          → list (folder, search, cursor)
 *   POST   /api/sign/envelopes          → new draft
 *   GET    /api/sign/envelopes/:id      → the envelope with documents, recipients and fields
 *   PATCH  /api/sign/envelopes/:id      → draft settings
 *   DELETE /api/sign/envelopes/:id      → delete a draft and its files
 *
 * Documents, recipients and fields of a draft: ./documents.ts, ./recipients.ts, ./fields.ts.
 * Sending and the signed PDF: ./lifecycle.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  SIGN_FOLDER_STATUSES,
  createEnvelopeSchema,
  listEnvelopesQuerySchema,
  updateEnvelopeSchema,
} from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import {
  createEnvelope,
  deleteDraft,
  getEnvelopeDetail,
  listEnvelopes,
  loadEnvelope,
  memberProfile,
  updateEnvelope,
} from '../../services/envelopes';
import { loadSignSettings } from '../../services/settings';
import { envelopeEventData, handle, mayEdit, viewerOf } from './shared';
import documentsRoutes from './documents';
import recipientsRoutes from './recipients';
import fieldsRoutes from './fields';
import lifecycleRoutes from './lifecycle';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_LIMIT = 50;

app.get('/', requirePermission('sign_envelopes:read'), zValidator('query', listEnvelopesQuerySchema), async (c) => {
  const { folder = 'all', search, limit = DEFAULT_LIMIT, cursor } = c.req.valid('query');
  const offset = cursor ? Number(cursor) : 0;
  const { rows, total } = await listEnvelopes(c.get('tenantDb'), {
    viewer: await viewerOf(c),
    statuses: folder === 'all' ? undefined : SIGN_FOLDER_STATUSES[folder],
    search,
    limit,
    offset,
  });
  const next = offset + rows.length;
  return list(c, rows, cursorPagination(total, next < total, next < total ? String(next) : null));
});

app.post('/', requirePermission('sign_envelopes:create'), zValidator('json', createEnvelopeSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const db = c.get('tenantDb');
  const input = c.req.valid('json');
  const [profile, settings] = await Promise.all([memberProfile(db, userId), loadSignSettings(db)]);
  const envelope = await createEnvelope(db, {
    title: input.title,
    message: input.message,
    sender: { userId, ...profile },
    defaults: settings,
  });
  publishEntityEvent({ c, entityType: 'sign_envelope', entityId: envelope.id, action: 'created', data: envelopeEventData(envelope) });
  return success(c, await getEnvelopeDetail(db, envelope, await mayEdit(c)), 201);
});

app.get('/:id', requirePermission('sign_envelopes:read'), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadEnvelope(db, c.req.param('id'), await viewerOf(c));
    return success(c, await getEnvelopeDetail(db, envelope, await mayEdit(c)));
  }),
);

app.patch('/:id', requirePermission('sign_envelopes:update'), zValidator('json', updateEnvelopeSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadEnvelope(db, c.req.param('id'), await viewerOf(c));
    const updated = await updateEnvelope(db, envelope, c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'sign_envelope', entityId: updated.id, action: 'updated', data: envelopeEventData(updated) });
    return success(c, await getEnvelopeDetail(db, updated, await mayEdit(c)));
  }),
);

app.delete('/:id', requirePermission('sign_envelopes:delete'), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadEnvelope(db, c.req.param('id'), await viewerOf(c));
    const keys = await deleteDraft(db, envelope);
    if (keys.length) c.executionCtx.waitUntil(c.env.PRIVATE_STORAGE.delete(keys));
    publishEntityEvent({ c, entityType: 'sign_envelope', entityId: envelope.id, action: 'deleted', data: envelopeEventData(envelope) });
    return noContent(c);
  }),
);

app.route('/:id/documents', documentsRoutes);
app.route('/:id/recipients', recipientsRoutes);
app.route('/:id/fields', fieldsRoutes);
app.route('/', lifecycleRoutes);

export default app;
