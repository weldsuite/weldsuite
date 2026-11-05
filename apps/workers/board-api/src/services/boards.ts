/**
 * Board records: a drive `files` row (name, folder, sharing, trash) paired
 * with a `whiteboards` row (where the room's latest checkpoint is). Pure
 * functions over the tenant DB; access checks happen in the routes.
 *
 * A WeldFlow project's board is one whose file has `entity_type` 'project'.
 * Old WeldFlow whiteboards (`project_whiteboards`, an `elements[]` array
 * saved whole) are listed next to the project's boards until someone opens
 * one: it is then converted in place (`convertLegacy`), keeping its id.
 */

import { and, desc, eq, ilike, inArray, isNull, notExists, sql, type SQL } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import * as filesService from '@weldsuite/core-domain/files';
import { WELDBOARD_MIME_TYPE, type BoardTemplateCategory } from '@weldsuite/app-api-client/schemas/boards';
import type { DriveFileRef } from '@weldsuite/core-domain/drive-access';

const { files, whiteboards, projectWhiteboards } = schema;

/** `files.entity_type` of a WeldFlow project's files, its boards included. */
export const PROJECT_ENTITY = 'project';

/** `files.file_type` of a board. */
export const BOARD_FILE_TYPE = 'whiteboard';

export interface BoardRecord {
  id: string;
  /** Null for an old WeldFlow whiteboard not converted yet. */
  fileId: string | null;
  name: string;
  folderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
  updatedById: string | null;
  revision: number;
  snapshotKey: string | null;
  /** The WeldFlow project the board belongs to, or null. */
  projectId: string | null;
  templateCategory: BoardTemplateCategory | null;
  /** An old WeldFlow whiteboard: it becomes a board the first time someone opens it. */
  legacy: boolean;
  /** What drive access rules need to know about the file (null for a legacy whiteboard). */
  file: DriveFileRef | null;
}

/** A board that is a real board (converted), with its drive file. */
export type LiveBoardRecord = BoardRecord & { fileId: string; file: DriveFileRef; legacy: false };

export function isLive(board: BoardRecord): board is LiveBoardRecord {
  return !board.legacy && board.fileId !== null && board.file !== null;
}

const columns = {
  id: whiteboards.id,
  fileId: whiteboards.fileId,
  name: files.fileName,
  folderId: files.folderId,
  createdAt: whiteboards.createdAt,
  boardUpdatedAt: whiteboards.updatedAt,
  fileUpdatedAt: files.updatedAt,
  createdById: files.uploadedById,
  updatedById: whiteboards.updatedById,
  revision: whiteboards.revision,
  snapshotKey: whiteboards.snapshotKey,
  isTemplate: whiteboards.isTemplate,
  templateCategory: whiteboards.templateCategory,
  generalAccess: files.generalAccess,
  entityType: files.entityType,
  entityId: files.entityId,
};

interface Row {
  id: string;
  fileId: string;
  name: string;
  folderId: string | null;
  createdAt: Date;
  boardUpdatedAt: Date;
  fileUpdatedAt: Date;
  createdById: string | null;
  updatedById: string | null;
  revision: number;
  snapshotKey: string | null;
  isTemplate: boolean;
  templateCategory: string | null;
  generalAccess: DriveFileRef['generalAccess'];
  entityType: string | null;
  entityId: string | null;
}

function toRecord(r: Row): LiveBoardRecord {
  return {
    id: r.id,
    fileId: r.fileId,
    name: r.name,
    folderId: r.folderId,
    createdAt: r.createdAt,
    updatedAt: r.boardUpdatedAt > r.fileUpdatedAt ? r.boardUpdatedAt : r.fileUpdatedAt,
    createdById: r.createdById,
    updatedById: r.updatedById,
    revision: r.revision,
    snapshotKey: r.snapshotKey,
    projectId: r.entityType === PROJECT_ENTITY ? r.entityId : null,
    templateCategory: r.isTemplate ? ((r.templateCategory ?? 'other') as BoardTemplateCategory) : null,
    legacy: false,
    file: {
      id: r.fileId,
      uploadedById: r.createdById,
      folderId: r.folderId,
      generalAccess: r.generalAccess,
      entityType: r.entityType,
    },
  };
}

const legacyColumns = {
  id: projectWhiteboards.id,
  name: projectWhiteboards.name,
  projectId: projectWhiteboards.projectId,
  createdAt: projectWhiteboards.createdAt,
  updatedAt: projectWhiteboards.updatedAt,
  lastEditedBy: projectWhiteboards.lastEditedBy,
  version: projectWhiteboards.version,
};

