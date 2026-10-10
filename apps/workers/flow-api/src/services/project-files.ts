/**
 * Project files service — folder hierarchy helpers for project_files.
 *
 * Folders are rows with `isFolder=true` / `fileType='folder'`. Nesting uses
 * `parentId` (null = project root). Soft-deleting a folder cascades to all
 * descendants so orphaned children don't linger in the tree.
 */

import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

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
    if (!parent?.isFolder) {
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
 * storage is unchanged, missing, or the effective post-update key matches the
 * previous one.
 *
 * Partial updates are merged with the existing row first (absent fields keep
 * their current value) so a storagePath-only PATCH that leaves fileKey alone
 * does not treat the still-referenced fileKey as orphaned.
 */
function nonEmptyStorageKey(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function replacedStorageKey(
  existing: { storagePath: string | null; fileKey: string | null },
  update: { storagePath?: unknown; fileKey?: unknown },
): string | null {
  const nextKey =
    nonEmptyStorageKey(update.fileKey === undefined ? existing.fileKey : update.fileKey) ||
    nonEmptyStorageKey(
      update.storagePath === undefined ? existing.storagePath : update.storagePath,
    );
  if (!nextKey) return null;

  const oldKey =
    nonEmptyStorageKey(existing.fileKey) || nonEmptyStorageKey(existing.storagePath);
  if (!oldKey || oldKey === nextKey) return null;
  return oldKey;
}

/**
 * Columns a client may write on a project file. Everything else in the body
 * (id, deletedAt, isFolder, bucket, …) is dropped: the request schema is
 * `.passthrough()`, so without this list a caller could set any column.
 */
const WRITABLE_FILE_COLUMNS = [
  'fileName',
  'originalName',
  'mimeType',
  'fileSize',
  'storagePath',
  'fileKey',
  'url',
  'thumbnailUrl',
  'storageProvider',
  'fileType',
  'isPublic',
  'metadata',
  'parentId',
] as const;

export function pickWritableFileColumns(data: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of WRITABLE_FILE_COLUMNS) {
    if (data[key] !== undefined) picked[key] = data[key];
  }
  return picked;
}

/**
 * Segment `/api/storage/generate-upload-url` puts between the entity path and
 * the file name: `<timestamp>_<32 hex chars of a random UUID>`. Keys issued
 * before it existed have no such segment (see `isProjectUploadKey`).
 */
const UNGUESSABLE_SEGMENT = /^\d+_[0-9a-f]{32}$/;

/**
 * True when `key` is an object the storage upload flow issued for this
 * project: `workspaces/<workspaceId>/<folder>/project/<projectId>/<object>`
 * (see `/api/storage/generate-upload-url`), where `<object>` is either
 * `<name>` (older keys) or `<timestamp>_<unguessable>/<name>` (current keys).
 * The bucket is shared by every workspace and module, so this prefix is the
 * only thing that ties a key to a project — a key outside it must never be
 * stored on, or deleted for, a project file.
 */
export function isProjectUploadKey(
  key: unknown,
  workspaceId: string | null | undefined,
  projectId: string | null | undefined,
): key is string {
  if (typeof key !== 'string' || !workspaceId || !projectId) return false;
  const parts = key.split('/');
  if (parts.length !== 6 && parts.length !== 7) return false;
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (parts.length === 7 && !UNGUESSABLE_SEGMENT.test(parts[5])) return false;
  return (
    parts[0] === 'workspaces' &&
    parts[1] === workspaceId &&
    parts[3] === 'project' &&
    parts[4] === projectId
  );
}

/** Is `key` the storage object of any project file other than `exceptId`? */
export async function isStorageKeyInUse(
  db: Database,
  key: string,
  exceptId?: string,
): Promise<boolean> {
  const references = or(eq(projectFiles.storagePath, key), eq(projectFiles.fileKey, key));
  const [row] = await db
    .select({ id: projectFiles.id })
    .from(projectFiles)
    .where(exceptId ? and(references, ne(projectFiles.id, exceptId)) : references)
    .limit(1);
  return !!row;
}

export interface StorageKeyScope {
  workspaceId: string | null | undefined;
  projectId: string | null | undefined;
  /** The row being updated; its current keys may be sent back unchanged. */
  existing?: { id: string; storagePath: string | null; fileKey: string | null };
}

/**
 * Check the `storagePath` / `fileKey` a client sent. A key is accepted only
 * when it is one of the project's own upload keys and no other project file
 * points at it. Returns false when any sent key must be refused.
 */
export async function areStorageKeysAcceptable(
  db: Database,
  data: { storagePath?: unknown; fileKey?: unknown },
  scope: StorageKeyScope,
): Promise<boolean> {
  const current = new Set([scope.existing?.storagePath, scope.existing?.fileKey]);
  const sent = [data.storagePath, data.fileKey].filter((value) => value !== undefined);
  for (const key of new Set(sent)) {
    if (typeof key === 'string' && current.has(key)) continue;
    if (!isProjectUploadKey(key, scope.workspaceId, scope.projectId)) return false;
    if (await isStorageKeyInUse(db, key, scope.existing?.id)) return false;
  }
  return true;
}

/**
 * May the R2 object behind a replaced project file be deleted? Only when it is
 * one of the project's own upload keys and no other project file still points
 * at it. Rows written before the prefix existed, or through another API
 * surface, can hold any key; those objects are left in place.
 */
export async function canDeleteReplacedObject(
  db: Database,
  key: string,
  scope: { workspaceId: string | null | undefined; projectId: string | null | undefined; fileId: string },
): Promise<boolean> {
  if (!isProjectUploadKey(key, scope.workspaceId, scope.projectId)) return false;
  return !(await isStorageKeyInUse(db, key, scope.fileId));
}

