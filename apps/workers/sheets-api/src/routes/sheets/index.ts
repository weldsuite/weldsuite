/**
 * Spreadsheet routes — /api/sheets/*.
 *
 * A spreadsheet is a WeldDrive file plus a `sheets` row, so who may see or
 * change it follows WeldDrive's sharing rules (owner, shares, general access,
 * folders) on top of the `sheets:*` permissions. A sheet the caller may not
 * see is a 404.
 *
 *   GET    /api/sheets              → sheets the caller can see
 *   POST   /api/sheets              → create (an empty workbook, in My Drive or a folder)
 *   GET    /api/sheets/:id          → one sheet
 *   PATCH  /api/sheets/:id          → rename
 *   DELETE /api/sheets/:id          → move to the trash
 *   POST   /api/sheets/:id/session  → ticket for the sheet's room socket
 *   POST   /api/sheets/import       → a new spreadsheet from an .xlsx/.csv/.tsv (upload or WeldDrive file)
 *   GET    /api/sheets/:id/export   → the spreadsheet as .xlsx or .csv
 *
 * The workbook is otherwise edited over the room socket
 * (`/api/sheets/connect`, see ../../room/connect.ts); an export is written
 * by the room, so it includes edits not checkpointed yet.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  EN_LOCALE,
  ImportError,
  NL_LOCALE,
  Sheet,
  Workbook,
  readSpreadsheet,
  type ImportResult,
  type WorkbookSnapshot,
} from '@weldsuite/sheets-engine';
import { getStoredObject, isWorkspaceObjectKey } from '@weldsuite/worker-kit/storage';
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
  SHEET_IMPORT_MAX_BYTES,
  createSheetSchema,
  exportSheetQuerySchema,
  importDriveFileSchema,
  listSheetsQuerySchema,
  sheetFileLocaleSchema,
  updateSheetSchema,
  type ImportDriveFileInput,
  type SheetFileLocale,
  type SheetImportFailure,
  type SheetImportResult,
  type SheetSession,
  type SheetSummary,
} from '@weldsuite/app-api-client/schemas/sheets';
import type { Env, Variables } from '../../types';
import {
  createSheet,
  getDriveFile,
  getSheet,
  listSheets,
  memberProfile,
  renameSheet,
  snapshotKeyFor,
  trashSheet,
  type SheetRecord,
} from '../../services/sheets';
import { writeSnapshot } from '../../room/snapshot';
import { colorFor, newTabId } from '../../room/people';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const VIEW_ONLY = 'You can view this spreadsheet but not change it';
const DEFAULT_LIMIT = 50;

/** The sheet with the caller's role on it, or the response to send instead. */
async function findSheet(c: Ctx, id: string): Promise<{ sheet: SheetRecord; role: DriveRole } | Response> {
  const db = c.get('tenantDb');
  const sheet = await getSheet(db, id);
  const role = sheet ? fileRole(await loadDriveAccessForUser(db, c.get('userId') ?? null), sheet.file) : null;
  if (!sheet || !role) return error.notFound(c, 'Spreadsheet', id);
  return { sheet, role };
}

/** Write access needs the drive role, `sheets:update`, and a workspace that is not read-only. */
async function mayUpdate(c: Ctx): Promise<boolean> {
  return !c.get('readOnly') && (await hasContextPermission(c, 'sheets:update'));
}

function toSummary(sheet: SheetRecord, role: DriveRole, mayEdit: boolean): SheetSummary {
  return {
    id: sheet.id,
    fileId: sheet.fileId,
    name: sheet.name,
    folderId: sheet.folderId,
    createdAt: sheet.createdAt.toISOString(),
    updatedAt: sheet.updatedAt.toISOString(),
    createdById: sheet.createdById,
    updatedById: sheet.updatedById,
    role,
    canEdit: mayEdit && canEdit(role),
  };
}

function eventData(sheet: SheetRecord): DataFor<'sheet'> {
  return { id: sheet.id, fileId: sheet.fileId, name: sheet.name, updatedById: sheet.updatedById };
}

app.get('/', requirePermission('sheets:read'), zValidator('query', listSheetsQuerySchema), async (c) => {
  const { search, limit = DEFAULT_LIMIT, cursor } = c.req.valid('query');
  const db = c.get('tenantDb');
  const access = await loadDriveAccessForUser(db, c.get('userId') ?? null);
  const offset = cursor ? Number(cursor) : 0;
  const { rows, total } = await listSheets(db, { visible: visibleFilesCondition(access), search, limit, offset });
  const mayEdit = await mayUpdate(c);
  const data = rows.map((sheet) => toSummary(sheet, fileRole(access, sheet.file) ?? 'viewer', mayEdit));
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

/** Stores a new spreadsheet holding `workbook`, with its drive file, and reports both. */
async function saveNewSheet(
  c: Ctx,
  params: { workspaceId: string; userId: string; name: string; folderId: string | null; workbook: WorkbookSnapshot },
): Promise<SheetRecord> {
  const { workbook, ...record } = params;
  // The first checkpoint goes in before the rows, so a room never opens a sheet without one.
  const sheetId = generateId('sht');
  const size = await writeSnapshot(c.env.PRIVATE_STORAGE, snapshotKeyFor(record.workspaceId, sheetId), { revision: 0, workbook });
  const sheet = await createSheet(c.get('tenantDb'), { ...record, sheetId, snapshotSize: size });
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: sheet.fileId,
    action: 'created',
    data: { id: sheet.fileId, name: sheet.name, folderId: sheet.folderId, fileType: 'spreadsheet', fileSize: size },
  });
  publishEntityEvent({ c, entityType: 'sheet', entityId: sheet.id, action: 'created', data: eventData(sheet) });
  return sheet;
}

