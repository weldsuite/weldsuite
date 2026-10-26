/**
 * Envelope routes — /api/sign/envelopes/*.
 *
 * Without `sign_envelopes:manage` a member sees the envelopes they sent and
 * the sent requests they are a recipient of (by email); one they may not see
 * is a 404. Only the owner changes an envelope, and only a draft (409
 * otherwise); a sent request has its own actions in ./lifecycle.ts.
 *
 *   GET    /api/sign/envelopes          → list (folder, search, cursor; `action_required`: my turn to sign)
 *   POST   /api/sign/envelopes          → new draft
 *   GET    /api/sign/envelopes/:id      → the envelope with documents, recipients and fields
 *   PATCH  /api/sign/envelopes/:id      → draft settings
 *   DELETE /api/sign/envelopes/:id      → delete a draft and its files
 *
 * Documents, recipients and fields of a draft: ./documents.ts, ./recipients.ts, ./fields.ts.
 * Sending, the signed PDF, void, remind, activity and "sign now": ./lifecycle.ts.
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
  listEnvelopes,
  loadDraft,
  loadEnvelope,
  loadOwnEnvelope,
  memberProfile,
  updateEnvelope,
} from '@weldsuite/sign-domain/envelopes';
import { loadSignSettings } from '@weldsuite/sign-domain/settings';
import { invalid } from '@weldsuite/sign-domain/errors';
import { canFileInto, checkSource } from '@weldsuite/sign-domain/sources';
import type { DraftScope } from '../draft-scope';
import { detailFor, envelopeEventData, handle, mayDo, publishEnvelopeUpdated, viewerOf, type Ctx } from './shared';
import { createDocumentsRoutes } from './documents';
import recipientsRoutes from './recipients';
import { createFieldsRoutes } from './fields';
import lifecycleRoutes from './lifecycle';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** A request's draft: its sender (or `sign_envelopes:manage`) changes it while it is a draft. */
const envelopeScope: DraftScope = {
  read: 'sign_envelopes:read',
  update: 'sign_envelopes:update',
  loadEditable: async (c) => loadDraft(c.get('tenantDb'), c.req.param('id')!, await viewerOf(c)),
  loadReadable: async (c) => loadEnvelope(c.get('tenantDb'), c.req.param('id')!, await viewerOf(c)),
  changed: publishEnvelopeUpdated,
};

const DEFAULT_LIMIT = 50;

app.get('/', requirePermission('sign_envelopes:read'), zValidator('query', listEnvelopesQuerySchema), async (c) => {
  const { folder = 'all', search, limit = DEFAULT_LIMIT, cursor } = c.req.valid('query');
  const offset = cursor ? Number(cursor) : 0;
  const { rows, total } = await listEnvelopes(c.get('tenantDb'), {
    viewer: await viewerOf(c),
    statuses: folder === 'all' ? undefined : SIGN_FOLDER_STATUSES[folder],
    awaitingViewer: folder === 'action_required',
    search,
    limit,
    offset,
  });
  const next = offset + rows.length;
  return list(c, rows, cursorPagination(total, next < total, next < total ? String(next) : null));
});

/** A chosen folder for the signed copy must be one the member may add files to. */
async function checkFileBackFolder(c: Ctx, userId: string, folderId: string | null | undefined): Promise<void> {
  if (folderId && !(await canFileInto(c.get('tenantDb'), userId, folderId))) {
    throw invalid('You cannot add files to that WeldDrive folder');
  }
}

app.post('/', requirePermission('sign_envelopes:create'), zValidator('json', createEnvelopeSchema), (c) =>
  handle(c, async () => {
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const db = c.get('tenantDb');
    const input = c.req.valid('json');
    // A source must be a file or record the member may read; a Drive file's
    // folder becomes the signed copy's home unless the request names one.
    const checked = input.source ? await checkSource(db, userId, input.source, (permission) => mayDo(c, permission)) : null;
    await checkFileBackFolder(c, userId, input.fileBackFolderId);
    const fileBackFolderId = input.fileBackFolderId === undefined ? (checked?.folderForCopy ?? null) : input.fileBackFolderId;
    const [profile, settings] = await Promise.all([memberProfile(db, userId), loadSignSettings(db)]);
    const envelope = await createEnvelope(db, {
      title: input.title,
      message: input.message,
      sender: { userId, ...profile },
      defaults: settings,
      source: input.source ?? null,
      fileBackFolderId,
    });
    publishEntityEvent({ c, entityType: 'sign_envelope', entityId: envelope.id, action: 'created', data: envelopeEventData(envelope) });
    return success(c, await detailFor(c, envelope), 201);
  }),
);

app.get('/:id', requirePermission('sign_envelopes:read'), (c) =>
  handle(c, async () => {
    const viewer = await viewerOf(c);
    const envelope = await loadEnvelope(c.get('tenantDb'), c.req.param('id'), viewer);
    return success(c, await detailFor(c, envelope, viewer));
  }),
);

app.patch('/:id', requirePermission('sign_envelopes:update'), zValidator('json', updateEnvelopeSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const viewer = await viewerOf(c);
    const envelope = await loadOwnEnvelope(db, c.req.param('id'), viewer);
    const input = c.req.valid('json');
    await checkFileBackFolder(c, viewer.userId, input.fileBackFolderId);
    const updated = await updateEnvelope(db, envelope, input);
    publishEntityEvent({ c, entityType: 'sign_envelope', entityId: updated.id, action: 'updated', data: envelopeEventData(updated) });
    return success(c, await detailFor(c, updated, viewer));
  }),
);

app.delete('/:id', requirePermission('sign_envelopes:delete'), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadOwnEnvelope(db, c.req.param('id'), await viewerOf(c));
    const keys = await deleteDraft(db, envelope);
    if (keys.length) c.executionCtx.waitUntil(c.env.PRIVATE_STORAGE.delete(keys));
    publishEntityEvent({ c, entityType: 'sign_envelope', entityId: envelope.id, action: 'deleted', data: envelopeEventData(envelope) });
    return noContent(c);
  }),
);

app.route('/:id/documents', createDocumentsRoutes(envelopeScope));
app.route('/:id/recipients', recipientsRoutes);
app.route('/:id/fields', createFieldsRoutes(envelopeScope));
app.route('/', lifecycleRoutes);

export default app;
