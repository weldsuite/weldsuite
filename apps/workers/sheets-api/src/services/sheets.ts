/**
 * Spreadsheet records: a drive `files` row (name, folder, sharing, trash)
 * paired with a `sheets` row (where the room's latest checkpoint is). Pure
 * functions over the tenant DB; access checks happen in the routes.
 */

import { and, desc, eq, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import * as filesService from '@weldsuite/core-domain/files';
import { WELDSHEET_MIME_TYPE } from '@weldsuite/app-api-client/schemas/sheets';
import type { DriveFileRef } from '@weldsuite/core-domain/drive-access';

const { files, sheets } = schema;

/** `files.entity_type` of a WeldFlow project's files, its spreadsheets included. */
export const PROJECT_ENTITY = 'project';

export interface SheetRecord {
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
  /** The WeldFlow project the sheet belongs to (its file is the project's), or null. */
  projectId: string | null;
  /** What drive access rules need to know about the file. */
  file: DriveFileRef;
}

const columns = {
  id: sheets.id,
  fileId: sheets.fileId,
  name: files.fileName,
  folderId: files.folderId,
  createdAt: sheets.createdAt,
  sheetUpdatedAt: sheets.updatedAt,
  fileUpdatedAt: files.updatedAt,
  createdById: files.uploadedById,
  updatedById: sheets.updatedById,
  revision: sheets.revision,
  snapshotKey: sheets.snapshotKey,
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
  sheetUpdatedAt: Date;
  fileUpdatedAt: Date;
  createdById: string | null;
  updatedById: string | null;
  revision: number;
  snapshotKey: string | null;
  generalAccess: DriveFileRef['generalAccess'];
  entityType: string | null;
  entityId: string | null;
}

function toRecord(r: Row): SheetRecord {
  return {
    id: r.id,
    fileId: r.fileId,
    name: r.name,
    folderId: r.folderId,
    createdAt: r.createdAt,
    updatedAt: r.sheetUpdatedAt > r.fileUpdatedAt ? r.sheetUpdatedAt : r.fileUpdatedAt,
    createdById: r.createdById,
    updatedById: r.updatedById,
    revision: r.revision,
    snapshotKey: r.snapshotKey,
    projectId: r.entityType === PROJECT_ENTITY ? r.entityId : null,
    file: {
      id: r.fileId,
      uploadedById: r.createdById,
      folderId: r.folderId,
      generalAccess: r.generalAccess,
      entityType: r.entityType,
    },
  };
}

/**
 * Sheets not in the trash, most recently changed first: a project's (with
 * `projectId`), or else the ones that belong to no project. `visible` narrows
 * them to what the caller may see.
 */
export async function listSheets(
  db: Database,
  params: { visible?: SQL; search?: string; limit: number; offset: number; projectId?: string },
): Promise<{ rows: SheetRecord[]; total: number }> {
  const where = and(
    isNull(files.deletedAt),
    params.projectId ? and(eq(files.entityType, PROJECT_ENTITY), eq(files.entityId, params.projectId)) : isNull(files.entityType),
    params.visible,
    params.search ? ilike(files.fileName, `%${escapeLike(params.search)}%`) : undefined,
  );
  const [rows, [count]] = await Promise.all([
    db
      .select(columns)
      .from(sheets)
      .innerJoin(files, eq(files.id, sheets.fileId))
      .where(where)
      .orderBy(desc(sql`greatest(${sheets.updatedAt}, ${files.updatedAt})`), desc(sheets.id))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(sheets).innerJoin(files, eq(files.id, sheets.fileId)).where(where),
  ]);
  return { rows: rows.map(toRecord), total: count?.total ?? 0 };
}

/** A sheet not in the trash, or null. */
export async function getSheet(db: Database, id: string): Promise<SheetRecord | null> {
  const [row] = await db
    .select(columns)
    .from(sheets)
    .innerJoin(files, eq(files.id, sheets.fileId))
    .where(and(eq(sheets.id, id), isNull(files.deletedAt)))
    .limit(1);
  return row ? toRecord(row) : null;
}

export interface DriveFileRecord {
  name: string;
  mimeType: string;
  size: number;
  /** Where its bytes are in R2. */
  key: string;
  /** Set when the file is itself a WeldSheets spreadsheet (nothing to import). */
  weldsheetId: string | null;
  /** The WeldFlow project the file belongs to, or null. */
  projectId: string | null;
  fileType: string;
  file: DriveFileRef;
}

/** A drive file not in the trash, with what importing it needs; null when there is none. */
export async function getDriveFile(db: Database, id: string): Promise<DriveFileRecord | null> {
  const [row] = await db
    .select({
      id: files.id,
      name: files.fileName,
      mimeType: files.mimeType,
      size: files.fileSize,
      fileKey: files.fileKey,
      storagePath: files.storagePath,
      metadata: files.metadata,
      uploadedById: files.uploadedById,
      folderId: files.folderId,
      generalAccess: files.generalAccess,
      entityType: files.entityType,
      entityId: files.entityId,
      fileType: files.fileType,
    })
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt)))
    .limit(1);
  if (!row) return null;
  const weldsheetId = (row.metadata as { weldsheetId?: unknown } | null)?.weldsheetId;
  return {
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    key: row.fileKey || row.storagePath,
    weldsheetId: typeof weldsheetId === 'string' ? weldsheetId : null,
    projectId: row.entityType === PROJECT_ENTITY ? row.entityId : null,
    fileType: row.fileType,
    file: { id: row.id, uploadedById: row.uploadedById, folderId: row.folderId, generalAccess: row.generalAccess, entityType: row.entityType },
  };
}

