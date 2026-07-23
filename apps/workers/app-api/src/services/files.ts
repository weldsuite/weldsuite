/**
 * Files service — pure functions backing /api/files/*.
 *
 * Drive-native file store (the `files` table). Cloudflare R2 is the source
 * of truth for the binary; the row holds metadata + storage key.
 */

import { and, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { files, folders } = schema;

// ============================================================================
// Name conflict helpers (ported verbatim from api-worker drive routes)
// ============================================================================

export async function hasFileNameConflict(
  db: Database,
  fileName: string,
  folderId: string | null,
  excludeFileId?: string,
): Promise<boolean> {
  const conditions = [
    eq(files.fileName, fileName),
    isNull(files.deletedAt),
    folderId ? eq(files.folderId, folderId) : isNull(files.folderId),
  ];
  if (excludeFileId) conditions.push(ne(files.id, excludeFileId));
  const [match] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(...conditions))
    .limit(1);
  return !!match;
}

export async function deduplicateFileName(
  db: Database,
  fileName: string,
  folderId: string | null,
): Promise<string> {
  if (!(await hasFileNameConflict(db, fileName, folderId))) return fileName;
  const dotIdx = fileName.lastIndexOf('.');
  const hasExt = dotIdx > 0;
  const base = hasExt ? fileName.slice(0, dotIdx) : fileName;
  const ext = hasExt ? fileName.slice(dotIdx) : '';
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await hasFileNameConflict(db, candidate, folderId))) return candidate;
  }
}

// ============================================================================
// CRUD
// ============================================================================

export interface ListFilesParams {
  folderId?: string | null;
  rootOnly?: boolean;
  type?: string;
}

export async function listFiles(db: Database, params: ListFilesParams) {
  const conditions = [isNull(files.deletedAt)];
  if (params.folderId) {
    conditions.push(eq(files.folderId, params.folderId));
  } else if (params.rootOnly) {
    conditions.push(isNull(files.folderId));
  }
  if (params.type) conditions.push(eq(files.fileType, params.type));

  return db
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(desc(files.createdAt));
}