interface LegacyRow {
  id: string;
  name: string;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
  lastEditedBy: string | null;
  version: number;
}

function legacyRecord(r: LegacyRow): BoardRecord {
  return {
    id: r.id,
    fileId: null,
    name: r.name,
    folderId: null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    createdById: null,
    updatedById: r.lastEditedBy ?? null,
    revision: 0,
    snapshotKey: null,
    projectId: r.projectId,
    templateCategory: null,
    legacy: true,
    file: null,
  };
}

/** An old WeldFlow whiteboard that has not become a board yet (converting keeps the id). */
const notConverted = notExists(sql`(select 1 from ${whiteboards} where ${whiteboards.id} = ${projectWhiteboards.id})`);

/**
 * Which boards a list shows: one project's (`projectId`), every project's the
 * caller may open (`projects`: the ids, or null for all live projects), the
 * workspace's templates, or else the boards that belong to no project.
 */
export type BoardScope =
  | { kind: 'drive' }
  | { kind: 'templates' }
  | { kind: 'project'; projectId: string }
  | { kind: 'projects'; projectIds: string[] | null };

/** Most boards a project-scoped page may reach into (legacy and new boards are merged in memory). */
const MAX_PROJECT_WINDOW = 2000;

/** Boards not in the trash, most recently changed first. `visible` narrows them to what the caller may see. */
/** Ids in descending order, compared by code unit (the tie-break after `updatedAt`). */
function idsDescending(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

export async function listBoards(
  db: Database,
  params: { scope: BoardScope; visible?: SQL; search?: string; limit: number; offset: number },
): Promise<{ rows: BoardRecord[]; total: number }> {
  const { scope } = params;
  const search = params.search ? `%${escapeLike(params.search)}%` : null;
  const where = and(
    isNull(files.deletedAt),
    scopeCondition(scope),
    params.visible,
    search ? ilike(files.fileName, search) : undefined,
  );
  const order = [desc(sql`greatest(${whiteboards.updatedAt}, ${files.updatedAt})`), desc(whiteboards.id)];
  const count = () =>
    db.select({ total: sql<number>`count(*)::int` }).from(whiteboards).innerJoin(files, eq(files.id, whiteboards.fileId)).where(where);

  if (scope.kind !== 'project' && scope.kind !== 'projects') {
    const [rows, [counted]] = await Promise.all([
      db.select(columns).from(whiteboards).innerJoin(files, eq(files.id, whiteboards.fileId)).where(where).orderBy(...order).limit(params.limit).offset(params.offset),
      count(),
    ]);
    return { rows: rows.map(toRecord), total: counted?.total ?? 0 };
  }

  // Project boards and not-yet-converted whiteboards, merged by last change.
  const window = Math.min(params.offset + params.limit, MAX_PROJECT_WINDOW);
  const legacyWhere = and(
    isNull(projectWhiteboards.deletedAt),
    notConverted,
    scope.kind === 'project' ? eq(projectWhiteboards.projectId, scope.projectId) : projectIn(projectWhiteboards.projectId, scope.projectIds),
    search ? ilike(projectWhiteboards.name, search) : undefined,
  );
  const [rows, [counted], legacy, [legacyCounted]] = await Promise.all([
    db.select(columns).from(whiteboards).innerJoin(files, eq(files.id, whiteboards.fileId)).where(where).orderBy(...order).limit(window),
    count(),
    db.select(legacyColumns).from(projectWhiteboards).where(legacyWhere).orderBy(desc(projectWhiteboards.updatedAt), desc(projectWhiteboards.id)).limit(window),
    db.select({ total: sql<number>`count(*)::int` }).from(projectWhiteboards).where(legacyWhere),
  ]);
  const merged: BoardRecord[] = [...rows.map(toRecord), ...legacy.map(legacyRecord)].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || idsDescending(a.id, b.id),
  );
  return { rows: merged.slice(params.offset, params.offset + params.limit), total: (counted?.total ?? 0) + (legacyCounted?.total ?? 0) };
}

function scopeCondition(scope: BoardScope): SQL | undefined {
  switch (scope.kind) {
    case 'drive':
      return isNull(files.entityType);
    case 'templates':
      return and(eq(whiteboards.isTemplate, true), isNull(files.entityType));
    case 'project':
      return and(eq(files.entityType, PROJECT_ENTITY), eq(files.entityId, scope.projectId));
    case 'projects':
      return and(eq(files.entityType, PROJECT_ENTITY), projectIn(files.entityId, scope.projectIds));
  }
}