/** The R2 key a sheet's checkpoints are written to (one object, overwritten each time). */
export function snapshotKeyFor(workspaceId: string, sheetId: string): string {
  return `workspaces/${workspaceId}/sheets/${sheetId}/workbook.json.gz`;
}

export async function createSheet(
  db: Database,
  params: {
    workspaceId: string;
    name: string;
    folderId: string | null;
    userId: string;
    snapshotSize: number;
    sheetId?: string;
    /** A WeldFlow project the sheet belongs to. */
    projectId?: string | null;
  },
): Promise<SheetRecord> {
  const id = params.sheetId ?? generateId('sht');
  const key = snapshotKeyFor(params.workspaceId, id);
  const file = await filesService.createFile(db, {
    fileName: params.name,
    originalName: params.name,
    mimeType: WELDSHEET_MIME_TYPE,
    fileSize: params.snapshotSize,
    fileType: 'spreadsheet',
    storagePath: key,
    fileKey: key,
    bucket: 'private',
    folderId: params.folderId,
    uploadedById: params.userId,
    metadata: { weldsheetId: id },
    ...(params.projectId ? { entityType: PROJECT_ENTITY, entityId: params.projectId } : {}),
  });
  const now = new Date();
  await db.insert(sheets).values({
    id,
    fileId: file.id,
    snapshotKey: key,
    revision: 0,
    snapshotRevision: 0,
    updatedById: params.userId,
    createdAt: now,
    updatedAt: now,
  });
  const created = await getSheet(db, id);
  if (!created) throw new Error(`Sheet ${id} vanished after insert`);
  return created;
}

/**
 * Makes an existing drive file a spreadsheet, in place: an old WeldFlow
 * project sheet (.xlsx) converted on first open. The file keeps its id, its
 * project and its place; its content is now the checkpoint at the sheet's key
 * (the old .xlsx stays where it was, named in `metadata.convertedFrom`). Null
 * when someone else converted it first.
 *
 * Both writes commit as one unit (`atomically`: a single Neon batch), so a
 * failed insert can never leave the file pointing at a sheet that was never
 * written. The insert only adds the row when the update just made the file
 * point at this sheet: a convert that lost the race inserts nothing.
 */
export async function adoptFileAsSheet(
  db: Database,
  params: { fileId: string; sheetId: string; workspaceId: string; name: string; snapshotSize: number; userId: string; oldKey: string },
): Promise<SheetRecord | null> {
  const key = snapshotKeyFor(params.workspaceId, params.sheetId);
  const now = new Date();
  const converted = { weldsheetId: params.sheetId, convertedFrom: { key: params.oldKey, at: now.toISOString() } };
  const at = sql<Date>`${now.toISOString()}::timestamp`;
  await atomically(db, (h) => [
    h
      .update(files)
      .set({
        fileName: params.name,
        mimeType: WELDSHEET_MIME_TYPE,
        fileSize: params.snapshotSize,
        storagePath: key,
        fileKey: key,
        bucket: 'private',
        url: null,
        metadata: sql`coalesce(${files.metadata}, '{}'::jsonb) || ${JSON.stringify(converted)}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(files.id, params.fileId), sql`${files.metadata}->>'weldsheetId' is null`)),
    // Insert-select keys must follow the table's column order.
    h.insert(sheets).select((qb) =>
      qb
        .select({
          id: sql<string>`${params.sheetId}::varchar`.as('id'),
          createdAt: at.as('created_at'),
          updatedAt: at.as('updated_at'),
          fileId: files.id,
          revision: sql<number>`0`.as('revision'),
          snapshotKey: sql<string>`${key}::varchar`.as('snapshot_key'),
          snapshotRevision: sql<number>`0`.as('snapshot_revision'),
          updatedById: sql<string>`${params.userId}::varchar`.as('updated_by_id'),
        })
        .from(files)
        .where(and(eq(files.id, params.fileId), sql`${files.metadata}->>'weldsheetId' = ${params.sheetId}`)),
    ),
  ]);
  return getSheet(db, params.sheetId);
}

export type RenameResult = { ok: true; sheet: SheetRecord } | { ok: false; reason: 'not_found' | 'name_conflict' };

export async function renameSheet(db: Database, sheet: SheetRecord, name: string): Promise<RenameResult> {
  const result = await filesService.updateFile(db, sheet.fileId, { fileName: name });
  if (!result.ok) return result;
  const renamed = await getSheet(db, sheet.id);
  return renamed ? { ok: true, sheet: renamed } : { ok: false, reason: 'not_found' };
}

/** Moves the sheet's file to the trash (WeldDrive purges it after 30 days). */
export async function trashSheet(db: Database, sheet: SheetRecord): Promise<boolean> {
  const result = await filesService.softDeleteFile(db, sheet.fileId);
  return result.ok;
}

/** The room wrote a checkpoint: record where it is, and that the sheet changed. */
export async function recordCheckpoint(
  db: Database,
  sheetId: string,
  params: { revision: number; snapshotKey: string; size: number; userId: string | null },
): Promise<SheetRecord | null> {
  const now = new Date();
  const [row] = await db
    .update(sheets)
    .set({
      revision: params.revision,
      snapshotRevision: params.revision,
      snapshotKey: params.snapshotKey,
      updatedAt: now,
      ...(params.userId ? { updatedById: params.userId } : {}),
    })
    .where(eq(sheets.id, sheetId))
    .returning({ fileId: sheets.fileId });
  if (!row) return null;
  await db.update(files).set({ fileSize: params.size }).where(eq(files.id, row.fileId));
  return getSheet(db, sheetId);
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
