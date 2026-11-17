/**
 * Folders service — pure functions backing /api/folders/*.
 */

import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  canEdit,
  fileRole,
  folderRole,
  type DriveAccessIndex,
  type DriveGeneralAccess,
} from '@weldsuite/core-domain/drive-access';

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

/** The live folders under `id` (itself included) and the live files in them, with what the Drive rules read. */
export async function listLiveFolderTree(db: Database, id: string) {
  const tree = sql`(with recursive tree as (
    select id from folders where id = ${id} and deleted_at is null
    union
    select f.id from folders f join tree on f.parent_id = tree.id where f.deleted_at is null
  ) select id from tree)`;
  const treeFolders = await db
    .select({
      id: folders.id,
      parentId: folders.parentId,
      createdById: folders.createdById,
      generalAccess: folders.generalAccess,
    })
    .from(folders)
    .where(sql`${folders.id} in ${tree}`);
  const treeFiles = treeFolders.length === 0
    ? []
    : await db
        .select({
          id: files.id,
          uploadedById: files.uploadedById,
          folderId: files.folderId,
          generalAccess: files.generalAccess,
          entityType: files.entityType,
        })
        .from(files)
        .where(and(inArray(files.folderId, treeFolders.map((f) => f.id)), isNull(files.deletedAt)));
  return { folders: treeFolders, files: treeFiles };
}

/** What trashing a folder takes with it. */
export interface FolderTrashContents {
  /** The folder itself first, then the folders under it that go too. */
  folderIds: string[];
  fileIds: string[];
}

/**
 * What trashing `rootId` takes with it: the folders under it the caller may
 * change (one they may not stays live, with everything in it), and the files
 * in the folders taken that the caller may change. A restricted file the
 * caller cannot see stays where it is: the same rule that refuses the purge.
 */
export function trashableContents(
  access: DriveAccessIndex,
  rootId: string,
  tree: Awaited<ReturnType<typeof listLiveFolderTree>>,
): FolderTrashContents {
  const children = new Map<string, typeof tree.folders>();
  for (const folder of tree.folders) {
    if (!folder.parentId) continue;
    children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder]);
  }
  const folderIds = [rootId];
  const taken = new Set(folderIds);
  for (let i = 0; i < folderIds.length; i++) {
    for (const child of children.get(folderIds[i]) ?? []) {
      if (taken.has(child.id) || !canEdit(folderRole(access, child))) continue;
      taken.add(child.id);
      folderIds.push(child.id);
    }
  }
  const fileIds = tree.files
    .filter((file) => file.folderId && taken.has(file.folderId) && canEdit(fileRole(access, file)))
    .map((file) => file.id);
  return { folderIds, fileIds };
}

/**
 * Trash a folder with what `contents` says goes with it (`trashableContents`),
 * all with the same `deleted_at` and in one statement, so nothing the caller
 * could change stays listed as live in a trashed folder (TASK-1432) and
 * `restoreFolder` brings back exactly what went with it. Without `contents`,
 * the folder goes alone.
 */
export async function softDeleteFolder(
  db: Database,
  id: string,
  contents: FolderTrashContents = { folderIds: [id], fileIds: [] },
) {
  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), isNull(folders.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const now = new Date().toISOString();
  const folderIds = contents.folderIds.includes(id) ? contents.folderIds : [id, ...contents.folderIds];
  const fileCondition = contents.fileIds.length > 0 ? inArray(files.id, contents.fileIds) : sql`false`;
  await db.execute(sql`
    with trashed_files as (
      update ${files} set deleted_at = ${now}::timestamp, updated_at = ${now}::timestamp
      where ${fileCondition} and deleted_at is null
    )
    update ${folders} set deleted_at = ${now}::timestamp, updated_at = ${now}::timestamp
    where ${inArray(folders.id, folderIds)} and deleted_at is null
  `);
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

/**
 * Take a folder out of the trash with what went in with it: the folders
 * under it and the files in them trashed at the same instant. Anything
 * trashed on its own before stays in the trash.
 */
export async function restoreFolder(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), isNotNull(folders.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const now = new Date().toISOString();
  await db.execute(sql`
    with recursive tree as (
      select id, deleted_at from folders where id = ${id}
      union
      select f.id, f.deleted_at from folders f join tree on f.parent_id = tree.id where f.deleted_at = tree.deleted_at
    ),
    restored_files as (
      update files set deleted_at = null, updated_at = ${now}::timestamp
      where folder_id in (select id from tree) and deleted_at = (select deleted_at from folders where id = ${id})
    )
    update folders set deleted_at = null, updated_at = ${now}::timestamp
    where id in (select id from tree)
  `);
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
 * A trashed folder and the folders under it trashed together with it (the
 * same `deleted_at`), as a subquery of ids: what restoring it brings back,
 * and so what purging it takes.
 */
function trashedTreeIds(id: string): SQL {
  return sql`(with recursive tree as (
    select id, deleted_at from folders where id = ${id} and deleted_at is not null
    union
    select f.id, f.deleted_at from folders f join tree on f.parent_id = tree.id where f.deleted_at = tree.deleted_at
  ) select id from tree)`;
}

/**
 * What purging a trashed folder takes for good: the folder, the folders
 * trashed with it (`treeFolders`, the folder itself included) and every file
 * in them, trashed or not. Returned first so the route can check access and
 * clean up R2 before deleting rows.
 */
export async function loadFolderFilesForPurge(db: Database, folderId: string) {
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), isNotNull(folders.deletedAt)))
    .limit(1);
  if (!folder) return null;
  const treeFolders = await db
    .select({
      id: folders.id,
      parentId: folders.parentId,
      createdById: folders.createdById,
      generalAccess: folders.generalAccess,
    })
    .from(folders)
    .where(sql`${folders.id} in ${trashedTreeIds(folderId)}`);
  const folderFiles = await listFilesInFolders(db, treeFolders.map((f) => f.id));
  return { folder, treeFolders, folderFiles };
}

/** Hard delete trashed folders (a purged folder's tree) and every file in them. */
export async function purgeFolder(db: Database, folderIds: string[]) {
  if (folderIds.length === 0) return;
  // Caller deletes R2 objects first via loadFolderFilesForPurge. A spreadsheet's,
  // document's or board's row references its file, so those rows go first.
  const inFolders = db.select({ id: files.id }).from(files).where(inArray(files.folderId, folderIds));
  await db.delete(schema.sheets).where(inArray(schema.sheets.fileId, inFolders));
  await db.delete(schema.whiteboards).where(inArray(schema.whiteboards.fileId, inFolders));
  await db.delete(schema.documentVersions).where(inArray(schema.documentVersions.fileId, inFolders));
  await db.delete(schema.docs).where(inArray(schema.docs.fileId, inFolders));
  await db.delete(files).where(inArray(files.folderId, folderIds));
  await db.delete(folders).where(and(inArray(folders.id, folderIds), isNotNull(folders.deletedAt)));
}