/** A column holding a project id: in `ids`, or (null) any live project. */
function projectIn(column: typeof files.entityId | typeof projectWhiteboards.projectId, ids: string[] | null): SQL {
  if (ids === null) {
    return sql`exists (select 1 from ${schema.projects} where ${schema.projects.id} = ${column} and ${schema.projects.deletedAt} is null)`;
  }
  return inArray(column, ids.length ? ids : ['']);
}

/** A board not in the trash, or an old WeldFlow whiteboard not converted yet; null when neither. */
export async function getBoard(db: Database, id: string): Promise<BoardRecord | null> {
  const [row] = await db
    .select(columns)
    .from(whiteboards)
    .innerJoin(files, eq(files.id, whiteboards.fileId))
    .where(and(eq(whiteboards.id, id), isNull(files.deletedAt)))
    .limit(1);
  if (row) return toRecord(row);
  const [legacy] = await db
    .select(legacyColumns)
    .from(projectWhiteboards)
    .where(and(eq(projectWhiteboards.id, id), isNull(projectWhiteboards.deletedAt), notConverted))
    .limit(1);
  return legacy ? legacyRecord(legacy) : null;
}

/** A converted board (never a legacy whiteboard), or null. */
export async function getLiveBoard(db: Database, id: string): Promise<LiveBoardRecord | null> {
  const board = await getBoard(db, id);
  return board && isLive(board) ? board : null;
}

/** The R2 key a board's checkpoints are written to (one object, overwritten each time). */
export function snapshotKeyFor(workspaceId: string, boardId: string): string {
  return `workspaces/${workspaceId}/boards/${boardId}/board.json.gz`;
}

export async function createBoard(
  db: Database,
  params: {
    workspaceId: string;
    name: string;
    folderId: string | null;
    userId: string;
    snapshotSize: number;
    boardId: string;
    projectId?: string | null;
    templateCategory?: BoardTemplateCategory | null;
  },
): Promise<LiveBoardRecord> {
  const id = params.boardId;
  const key = snapshotKeyFor(params.workspaceId, id);
  const file = await filesService.createFile(db, {
    fileName: params.name,
    originalName: params.name,
    mimeType: WELDBOARD_MIME_TYPE,
    fileSize: params.snapshotSize,
    fileType: BOARD_FILE_TYPE,
    storagePath: key,
    fileKey: key,
    bucket: 'private',
    folderId: params.projectId ? null : params.folderId,
    uploadedById: params.userId,
    metadata: { weldBoardId: id },
    ...(params.projectId ? { entityType: PROJECT_ENTITY, entityId: params.projectId } : {}),
  });
  const now = new Date();
  await db.insert(whiteboards).values({
    id,
    fileId: file.id,
    snapshotKey: key,
    revision: 0,
    snapshotRevision: 0,
    isTemplate: !!params.templateCategory,
    templateCategory: params.templateCategory ?? null,
    updatedById: params.userId,
    createdAt: now,
    updatedAt: now,
  });
  const created = await getLiveBoard(db, id);
  if (!created) throw new Error(`Board ${id} vanished after insert`);
  return created;
}

/** An old WeldFlow whiteboard's content, for the converter. */
export async function legacyElements(db: Database, id: string): Promise<{ elements: unknown[]; lastEditedBy: string | null } | null> {
  const [row] = await db
    .select({ elements: projectWhiteboards.elements, lastEditedBy: projectWhiteboards.lastEditedBy })
    .from(projectWhiteboards)
    .where(and(eq(projectWhiteboards.id, id), isNull(projectWhiteboards.deletedAt)))
    .limit(1);
  if (!row) return null;
  return { elements: Array.isArray(row.elements) ? row.elements : [], lastEditedBy: row.lastEditedBy ?? null };
}

/**
 * Makes an old WeldFlow whiteboard a board, in place: same id, same project.
 * The drive file, the board row and the old row's soft delete commit as one
 * unit (`atomically`), so nothing is left half converted. The checkpoint at
 * the board's key must already be written. Null when someone else converted
 * it first (the board row's insert then fails, and the rest with it).
 */
