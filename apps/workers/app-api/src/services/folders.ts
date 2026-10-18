/**
 * Folders service — pure functions backing /api/folders/*.
 */

import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { DriveGeneralAccess } from '@weldsuite/core-domain/drive-access';

const { folders, files } = schema;

export interface ListFoldersParams {
  parentId?: string | null;
  all?: boolean;
}

export function listFolders(db: Database, params: ListFoldersParams) {
  const conditions = [isNull(folders.deletedAt)];
  if (!params.all) {
    if (params.parentId) {
      conditions.push(eq(folders.parentId, params.parentId));
    } else {
      conditions.push(isNull(folders.parentId));
    }
  }
  return Promise.resolve(
    db
      .select()
      .from(folders)
      .where(and(...conditions))
      .orderBy(asc(folders.name)),
  );
}

export async function getFolder(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), isNull(folders.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface CreateFolderParams {
  name: string;
  parentId?: string | null;
  color?: string | null;
  icon?: string | null;
  createdById: string | null;
}

export async function createFolder(db: Database, params: CreateFolderParams) {
  const id = generateId('fld');
  const now = new Date();
  await db.insert(folders).values({
    id,
    name: params.name,
    parentId: params.parentId || null,
    color: params.color || null,
    icon: params.icon || null,
    createdById: params.createdById,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
  return row!;
}

export interface UpdateFolderParams {
  name?: string;
  parentId?: string | null;
  color?: string | null;
  icon?: string | null;
  generalAccess?: DriveGeneralAccess;
}

export async function updateFolder(db: Database, id: string, params: UpdateFolderParams) {
  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), isNull(folders.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (params.name !== undefined) updates.name = params.name;
  if (params.parentId !== undefined) updates.parentId = params.parentId;
  if (params.color !== undefined) updates.color = params.color;
  if (params.icon !== undefined) updates.icon = params.icon;
  if (params.generalAccess !== undefined) updates.generalAccess = params.generalAccess;
  await db.update(folders).set(updates).where(eq(folders.id, id));
  const [row] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
  return row!;
}

export async function softDeleteFolder(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), isNull(folders.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const now = new Date();
  await db.update(folders).set({ deletedAt: now, updatedAt: now }).where(eq(folders.id, id));
  return existing;
}

// ============================================================================
// Trash
// ============================================================================

export async function getTrashedFolder(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), isNotNull(folders.deletedAt)))
    .limit(1);
  return row ?? null;
}

export function listTrashedFolders(db: Database) {
  return Promise.resolve(
    db
      .select()
      .from(folders)
      .where(isNotNull(folders.deletedAt))
      .orderBy(folders.deletedAt),
  );
}

export async function restoreFolder(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), isNotNull(folders.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(folders)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(folders.id, id));
  return existing;
}

/**
 * Every file directly in the given folders, trashed or not: what a purge of
 * those folders hard-deletes. Carries the fields the Drive sharing rules read,
 * so the route can refuse a purge that would take files the caller may not
 * change, and the R2 keys to clean up.
 */
export function listFilesInFolders(db: Database, folderIds: string[]) {
  if (folderIds.length === 0) return Promise.resolve([]);
  return Promise.resolve(
    db
      .select({
        id: files.id,
        uploadedById: files.uploadedById,
        folderId: files.folderId,
        generalAccess: files.generalAccess,
        entityType: files.entityType,
        fileKey: files.fileKey,
        storagePath: files.storagePath,
      })
      .from(files)
      .where(inArray(files.folderId, folderIds)),
  );
}

/**
 * Hard delete a folder and every file inside it. Returns the folder row
 * and its files so the route can check access and clean up R2 before
 * deleting rows.
 */
export async function loadFolderFilesForPurge(db: Database, folderId: string) {
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), isNotNull(folders.deletedAt)))
    .limit(1);
  if (!folder) return null;
  const folderFiles = await listFilesInFolders(db, [folderId]);
  return { folder, folderFiles };
}

export async function purgeFolder(db: Database, folderId: string) {
  // Caller deletes R2 objects first via loadFolderFilesForPurge.
  await db.delete(files).where(eq(files.folderId, folderId));
  await db.delete(folders).where(eq(folders.id, folderId));
}