export async function getFile(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface CreateFileParams {
  fileName: string;
  originalName?: string;
  mimeType: string;
  fileSize: number;
  fileType?: string;
  storagePath: string;
  fileKey?: string;
  bucket?: string;
  url?: string;
  thumbnailUrl?: string;
  folderId?: string | null;
  isPublic?: boolean;
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  uploadedById: string;
}

export async function createFile(db: Database, params: CreateFileParams) {
  const uniqueName = await deduplicateFileName(db, params.fileName, params.folderId ?? null);
  const id = generateId('fil');
  const now = new Date();
  await db.insert(files).values({
    id,
    fileName: uniqueName,
    originalName: params.originalName || params.fileName,
    mimeType: params.mimeType,
    fileSize: params.fileSize,
    fileType: params.fileType || 'file',
    storagePath: params.storagePath,
    fileKey: params.fileKey || null,
    bucket: params.bucket || null,
    url: params.url || null,
    thumbnailUrl: params.thumbnailUrl || null,
    folderId: params.folderId || null,
    uploadedById: params.uploadedById,
    isPublic: params.isPublic || false,
    entityType: params.entityType || null,
    entityId: params.entityId || null,
    metadata: params.metadata || null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return row!;
}

export interface UpdateFileParams {
  fileName?: string;
  folderId?: string | null;
  isStarred?: boolean;
  isPublic?: boolean;
}

export type UpdateFileResult =
  | { ok: true; row: typeof schema.files.$inferSelect }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'name_conflict' };

export async function updateFile(
  db: Database,
  id: string,
  params: UpdateFileParams,
): Promise<UpdateFileResult> {
  const [existing] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  if (!existing) return { ok: false, reason: 'not_found' };

  if (params.fileName !== undefined || params.folderId !== undefined) {
    const targetName = params.fileName ?? existing.fileName;
    const targetFolder = params.folderId !== undefined ? params.folderId : existing.folderId;
    if (await hasFileNameConflict(db, targetName, targetFolder, id)) {
      return { ok: false, reason: 'name_conflict' };
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (params.fileName !== undefined) updates.fileName = params.fileName;
  if (params.folderId !== undefined) updates.folderId = params.folderId;
  if (params.isStarred !== undefined) updates.isStarred = params.isStarred;
  if (params.isPublic !== undefined) updates.isPublic = params.isPublic;

  await db.update(files).set(updates).where(eq(files.id, id));
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return { ok: true, row: row! };
}

export interface SoftDeleteFileResult {
  ok: true;
  row: typeof schema.files.$inferSelect;
  deletedAt: Date;
  purgeAt: Date;
}

export async function softDeleteFile(
  db: Database,
  id: string,
): Promise<SoftDeleteFileResult | { ok: false }> {
  const [existing] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  if (!existing) return { ok: false };

  const now = new Date();
  await db
    .update(files)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(files.id, id));

  const purgeAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { ok: true, row: existing, deletedAt: now, purgeAt };
}

export async function touchFileSize(db: Database, id: string, fileSize: number) {
  await db
    .update(files)
    .set({ fileSize, updatedAt: new Date() })
    .where(eq(files.id, id));
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return row ?? null;
}

export async function toggleStar(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const next = !existing.isStarred;
  await db
    .update(files)
    .set({ isStarred: next, updatedAt: new Date() })
    .where(eq(files.id, id));
  return { isStarred: next, row: { ...existing, isStarred: next } };
}

/**
 * Toggle the workspace-wide pin on a file. Unlike `toggleStar`, this also
 * records who pinned it and when — pinned surfaces sort on `pinnedAt`, and the
 * attribution matters because the pin is visible to the whole workspace.
 */
export async function togglePin(db: Database, id: string, userId: string) {
  const [existing] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const next = !existing.isPinned;
  const now = new Date();
  const pinFields = next
    ? { isPinned: true, pinnedAt: now, pinnedBy: userId }
    : { isPinned: false, pinnedAt: null, pinnedBy: null };

  await db
    .update(files)
    .set({ ...pinFields, updatedAt: now })
    .where(eq(files.id, id));

  return { isPinned: next, row: { ...existing, ...pinFields } };
}

export type MoveFileResult =
  | { ok: true; row: typeof schema.files.$inferSelect }
  | { ok: false; reason: 'not_found_file' }
  | { ok: false; reason: 'not_found_folder' }
  | { ok: false; reason: 'name_conflict' };

export async function moveFile(
  db: Database,
  id: string,
  folderId: string | null,
): Promise<MoveFileResult> {
  const [existing] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  if (!existing) return { ok: false, reason: 'not_found_file' };

  if (folderId) {
    const [folder] = await db
      .select()
      .from(folders)
      .where(and(eq(folders.id, folderId), isNull(folders.deletedAt)))
      .limit(1);
    if (!folder) return { ok: false, reason: 'not_found_folder' };
  }

  if (await hasFileNameConflict(db, existing.fileName, folderId, id)) {
    return { ok: false, reason: 'name_conflict' };
  }

  await db
    .update(files)
    .set({ folderId, updatedAt: new Date() })
    .where(eq(files.id, id));

  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return { ok: true, row: row! };
}

// ============================================================================
// Trash (file-specific helpers used by /api/drive routes)
// ============================================================================

export async function listTrashedFiles(db: Database) {
  return db
    .select()
    .from(files)
    .where(isNotNull(files.deletedAt))
    .orderBy(desc(files.deletedAt));
}

export async function restoreFile(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNotNull(files.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(files)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(files.id, id));
  return existing;
}

export async function purgeFile(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), isNotNull(files.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db.delete(files).where(eq(files.id, id));
  return existing;
}
