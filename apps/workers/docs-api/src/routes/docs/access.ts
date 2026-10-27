/**
 * What every document route needs: the document with the caller's WeldDrive
 * role on it, whether they may change it, and its room.
 */

import type { Context } from 'hono';
import { hasContextPermission } from '@weldsuite/permissions/server';
import type { DataFor } from '@weldsuite/entity-events/events';
import { error } from '@weldsuite/worker-kit/response';
import { canEdit, fileRole, loadDriveAccessForUser, type DriveRole } from '@weldsuite/core-domain/drive-access';
import type { Env, Variables } from '../../types';
import type { RoomMeta } from '../../room/doc-room';
import { getDoc, snapshotKeyFor, type DocRecord } from '../../services/docs';

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export const VIEW_ONLY = 'You can view this document but not change it';

/** The document with the caller's role on it, or the response to send instead. */
export async function findDoc(c: Ctx, id: string): Promise<{ doc: DocRecord; role: DriveRole } | Response> {
  const db = c.get('tenantDb');
  const doc = await getDoc(db, id);
  const role = doc ? fileRole(await loadDriveAccessForUser(db, c.get('userId') ?? null), doc.file) : null;
  if (!doc || !role) return error.notFound(c, 'Document', id);
  return { doc, role };
}

/** Write access needs the drive role, `docs:update`, and a workspace that is not read-only. */
export async function mayUpdate(c: Ctx): Promise<boolean> {
  return !c.get('readOnly') && (await hasContextPermission(c, 'docs:update'));
}

/** May change this document: an owner or editor on its file, with `docs:update`. */
export async function mayEditDoc(c: Ctx, role: DriveRole): Promise<boolean> {
  return canEdit(role) && (await mayUpdate(c));
}

export function eventData(doc: DocRecord): DataFor<'doc'> {
  return { id: doc.id, fileId: doc.fileId, name: doc.name, revision: doc.revision, updatedById: doc.updatedById };
}

/**
 * The room for a document: one Durable Object per document, named by workspace and id.
 * `workspaceId` is the Clerk org id: the room name and the R2 prefix still use it
 * (a rename would split live sessions; workspace-id plan).
 */
export function roomFor(c: Ctx, workspaceId: string, doc: DocRecord) {
  return c.env.DOC_ROOM.get(c.env.DOC_ROOM.idFromName(`${workspaceId}:${doc.id}`));
}

export function snapshotKeyOf(doc: DocRecord, workspaceId: string): string {
  return doc.snapshotKey ?? snapshotKeyFor(workspaceId, doc.id);
}

/** What the room needs to know about the document it holds. */
export function roomMeta(doc: DocRecord, workspaceId: string): RoomMeta {
  return { workspaceId, docId: doc.id, snapshotKey: snapshotKeyOf(doc, workspaceId) };
}
