/**
 * Project files service — folder hierarchy helpers for project_files.
 *
 * Folders are rows with `isFolder=true` / `fileType='folder'`. Nesting uses
 * `parentId` (null = project root). Soft-deleting a folder cascades to all
 * descendants so orphaned children don't linger in the tree.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { projectFiles } = schema;

const FOLDER_MIME = 'inode/directory';
const FOLDER_STORAGE = '';

export interface CreateProjectFolderParams {
  projectId: string;
  name: string;
  parentId?: string | null;
  uploadedById?: string | null;
}

export async function createProjectFolder(db: Database, params: CreateProjectFolderParams) {
  const id = generateId('pfile');
  const now = new Date();
  const name = params.name.trim();
  if (!name) throw new Error('Folder name is required');

  if (params.parentId) {
    const [parent] = await db
      .select({ id: projectFiles.id, isFolder: projectFiles.isFolder, projectId: projectFiles.projectId })
      .from(projectFiles)
      .where(and(eq(projectFiles.id, params.parentId), isNull(projectFiles.deletedAt)))
      .limit(1);
    if (!parent || !parent.isFolder) {
      throw Object.assign(new Error('Parent folder not found'), { status: 404 });
    }
    if (parent.projectId !== params.projectId) {
      throw Object.assign(new Error('Parent folder belongs to a different project'), { status: 400 });
    }
  }

  await db.insert(projectFiles).values({
    id,
    projectId: params.projectId,
    parentId: params.parentId || null,
    fileName: name,
    originalName: name,
    mimeType: FOLDER_MIME,
    fileSize: 0,
    storagePath: FOLDER_STORAGE,
    storageProvider: 'r2',
    fileType: 'folder',
    isFolder: true,
    uploadedById: params.uploadedById || null,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(projectFiles).where(eq(projectFiles.id, id)).limit(1);
  return row!;
}

/**
 * Collect every descendant id under `folderId` (BFS), then soft-delete the
 * folder and all descendants. Returns the list of soft-deleted ids.
 */
export async function softDeleteProjectFolderCascade(
  db: Database,
  folderId: string,
): Promise<string[]> {
  const [folder] = await db
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.id, folderId), isNull(projectFiles.deletedAt)))
    .limit(1);
  if (!folder) return [];

  const toDelete = new Set<string>([folderId]);
  let frontier = [folderId];

  while (frontier.length > 0) {
    const children = await db
      .select({ id: projectFiles.id })
      .from(projectFiles)
      .where(and(inArray(projectFiles.parentId, frontier), isNull(projectFiles.deletedAt)));
    frontier = [];
    for (const child of children) {
      if (!toDelete.has(child.id)) {
        toDelete.add(child.id);
        frontier.push(child.id);
      }
    }
  }

  const ids = [...toDelete];
  const now = new Date();
  await db
    .update(projectFiles)
    .set({ deletedAt: now, updatedAt: now })
    .where(inArray(projectFiles.id, ids));
  return ids;
}

/**
 * Prevent moving a folder into itself or one of its descendants.
 */
export async function wouldCreateCycle(
  db: Database,
  folderId: string,
  newParentId: string | null,
): Promise<boolean> {
  if (!newParentId) return false;
  if (newParentId === folderId) return true;

  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === folderId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    const [row] = await db
      .select({ parentId: projectFiles.parentId })
      .from(projectFiles)
      .where(and(eq(projectFiles.id, current), isNull(projectFiles.deletedAt)))
      .limit(1);
    current = row?.parentId ?? null;
  }
  return false;
}

/**
 * When a project file's storage object is replaced, return the previous R2 key
 * that should be cleaned up after the DB update succeeds. Returns null when
 * storage is unchanged, missing, or the new key matches the old one.
 */
export function replacedStorageKey(
  existing: { storagePath: string | null; fileKey: string | null },
  update: { storagePath?: unknown; fileKey?: unknown },
): string | null {
  const nextKey =
    (typeof update.fileKey === 'string' && update.fileKey) ||
    (typeof update.storagePath === 'string' && update.storagePath) ||
    null;
  if (!nextKey) return null;

  const oldKey =
    (existing.fileKey && existing.fileKey.length > 0 ? existing.fileKey : null) ||
    (existing.storagePath && existing.storagePath.length > 0 ? existing.storagePath : null) ||
    null;
  if (!oldKey || oldKey === nextKey) return null;
  return oldKey;
}

