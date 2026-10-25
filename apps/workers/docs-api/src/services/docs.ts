/**
 * Document records: a drive `files` row (name, folder, sharing, trash) paired
 * with a `docs` row (where the room's latest checkpoint is). Pure functions
 * over the tenant DB; access checks happen in the routes.
 *
 * Only WeldDocs documents are listed or opened here. A row with BlockNote
 * `content` is a document from before WeldDocs (flow-api `/api/documents`)
 * and has no checkpoint; a WeldDocs row has a checkpoint key and no content.
 */

import { and, desc, eq, ilike, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import * as filesService from '@weldsuite/core-domain/files';
import { WELDDOC_MIME_TYPE } from '@weldsuite/app-api-client/schemas/docs';
import type { DriveFileRef } from '@weldsuite/core-domain/drive-access';

const { files, docs } = schema;

export interface DocRecord {
  id: string;
  fileId: string;
  name: string;
  folderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
  updatedById: string | null;
  revision: number;
  snapshotKey: string | null;
  /** What drive access rules need to know about the file. */
  file: DriveFileRef;
}

const columns = {
  id: docs.id,
  fileId: docs.fileId,
  name: files.fileName,
  folderId: files.folderId,
  createdAt: docs.createdAt,
  docUpdatedAt: docs.updatedAt,
  fileUpdatedAt: files.updatedAt,
  createdById: files.uploadedById,
  updatedById: docs.updatedById,
  revision: docs.revision,
  snapshotKey: docs.snapshotKey,
  generalAccess: files.generalAccess,
  entityType: files.entityType,
};

interface Row {
  id: string;
  fileId: string;
  name: string;
  folderId: string | null;
  createdAt: Date;
  docUpdatedAt: Date;
  fileUpdatedAt: Date;
  createdById: string | null;
  updatedById: string | null;
  revision: number;
  snapshotKey: string | null;
  generalAccess: DriveFileRef['generalAccess'];
  entityType: string | null;
}

function toRecord(r: Row): DocRecord {
  return {
    id: r.id,
    fileId: r.fileId,
    name: r.name,
    folderId: r.folderId,
    createdAt: r.createdAt,
    updatedAt: r.docUpdatedAt > r.fileUpdatedAt ? r.docUpdatedAt : r.fileUpdatedAt,
    createdById: r.createdById,
    updatedById: r.updatedById,
    revision: r.revision,
    snapshotKey: r.snapshotKey,
    file: {
      id: r.fileId,
      uploadedById: r.createdById,
      folderId: r.folderId,
      generalAccess: r.generalAccess,
      entityType: r.entityType,
    },
  };
}

/** WeldDocs documents only: older BlockNote rows have no checkpoint. */
const isWeldDoc = isNotNull(docs.snapshotKey);

/** Documents not in the trash, most recently changed first. `visible` narrows them to what the caller may see. */
export async function listDocs(
  db: Database,
  params: { visible?: SQL; search?: string; limit: number; offset: number },
): Promise<{ rows: DocRecord[]; total: number }> {
  const where = and(
    isWeldDoc,
    isNull(files.deletedAt),
    params.visible,
    params.search ? ilike(files.fileName, `%${escapeLike(params.search)}%`) : undefined,
  );
  const [rows, [count]] = await Promise.all([
    db
      .select(columns)
      .from(docs)
      .innerJoin(files, eq(files.id, docs.fileId))
      .where(where)
      .orderBy(desc(sql`greatest(${docs.updatedAt}, ${files.updatedAt})`), desc(docs.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(docs).innerJoin(files, eq(files.id, docs.fileId)).where(where),
  ]);
  return { rows: rows.map(toRecord), total: count?.total ?? 0 };
}

/** A document not in the trash, or null. */
export async function getDoc(db: Database, id: string): Promise<DocRecord | null> {
  const [row] = await db
    .select(columns)
    .from(docs)
    .innerJoin(files, eq(files.id, docs.fileId))
    .where(and(eq(docs.id, id), isWeldDoc, isNull(files.deletedAt)))
    .limit(1);
  return row ? toRecord(row) : null;
}

/** The R2 key a document's checkpoints are written to (one object, overwritten each time). */
export function snapshotKeyFor(workspaceId: string, docId: string): string {
  return `workspaces/${workspaceId}/docs/${docId}/document.json.gz`;
}

export async function createDoc(
  db: Database,
  params: { workspaceId: string; name: string; folderId: string | null; userId: string; snapshotSize: number; docId?: string },
): Promise<DocRecord> {
  const id = params.docId ?? generateId('doc');
  const key = snapshotKeyFor(params.workspaceId, id);
  const file = await filesService.createFile(db, {
    fileName: params.name,
    originalName: params.name,
    mimeType: WELDDOC_MIME_TYPE,
    fileSize: params.snapshotSize,
    fileType: 'document',
    storagePath: key,
    fileKey: key,
    bucket: 'private',
    folderId: params.folderId,
    uploadedById: params.userId,
    metadata: { weldDocId: id },
  });
  const now = new Date();
  await db.insert(docs).values({
    id,
    fileId: file.id,
    // Null marks a WeldDocs document: its content is the room's and R2's.
    content: null,
    snapshotKey: key,
    revision: 0,
    snapshotRevision: 0,
    updatedById: params.userId,
    createdAt: now,
    updatedAt: now,
  });
  const created = await getDoc(db, id);
  if (!created) throw new Error(`Document ${id} vanished after insert`);
  return created;
}

export type UpdateResult =
  | { ok: true; doc: DocRecord; previous: typeof files.$inferSelect }
  | { ok: false; reason: 'not_found' | 'name_conflict' };

/** Renames and/or moves the document's drive file. `folderId` undefined leaves the folder alone; null is My Drive. */
export async function updateDoc(
  db: Database,
  doc: DocRecord,
  changes: { name?: string; folderId?: string | null },
): Promise<UpdateResult> {
  const result = await filesService.updateFile(db, doc.fileId, { fileName: changes.name, folderId: changes.folderId });
  if (!result.ok) return result;
  const updated = await getDoc(db, doc.id);
  return updated ? { ok: true, doc: updated, previous: result.previous } : { ok: false, reason: 'not_found' };
}

/** Moves the document's file to the trash (WeldDrive purges it after 30 days). */
export async function trashDoc(db: Database, doc: DocRecord): Promise<boolean> {
  const result = await filesService.softDeleteFile(db, doc.fileId);
  return result.ok;
}

/** The room wrote a checkpoint: record where it is, and that the document changed. */
export async function recordCheckpoint(
  db: Database,
  docId: string,
  params: { revision: number; snapshotKey: string; size: number; userId: string | null },
): Promise<DocRecord | null> {
  const now = new Date();
  const [row] = await db
    .update(docs)
    .set({
      revision: params.revision,
      snapshotRevision: params.revision,
      snapshotKey: params.snapshotKey,
      updatedAt: now,
      ...(params.userId ? { updatedById: params.userId } : {}),
    })
    .where(eq(docs.id, docId))
    .returning({ fileId: docs.fileId });
  if (!row) return null;
  await db.update(files).set({ fileSize: params.size }).where(eq(files.id, row.fileId));
  return getDoc(db, docId);
}

/** Display name and picture of a workspace member, for the room's peer list. */
export async function memberProfile(db: Database, userId: string): Promise<{ name: string | null; picture: string | null }> {
  const [row] = await db
    .select({ name: schema.workspaceMembers.name, email: schema.workspaceMembers.email, picture: schema.workspaceMembers.picture })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.userId, userId), isNull(schema.workspaceMembers.deletedAt)))
    .limit(1);
  return { name: row?.name || row?.email || null, picture: row?.picture ?? null };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