export async function convertLegacy(
  db: Database,
  params: { legacy: BoardRecord; workspaceId: string; snapshotSize: number; userId: string },
): Promise<LiveBoardRecord | null> {
  const { legacy } = params;
  const projectId = legacy.projectId;
  if (!legacy.legacy || !projectId) throw new Error(`Board ${legacy.id} is not an old WeldFlow whiteboard`);
  const key = snapshotKeyFor(params.workspaceId, legacy.id);
  const fileId = generateId('fil');
  const now = new Date();
  const name = (await filesService.deduplicateFileName(db, legacy.name, null)) || legacy.name;
  try {
    await atomically(db, (h) => [
      h.insert(files).values({
        id: fileId,
        fileName: name,
        originalName: legacy.name,
        mimeType: WELDBOARD_MIME_TYPE,
        fileSize: params.snapshotSize,
        fileType: BOARD_FILE_TYPE,
        storagePath: key,
        fileKey: key,
        bucket: 'private',
        folderId: null,
        uploadedById: legacy.updatedById ?? params.userId,
        isPublic: false,
        entityType: PROJECT_ENTITY,
        entityId: projectId,
        metadata: { weldBoardId: legacy.id, convertedFrom: { table: 'project_whiteboards', at: now.toISOString() } },
        createdAt: legacy.createdAt,
        updatedAt: now,
      }),
      h.insert(whiteboards).values({
        id: legacy.id,
        fileId,
        snapshotKey: key,
        revision: 0,
        snapshotRevision: 0,
        isTemplate: false,
        templateCategory: null,
        updatedById: legacy.updatedById ?? params.userId,
        createdAt: legacy.createdAt,
        updatedAt: now,
      }),
      h
        .update(projectWhiteboards)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(projectWhiteboards.id, legacy.id), isNull(projectWhiteboards.deletedAt))),
    ]);
  } catch (err) {
    // Lost the race: the other convert's board stands.
    if (await getLiveBoard(db, legacy.id)) return null;
    throw err;
  }
  return getLiveBoard(db, legacy.id);
}

export type UpdateResult =
  | { ok: true; board: LiveBoardRecord; previous: typeof files.$inferSelect | null }
  | { ok: false; reason: 'not_found' | 'name_conflict' };

/**
 * Renames and/or moves the board's drive file, and makes it a template or
 * not. `folderId` undefined leaves the folder alone; null is My Drive.
 * `template` undefined leaves it alone; null stops it being one.
 */
export async function updateBoard(
  db: Database,
  board: LiveBoardRecord,
  changes: { name?: string; folderId?: string | null; template?: { category: BoardTemplateCategory } | null },
): Promise<UpdateResult> {
  let previous: typeof files.$inferSelect | null = null;
  if (changes.name !== undefined || changes.folderId !== undefined) {
    const result = await filesService.updateFile(db, board.fileId, { fileName: changes.name, folderId: changes.folderId });
    if (!result.ok) return result;
    previous = result.previous;
  }
  if (changes.template !== undefined) {
    await db
      .update(whiteboards)
      .set({ isTemplate: changes.template !== null, templateCategory: changes.template?.category ?? null, updatedAt: new Date() })
      .where(eq(whiteboards.id, board.id));
  }
  const updated = await getLiveBoard(db, board.id);
  return updated ? { ok: true, board: updated, previous } : { ok: false, reason: 'not_found' };
}

/** Moves the board's file to the trash (WeldDrive purges it after 30 days). */
export async function trashBoard(db: Database, board: LiveBoardRecord): Promise<boolean> {
  const result = await filesService.softDeleteFile(db, board.fileId);
  return result.ok;
}

/** Deletes an old WeldFlow whiteboard that was never converted (soft delete, like WeldFlow did). */
export async function trashLegacy(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(projectWhiteboards)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(projectWhiteboards.id, id), isNull(projectWhiteboards.deletedAt)))
    .returning({ id: projectWhiteboards.id });
  return rows.length > 0;
}

/** The room wrote a checkpoint: record where it is, and that the board changed. */
export async function recordCheckpoint(
  db: Database,
  boardId: string,
  params: { revision: number; snapshotKey: string; size: number; userId: string | null },
): Promise<LiveBoardRecord | null> {
  const now = new Date();
  const person = params.userId && !params.userId.startsWith('server:') ? params.userId : null;
  const [row] = await db
    .update(whiteboards)
    .set({
      revision: params.revision,
      snapshotRevision: params.revision,
      snapshotKey: params.snapshotKey,
      updatedAt: now,
      ...(person ? { updatedById: person } : {}),
    })
    .where(eq(whiteboards.id, boardId))
    .returning({ fileId: whiteboards.fileId });
  if (!row) return null;
  await db.update(files).set({ fileSize: params.size }).where(eq(files.id, row.fileId));
  return getLiveBoard(db, boardId);
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

/** Whether a project exists and is not deleted. */
export async function projectExists(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  return !!row;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