app.post('/', requirePermission('sheets:create'), zValidator('json', createSheetSchema), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const { name, folderId = null, firstTabName } = c.req.valid('json');
  const folder = await editableFolder(c, folderId);
  if (folder instanceof Response) return folder;

  const workbook = new Workbook();
  workbook.sheets.push(new Sheet(newTabId(), firstTabName ?? 'Sheet1'));
  const sheet = await saveNewSheet(c, { workspaceId, userId, name, folderId: folder, workbook: workbook.toJSON() });
  return success(c, toSummary(sheet, 'owner', await mayUpdate(c)), 201);
});

// ---------------------------------------------------------------------------
// Files: import and export
// ---------------------------------------------------------------------------

/** Most cells an imported workbook may have, until sheets load in parts (plan phase 9). */
const MAX_IMPORT_CELLS = 250_000;
/** Room for the multipart envelope around the largest file. */
const MULTIPART_SLACK = 64 * 1024;
const LOCALES = { en: EN_LOCALE, nl: NL_LOCALE } as const;

interface ImportSource {
  bytes: Uint8Array;
  fileName: string;
  name?: string;
  /** Where the new spreadsheet goes: asked for, or (for a drive file) next to the file when the caller may add there. */
  folderId: string | null;
  folderAsked: boolean;
  locale?: SheetFileLocale;
}

function tooLarge(c: Ctx): Response {
  const mb = Math.round(SHEET_IMPORT_MAX_BYTES / 1024 / 1024);
  return error.badRequest(c, `Files up to ${mb} MB can be imported`, { reason: 'too_large' satisfies SheetImportFailure });
}

/** An upload (multipart/form-data) or a WeldDrive file (JSON `fileId`); or the response to send instead. */
async function importSource(c: Ctx): Promise<ImportSource | Response> {
  if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) return uploadSource(c);
  const parsed = importDriveFileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return error.badRequest(c, 'Send a file, or the id of a WeldDrive file', parsed.error.flatten());
  return driveSource(c, parsed.data);
}

async function uploadSource(c: Ctx): Promise<ImportSource | Response> {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return error.badRequest(c, 'Add the file to import as "file"');
  if (file.size > SHEET_IMPORT_MAX_BYTES) return tooLarge(c);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 255) : '';
  const folderId = typeof body.folderId === 'string' && body.folderId ? body.folderId : null;
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name,
    name: name || undefined,
    folderId,
    folderAsked: true,
    locale: sheetFileLocaleSchema.safeParse(body.locale).data,
  };
}

async function driveSource(c: Ctx, input: ImportDriveFileInput): Promise<ImportSource | Response> {
  const db = c.get('tenantDb');
  const file = await getDriveFile(db, input.fileId);
  const role = file ? fileRole(await loadDriveAccessForUser(db, c.get('userId') ?? null), file.file) : null;
  if (!file || !role) return error.notFound(c, 'File', input.fileId);
  if (file.weldsheetId) return error.badRequest(c, 'This file is already a spreadsheet', { reason: 'unsupported' satisfies SheetImportFailure });
  if (file.size > SHEET_IMPORT_MAX_BYTES) return tooLarge(c);
  // A row's key came from a client: never let it reach another workspace's objects.
  if (!file.key || !isWorkspaceObjectKey(file.key, c.get('workspaceId'))) return error.notFound(c, 'File content', input.fileId);
  const object = await getStoredObject(c.env, file.key);
  if (!object) return error.notFound(c, 'File content', input.fileId);
  const asked = input.folderId !== undefined;
  return {
    bytes: new Uint8Array(await object.arrayBuffer()),
    fileName: file.name,
    name: input.name,
    folderId: asked ? (input.folderId ?? null) : file.file.folderId,
    folderAsked: asked,
    locale: input.locale,
  };
}

/** The new spreadsheet's folder: the one asked for (which must be editable), else the source's when it is. */
async function importFolder(c: Ctx, source: ImportSource): Promise<string | null | Response> {
  const folder = await editableFolder(c, source.folderId);
  if (folder instanceof Response && !source.folderAsked) return null;
  return folder;
}

