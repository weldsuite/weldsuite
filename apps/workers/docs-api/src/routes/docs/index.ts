/**
 * Document routes: /api/docs/*.
 *
 * A document is a WeldDrive file plus a `docs` row, so who may see or change
 * it follows WeldDrive's sharing rules (owner, shares, general access,
 * folders) on top of the `docs:*` permissions. A document the caller may not
 * see is a 404.
 *
 *   GET    /api/docs               → documents the caller can see
 *   POST   /api/docs               → create (empty, or from an initial snapshot), in My Drive or a folder
 *   GET    /api/docs/:id           → one document
 *   PATCH  /api/docs/:id           → rename and/or move
 *   DELETE /api/docs/:id           → move to the trash
 *   POST   /api/docs/:id/session   → ticket for the document's room socket
 *   GET    /api/docs/:id/snapshot  → the document as its room holds it now
 *
 * The content is otherwise edited over the room socket (`/api/docs/connect`,
 * see ../../room/connect.ts). The snapshot route is for what cannot join a
 * room (downloads, printing, exports): the room serves its live state, so it
 * includes edits not checkpointed yet.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { DocModel, type DocSnapshot } from '@weldsuite/docs-engine';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { DataFor } from '@weldsuite/entity-events/events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  canEdit,
  containerRole,
  fileRole,
  loadDriveAccessForUser,
  visibleFilesCondition,
  type DriveRole,
} from '@weldsuite/core-domain/drive-access';
import {
  DEFAULT_DOC_NAME,
  DOC_SNAPSHOT_MAX_BYTES,
  createDocSchema,
  listDocsQuerySchema,
  updateDocSchema,
  type DocSession,
  type DocSummary,
} from '@weldsuite/app-api-client/schemas/docs';
import type { Env, Variables } from '../../types';
import {
  createDoc,
  getDoc,
  listDocs,
  memberProfile,
  snapshotKeyFor,
  trashDoc,
  updateDoc,
  type DocRecord,
} from '../../services/docs';
import { writeSnapshot } from '../../room/snapshot';
import { colorFor } from '../../room/people';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const VIEW_ONLY = 'You can view this document but not change it';
const DEFAULT_LIMIT = 50;
/** Room for the JSON envelope around the largest snapshot. */
const BODY_SLACK = 64 * 1024;

/** The document with the caller's role on it, or the response to send instead. */
async function findDoc(c: Ctx, id: string): Promise<{ doc: DocRecord; role: DriveRole } | Response> {
  const db = c.get('tenantDb');
  const doc = await getDoc(db, id);
  const role = doc ? fileRole(await loadDriveAccessForUser(db, c.get('userId') ?? null), doc.file) : null;
  if (!doc || !role) return error.notFound(c, 'Document', id);
  return { doc, role };
}

/** Write access needs the drive role, `docs:update`, and a workspace that is not read-only. */
async function mayUpdate(c: Ctx): Promise<boolean> {
  return !c.get('readOnly') && (await hasContextPermission(c, 'docs:update'));
}

function toSummary(doc: DocRecord, role: DriveRole, mayEdit: boolean): DocSummary {
  return {
    id: doc.id,
    fileId: doc.fileId,
    name: doc.name,
    folderId: doc.folderId,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    createdById: doc.createdById,
    updatedById: doc.updatedById,
    revision: doc.revision,
    role,
    canEdit: mayEdit && canEdit(role),
  };
}

function eventData(doc: DocRecord): DataFor<'doc'> {
  return { id: doc.id, fileId: doc.fileId, name: doc.name, revision: doc.revision, updatedById: doc.updatedById };
}

/** The room for a document: one Durable Object per document, named by workspace and id. */
function roomFor(c: Ctx, workspaceId: string, doc: DocRecord) {
  return c.env.DOC_ROOM.get(c.env.DOC_ROOM.idFromName(`${workspaceId}:${doc.id}`));
}

function snapshotKeyOf(doc: DocRecord, workspaceId: string): string {
  return doc.snapshotKey ?? snapshotKeyFor(workspaceId, doc.id);
}

app.get('/', requirePermission('docs:read'), zValidator('query', listDocsQuerySchema), async (c) => {
  const { search, limit = DEFAULT_LIMIT, cursor } = c.req.valid('query');
  const db = c.get('tenantDb');
  const access = await loadDriveAccessForUser(db, c.get('userId') ?? null);
  const offset = cursor ? Number(cursor) : 0;
  const { rows, total } = await listDocs(db, { visible: visibleFilesCondition(access), search, limit, offset });
  const mayEdit = await mayUpdate(c);
  const data = rows.map((doc) => toSummary(doc, fileRole(access, doc.file) ?? 'viewer', mayEdit));
  const next = offset + rows.length;
  return list(c, data, cursorPagination(total, next < total, next < total ? String(next) : null));
});

/** A folder the caller may add to (null for My Drive), or the response to send instead. */
async function editableFolder(c: Ctx, folderId: string | null): Promise<string | null | Response> {
  if (!folderId) return null;
  const role = containerRole(await loadDriveAccessForUser(c.get('tenantDb'), c.get('userId') ?? null), folderId);
  if (!role) return error.notFound(c, 'Folder', folderId);
  if (!canEdit(role)) return error.forbidden(c, 'You can view this folder but not add to it');
  return folderId;
}

/**
 * The snapshot a new document starts from: the one sent (checked by loading
 * it, which is what a room will do), or one empty paragraph. Or the response
 * to send instead.
 */
