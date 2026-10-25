/**
 * Version history: /api/docs/:id/versions/*.
 *
 *   GET    /                        → saved versions, newest first (read access)
 *   POST   /                        → save the document as it is now under a name (edit access)
 *   PATCH  /:versionId              → rename a version (edit access)
 *   GET    /:versionId/snapshot     → the document as the version saved it (read access)
 *   POST   /:versionId/restore      → make the version the document again (edit access)
 *
 * The document's room holds the live document, so it writes the snapshots:
 * a version is the room's state when it was saved, edits not checkpointed
 * yet included. A restore first saves the document as it was as an automatic
 * version (no name), and every client in the room reloads (see DocRoom).
 * Edit access is the drive role (owner or editor) plus `docs:update`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  createDocVersionSchema,
  listDocVersionsQuerySchema,
  updateDocVersionSchema,
  type DocRestoreResult,
} from '@weldsuite/app-api-client/schemas/docs';
import type { Env, Variables } from '../../types';
import { getDoc } from '../../services/docs';
import {
  getVersion,
  insertVersion,
  listVersions,
  renameVersion,
  toVersion,
  versionEventData,
  versionKeyFor,
} from '../../services/versions';
import { readSnapshot } from '../../room/snapshot';
import { VIEW_ONLY, eventData, findDoc, mayEditDoc, roomFor, roomMeta, type Ctx } from './access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_LIMIT = 50;

/** The document, if the caller may change it; else the response to send. */
async function editableDoc(c: Ctx) {
  const found = await findDoc(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  if (!(await mayEditDoc(c, found.role))) return error.forbidden(c, VIEW_ONLY);
  return found.doc;
}

app.get('/', requirePermission('docs:read'), zValidator('query', listDocVersionsQuerySchema), async (c) => {
  const found = await findDoc(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  const { limit = DEFAULT_LIMIT, cursor } = c.req.valid('query');
  const { rows, total, hasMore } = await listVersions(c.get('tenantDb'), found.doc.id, { limit, after: cursor });
  const last = rows.at(-1);
  return list(c, rows.map(toVersion), cursorPagination(total, hasMore, hasMore && last ? last.id : null));
});

app.post('/', requirePermission('docs:update'), zValidator('json', createDocVersionSchema), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const doc = await editableDoc(c);
  if (doc instanceof Response) return doc;

  const meta = roomMeta(doc, workspaceId);
  const id = generateId('docv');
  const snapshotKey = versionKeyFor(meta.snapshotKey, id);
  const saved = await roomFor(c, workspaceId, doc).saveVersion(meta, snapshotKey);
  const row = await insertVersion(c.get('tenantDb'), {
    id,
    docId: doc.id,
    revision: saved.revision,
    name: c.req.valid('json').name,
    snapshotKey,
    size: saved.size,
    createdById: userId,
  });
  publishEntityEvent({ c, entityType: 'doc_version', entityId: row.id, action: 'created', data: versionEventData(row) });
  return success(c, toVersion(row), 201);
});

app.patch('/:versionId', requirePermission('docs:update'), zValidator('json', updateDocVersionSchema), async (c) => {
  const doc = await editableDoc(c);
  if (doc instanceof Response) return doc;
  const versionId = c.req.param('versionId');
  const db = c.get('tenantDb');
  const previous = await getVersion(db, doc.id, versionId);
  if (!previous) return error.notFound(c, 'Version', versionId);
  const row = await renameVersion(db, doc.id, versionId, c.req.valid('json').name);
  if (!row) return error.notFound(c, 'Version', versionId);
  publishEntityEvent({
    c,
    entityType: 'doc_version',
    entityId: row.id,
    action: 'updated',
    data: versionEventData(row),
    changes: { name: { old: previous.name, new: row.name } },
  });
  return success(c, toVersion(row));
});

app.get('/:versionId/snapshot', requirePermission('docs:read'), async (c) => {
  const found = await findDoc(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  const versionId = c.req.param('versionId');
  const version = await getVersion(c.get('tenantDb'), found.doc.id, versionId);
  const stored = version ? await readSnapshot(c.env.PRIVATE_STORAGE, version.snapshotKey) : null;
  if (!stored) return error.notFound(c, 'Version', versionId);
  c.header('Cache-Control', 'private, no-store');
  return success(c, { revision: stored.revision, snapshot: stored.doc });
});

app.post('/:versionId/restore', requirePermission('docs:update'), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const doc = await editableDoc(c);
  if (doc instanceof Response) return doc;
  const versionId = c.req.param('versionId');
  const db = c.get('tenantDb');
  const version = await getVersion(db, doc.id, versionId);
  if (!version) return error.notFound(c, 'Version', versionId);

  const autoVersionId = generateId('docv');
  const outcome = await roomFor(c, workspaceId, doc).restoreVersion({
    doc: roomMeta(doc, workspaceId),
    versionId,
    versionKey: version.snapshotKey,
    autoVersionId,
    userId,
  });
  if (!outcome.ok) return error.notFound(c, 'Version', versionId);
  const autoVersion = await getVersion(db, doc.id, autoVersionId);
  if (!autoVersion) throw new Error(`The automatic version ${autoVersionId} is missing after a restore`);

  const updated = (await getDoc(db, doc.id)) ?? doc;
  publishEntityEvent({ c, entityType: 'doc_version', entityId: autoVersion.id, action: 'created', data: versionEventData(autoVersion) });
  publishEntityEvent({
    c,
    entityType: 'doc',
    entityId: doc.id,
    action: 'updated',
    data: { ...eventData(updated), revision: outcome.revision, updatedById: userId },
    changes: { revision: { old: autoVersion.revision, new: outcome.revision } },
  });
  return success(c, { revision: outcome.revision, autoVersion: toVersion(autoVersion) } satisfies DocRestoreResult);
});

export default app;