app.post('/import', requirePermission('sheets:create'), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  if (Number(c.req.header('content-length')) > SHEET_IMPORT_MAX_BYTES + MULTIPART_SLACK) return tooLarge(c);
  const source = await importSource(c);
  if (source instanceof Response) return source;
  const folderId = await importFolder(c, source);
  if (folderId instanceof Response) return folderId;

  let result: ImportResult;
  try {
    result = await readSpreadsheet(source.fileName, source.bytes, {
      locale: LOCALES[source.locale ?? 'en'],
      maxCells: MAX_IMPORT_CELLS,
      sheetId: () => newTabId(),
    });
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    return error.badRequest(c, err.message, { reason: err.code satisfies SheetImportFailure });
  }
  const name = (source.name || source.fileName.replace(/\.[^.]+$/, '')).trim().slice(0, 255) || 'Untitled spreadsheet';
  const sheet = await saveNewSheet(c, { workspaceId, userId, name, folderId, workbook: result.workbook });
  return success(c, { sheet: toSummary(sheet, 'owner', await mayUpdate(c)), warnings: result.warnings } satisfies SheetImportResult, 201);
});

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
} as const;

/** `attachment` with an ASCII fallback name and the real one (RFC 6266). */
function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

app.get('/:id/export', requirePermission('sheets:read'), zValidator('query', exportSheetQuerySchema), async (c) => {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const { sheet } = found;
  const { format, tab, locale } = c.req.valid('query');
  const room = c.env.SHEET_ROOM.get(c.env.SHEET_ROOM.idFromName(`${workspaceId}:${sheet.id}`));
  const file = await room.exportFile(
    { workspaceId, sheetId: sheet.id, snapshotKey: sheet.snapshotKey ?? snapshotKeyFor(workspaceId, sheet.id) },
    { format, tab, locale },
  );
  if (!file) return error.notFound(c, 'Tab', tab);
  const fileName = file.tabName === null ? `${sheet.name}.${format}` : `${sheet.name} - ${file.tabName}.${format}`;
  return new Response(file.bytes, {
    headers: {
      'Content-Type': CONTENT_TYPES[format],
      'Content-Disposition': attachment(fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

app.get('/:id', requirePermission('sheets:read'), async (c) => {
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  return success(c, toSummary(found.sheet, found.role, await mayUpdate(c)));
});

app.patch('/:id', requirePermission('sheets:update'), zValidator('json', updateSheetSchema), async (c) => {
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  if (!canEdit(found.role)) return error.forbidden(c, VIEW_ONLY);
  const { name } = c.req.valid('json');
  const result = await renameSheet(c.get('tenantDb'), found.sheet, name);
  if (!result.ok) {
    return result.reason === 'name_conflict'
      ? error.conflict(c, 'A file with this name already exists in this folder')
      : error.notFound(c, 'Spreadsheet', found.sheet.id);
  }
  const { sheet } = result;
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: sheet.fileId,
    action: 'updated',
    data: { id: sheet.fileId, name: sheet.name, folderId: sheet.folderId, fileType: 'spreadsheet' },
    changes: { name: { old: found.sheet.name, new: sheet.name } },
  });
  publishEntityEvent({
    c,
    entityType: 'sheet',
    entityId: sheet.id,
    action: 'updated',
    data: eventData(sheet),
    changes: { name: { old: found.sheet.name, new: sheet.name } },
  });
  return success(c, toSummary(sheet, found.role, true));
});

app.delete('/:id', requirePermission('sheets:delete'), async (c) => {
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  if (!canEdit(found.role)) return error.forbidden(c, VIEW_ONLY);
  const { sheet } = found;
  if (!(await trashSheet(c.get('tenantDb'), sheet))) return error.notFound(c, 'Spreadsheet', sheet.id);
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: sheet.fileId,
    action: 'deleted',
    data: { id: sheet.fileId, name: sheet.name, folderId: sheet.folderId, fileType: 'spreadsheet' },
  });
  publishEntityEvent({ c, entityType: 'sheet', entityId: sheet.id, action: 'deleted', data: eventData(sheet) });
  return noContent(c);
});

app.post('/:id/session', requirePermission('sheets:read'), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const { sheet, role } = found;

  const mayEdit = canEdit(role) && (await mayUpdate(c));
  const profile = await memberProfile(c.get('tenantDb'), userId);
  const color = colorFor(userId);
  const room = c.env.SHEET_ROOM.get(c.env.SHEET_ROOM.idFromName(`${workspaceId}:${sheet.id}`));
  const ticket = await room.admit({
    workspaceId,
    sheetId: sheet.id,
    snapshotKey: sheet.snapshotKey ?? snapshotKeyFor(workspaceId, sheet.id),
    userId,
    name: profile.name ?? 'Unknown',
    picture: profile.picture,
    color,
    canEdit: mayEdit,
  });
  return success(c, { ticket, canEdit: mayEdit, color } satisfies SheetSession);
});

export default app;