function startingSnapshot(c: Ctx, sent: { version: number } | undefined): DocSnapshot | Response {
  if (!sent) return DocModel.create().toSnapshot();
  if (JSON.stringify(sent).length > DOC_SNAPSHOT_MAX_BYTES) {
    return error.badRequest(c, 'The document is too large to create', { reason: 'too_large' });
  }
  try {
    // Loading it is the validation; the snapshot written is what the engine makes of it.
    return DocModel.fromSnapshot(sent as DocSnapshot).toSnapshot();
  } catch {
    return error.badRequest(c, 'The snapshot is not a document', { reason: 'invalid_snapshot' });
  }
}

app.post('/', requirePermission('docs:create'), zValidator('json', createDocSchema), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  if (Number(c.req.header('content-length')) > DOC_SNAPSHOT_MAX_BYTES + BODY_SLACK) {
    return error.badRequest(c, 'The document is too large to create', { reason: 'too_large' });
  }
  const { name = DEFAULT_DOC_NAME, folderId = null, snapshot: sent } = c.req.valid('json');
  const folder = await editableFolder(c, folderId);
  if (folder instanceof Response) return folder;
  const doc = startingSnapshot(c, sent);
  if (doc instanceof Response) return doc;

  // The first checkpoint goes in before the rows, so a room never opens a document without one.
  const docId = generateId('doc');
  const size = await writeSnapshot(c.env.PRIVATE_STORAGE, snapshotKeyFor(workspaceId, docId), { revision: 0, doc });
  const created = await createDoc(c.get('tenantDb'), { workspaceId, userId, name, folderId: folder, docId, snapshotSize: size });
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: created.fileId,
    action: 'created',
    data: { id: created.fileId, name: created.name, folderId: created.folderId, fileType: 'document', fileSize: size },
  });
  publishEntityEvent({ c, entityType: 'doc', entityId: created.id, action: 'created', data: eventData(created) });
  return success(c, toSummary(created, 'owner', await mayUpdate(c)), 201);
});

app.get('/:id/snapshot', requirePermission('docs:read'), async (c) => {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const found = await findDoc(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const { doc } = found;
  const live = await roomFor(c, workspaceId, doc).snapshot({
    workspaceId,
    docId: doc.id,
    snapshotKey: snapshotKeyOf(doc, workspaceId),
  });
  // The envelope of success(), around the snapshot's JSON as the room wrote it.
  return new Response(`{"data":{"revision":${live.revision},"snapshot":${live.json}}}`, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
});

app.get('/:id', requirePermission('docs:read'), async (c) => {
  const found = await findDoc(c, c.req.param('id'));
  if (found instanceof Response) return found;
  return success(c, toSummary(found.doc, found.role, await mayUpdate(c)));
});

app.patch('/:id', requirePermission('docs:update'), zValidator('json', updateDocSchema), async (c) => {
  const found = await findDoc(c, c.req.param('id'));
  if (found instanceof Response) return found;
  if (!canEdit(found.role)) return error.forbidden(c, VIEW_ONLY);
  const { name, folderId } = c.req.valid('json');
  // Moving out of a folder is an edit of the document; moving into one needs a say in that folder.
  const target = folderId === undefined ? undefined : await editableFolder(c, folderId);
  if (target instanceof Response) return target;

  const result = await updateDoc(c.get('tenantDb'), found.doc, { name, folderId: target });
  if (!result.ok) {
    return result.reason === 'name_conflict'
      ? error.conflict(c, 'A file with this name already exists in this folder')
      : error.notFound(c, 'Document', found.doc.id);
  }
  const { doc, previous } = result;
  const renamed = doc.name !== previous.fileName;
  const moved = doc.folderId !== previous.folderId;
  const fileData = { id: doc.fileId, name: doc.name, folderId: doc.folderId, fileType: 'document' };
  if (renamed) {
    publishEntityEvent({
      c,
      entityType: 'file',
      entityId: doc.fileId,
      action: 'updated',
      data: fileData,
      changes: { name: { old: previous.fileName, new: doc.name } },
    });
  }
  if (moved) publishEntityEvent({ c, entityType: 'file', entityId: doc.fileId, action: 'moved', data: fileData });
  publishEntityEvent({
    c,
    entityType: 'doc',
    entityId: doc.id,
    action: 'updated',
    data: eventData(doc),
    ...(renamed ? { changes: { name: { old: previous.fileName, new: doc.name } } } : {}),
  });
  return success(c, toSummary(doc, found.role, true));
});

app.delete('/:id', requirePermission('docs:delete'), async (c) => {
  const found = await findDoc(c, c.req.param('id'));
  if (found instanceof Response) return found;
  if (!canEdit(found.role)) return error.forbidden(c, VIEW_ONLY);
  const { doc } = found;
  if (!(await trashDoc(c.get('tenantDb'), doc))) return error.notFound(c, 'Document', doc.id);
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: doc.fileId,
    action: 'deleted',
    data: { id: doc.fileId, name: doc.name, folderId: doc.folderId, fileType: 'document' },
  });
  publishEntityEvent({ c, entityType: 'doc', entityId: doc.id, action: 'deleted', data: eventData(doc) });
  return noContent(c);
});

app.post('/:id/session', requirePermission('docs:read'), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const found = await findDoc(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const { doc, role } = found;

  const mayEdit = canEdit(role) && (await mayUpdate(c));
  const profile = await memberProfile(c.get('tenantDb'), userId);
  const color = colorFor(userId);
  const ticket = await roomFor(c, workspaceId, doc).admit({
    workspaceId,
    docId: doc.id,
    snapshotKey: snapshotKeyOf(doc, workspaceId),
    userId,
    name: profile.name ?? 'Unknown',
    picture: profile.picture,
    color,
    canEdit: mayEdit,
  });
  return success(c, { ticket, canEdit: mayEdit, color } satisfies DocSession);
});

export default app;
