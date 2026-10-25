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
 *   POST   /api/sheets/convert      → an old WeldFlow project sheet made a spreadsheet, in place
 *   GET    /api/sheets/:id/export   → the spreadsheet as .xlsx or .csv
 *   /api/sheets/:id/versions/*       → version history (./versions.ts)
 *   /api/sheets/:id/data-sources/*   → connected tables of WeldSuite data (./data-sources.ts)
 *
 * The workbook is otherwise edited over the room socket
 * (`/api/sheets/connect`, see ../../room/connect.ts); an export is written
 * by the room, so it includes edits not checkpointed yet.
 */

import { Hono } from 'hono';
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
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { getStoredObject, isWorkspaceObjectKey } from '@weldsuite/worker-kit/storage';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { resolveProjectAccess } from '@weldsuite/flow-domain/project-access';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { canEdit, containerRole, fileRole, loadDriveAccessForUser, visibleFilesCondition } from '@weldsuite/core-domain/drive-access';
import {
  SHEET_IMPORT_MAX_BYTES,
  convertProjectSheetSchema,
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
} from '@weldsuite/app-api-client/schemas/sheets';
import type { Env, Variables } from '../../types';
import { adoptFileAsSheet, createSheet, getDriveFile, getSheet, listSheets, memberProfile, renameSheet, snapshotKeyFor, trashSheet, type SheetRecord } from '../../services/sheets';
import { convertLegacyModel, readLegacyModel } from '../../services/legacy-project-sheet';
import { writeSnapshot } from '../../room/snapshot';
import { colorFor, newTabId } from '../../room/people';
import { VIEW_ONLY, eventData, findSheet, mayUpdate, projectRole, roomFor, roomMeta, sessionMode, toSummary, type Ctx } from './access';
import { CONTENT_TYPES, attachment } from './download';
import versionRoutes from './versions';
import dataSourceRoutes from './data-sources';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_LIMIT = 50;

app.route('/:id/versions', versionRoutes);
app.route('/:id/data-sources', dataSourceRoutes);

app.get('/', requirePermission('sheets:read'), zValidator('query', listSheetsQuerySchema), async (c) => {
  const { search, limit = DEFAULT_LIMIT, cursor, projectId } = c.req.valid('query');
  const db = c.get('tenantDb');
  const access = await loadDriveAccessForUser(db, c.get('userId') ?? null);
  const offset = cursor ? Number(cursor) : 0;
  // A project's sheets are its members': the project decides, not the drive.
  const projectAs = projectId ? await projectRole(c, projectId, 'editor') : null;
  if (projectId && !projectAs) return error.notFound(c, 'Project', projectId);
  const visible = projectId ? undefined : visibleFilesCondition(access);
  const { rows, total } = await listSheets(db, { visible, search, limit, offset, projectId });
  const mayEdit = await mayUpdate(c);
  const data = rows.map((sheet) => toSummary(sheet, projectAs ?? fileRole(access, sheet.file) ?? 'viewer', mayEdit));
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
export async function saveNewSheet(
  c: Ctx,
  params: {
    workspaceId: string;
    userId: string;
    name: string;
    folderId: string | null;
    workbook: WorkbookSnapshot;
    /** A WeldFlow project the sheet belongs to (its file is the project's, like the project's other files). */
    projectId?: string | null;
  },
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

/** A live project the caller may add work to, or the response to send instead. */
async function writableProject(c: Ctx, projectId: string): Promise<string | Response> {
  const scopeAll = await hasContextPermission(c, 'projects:scope:all');
  const access = await resolveProjectAccess(c.get('tenantDb'), c.get('userId') ?? undefined, { scopeAll }, projectId);
  const [project] = await c
    .get('tenantDb')
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  if (!project || access.deleted || !(access.scopeAll || access.isManager || access.isMember)) return error.notFound(c, 'Project', projectId);
  if (!access.canWrite) return error.forbidden(c, 'You can view this project but not add to it');
  return projectId;
}

/** The workbook a copy starts from: another sheet as its room holds it now, without its connected tables. */
async function copyOf(c: Ctx, workspaceId: string, sourceId: string): Promise<WorkbookSnapshot | Response> {
  const found = await findSheet(c, sourceId);
  if (found instanceof Response) return found;
  const live = await roomFor(c, workspaceId, found.sheet).snapshot(roomMeta(found.sheet, workspaceId));
  const workbook = JSON.parse(live.json) as WorkbookSnapshot;
  // Connected tables belong to the sheet they were connected to.
  return { ...workbook, sheets: workbook.sheets.map(({ dataTables: _tables, ...tab }) => tab) };
}

app.post('/', requirePermission('sheets:create'), zValidator('json', createSheetSchema), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const { name, folderId = null, firstTabName, projectId, copyFromSheetId } = c.req.valid('json');
  const project = projectId ? await writableProject(c, projectId) : null;
  if (project instanceof Response) return project;
  const folder = project ? null : await editableFolder(c, folderId);
  if (folder instanceof Response) return folder;

  let workbook: WorkbookSnapshot;
  if (copyFromSheetId) {
    const copied = await copyOf(c, workspaceId, copyFromSheetId);
    if (copied instanceof Response) return copied;
    workbook = copied;
  } else {
    const empty = new Workbook();
    empty.sheets.push(new Sheet(newTabId(), firstTabName ?? 'Sheet1'));
    workbook = empty.toJSON();
  }
  const sheet = await saveNewSheet(c, { workspaceId, userId, name, folderId: folder, workbook, projectId: project });
  return success(c, toSummary(sheet, 'owner', await mayUpdate(c)), 201);
});

// ---------------------------------------------------------------------------
// Files: import and export
// ---------------------------------------------------------------------------

/** Most cells an imported workbook may have, until sheets load in parts (plan phase 9). */
const MAX_IMPORT_CELLS = 250_000;
/** Room for the multipart envelope around the largest file. */
const MULTIPART_SLACK = 64 * 1024;
/**
 * How far an .xlsx may inflate. A Worker has 128 MB, and a part is held as
 * bytes and then as a string: past these, a file is refused (`too_large`)
 * before it can run the isolate out of memory. 250,000 cells take well under
 * 32 MB of sheet XML.
 */
const IMPORT_ZIP_LIMITS = { maxEntrySize: 32 * 1024 * 1024, maxTotalSize: 64 * 1024 * 1024 };
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
      limits: IMPORT_ZIP_LIMITS,
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

/** What an old project sheet's file holds, as a workbook (an empty one when it was never saved). */
async function legacyWorkbook(
  c: Ctx,
  file: NonNullable<Awaited<ReturnType<typeof getDriveFile>>>,
  params: { workspaceId: string; userId: string; firstTabName: string },
): Promise<WorkbookSnapshot> {
  // A row's key came from a client: never let it reach another workspace's objects.
  const object = file.key && isWorkspaceObjectKey(file.key, params.workspaceId) ? await getStoredObject(c.env, file.key) : null;
  const bytes = object ? new Uint8Array(await object.arrayBuffer()) : null;
  const model = bytes ? await readLegacyModel(file.name, bytes).catch(() => null) : null;
  const owner = file.file.uploadedById ?? params.userId;
  return convertLegacyModel(model ?? { sheets: [], columnsBySheet: {}, rowsBySheet: {} }, {
    newTabId,
    owner: { id: owner, name: (await memberProfile(c.get('tenantDb'), owner)).name ?? 'Unknown' },
    now: Date.now(),
    firstTabName: params.firstTabName,
  });
}

/**
 * An old WeldFlow project sheet (.xlsx from before WeldSheets) made a
 * spreadsheet in place, the first time someone opens it: same file, same
 * project, the old content converted (services/legacy-project-sheet.ts).
 * Anyone who may open the project's sheets may trigger it; a sheet already
 * converted (by them or someone else) is simply returned.
 */
app.post('/convert', requirePermission('sheets:read'), zValidator('json', convertProjectSheetSchema), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const { fileId, firstTabName } = c.req.valid('json');
  const db = c.get('tenantDb');
  const file = await getDriveFile(db, fileId);
  if (!file?.projectId || file.fileType !== 'spreadsheet') return error.notFound(c, 'Project sheet', fileId);
  const role = await projectRole(c, file.projectId, fileRole(await loadDriveAccessForUser(db, userId), file.file) ?? 'viewer');
  if (!role) return error.notFound(c, 'Project sheet', fileId);
  const mayEdit = await mayUpdate(c);
  if (file.weldsheetId) {
    const existing = await getSheet(db, file.weldsheetId);
    return existing ? success(c, toSummary(existing, role, mayEdit)) : error.notFound(c, 'Project sheet', fileId);
  }

  const workbook = await legacyWorkbook(c, file, { workspaceId, userId, firstTabName: firstTabName ?? 'Sheet1' });
  const sheetId = generateId('sht');
  const size = await writeSnapshot(c.env.PRIVATE_STORAGE, snapshotKeyFor(workspaceId, sheetId), { revision: 0, workbook });
  const name = file.name.replace(/\.xlsx$/i, '').trim().slice(0, 255) || 'Untitled spreadsheet';
  const sheet = await adoptFileAsSheet(db, { fileId, sheetId, workspaceId, name, snapshotSize: size, userId, oldKey: file.key });
  if (!sheet) {
    // Someone else converted it meanwhile: theirs it is.
    await c.env.PRIVATE_STORAGE.delete(snapshotKeyFor(workspaceId, sheetId));
    const winner = await getDriveFile(db, fileId);
    const existing = winner?.weldsheetId ? await getSheet(db, winner.weldsheetId) : null;
    return existing ? success(c, toSummary(existing, role, mayEdit)) : error.notFound(c, 'Project sheet', fileId);
  }
  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: sheet.fileId,
    action: 'updated',
    data: { id: sheet.fileId, name: sheet.name, folderId: sheet.folderId, fileType: 'spreadsheet', fileSize: size },
  });
  publishEntityEvent({ c, entityType: 'sheet', entityId: sheet.id, action: 'created', data: eventData(sheet) });
  return success(c, toSummary(sheet, role, mayEdit), 201);
});

app.get('/:id/export', requirePermission('sheets:read'), zValidator('query', exportSheetQuerySchema), async (c) => {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return error.orgRequired(c);
  const found = await findSheet(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const { sheet } = found;
  const { format, tab, locale } = c.req.valid('query');
  const file = await roomFor(c, workspaceId, sheet).exportFile(roomMeta(sheet, workspaceId), { format, tab, locale });
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

  const mode = await sessionMode(c, role);
  const profile = await memberProfile(c.get('tenantDb'), userId);
  const color = colorFor(userId);
  const ticket = await roomFor(c, workspaceId, sheet).admit({
    ...roomMeta(sheet, workspaceId),
    userId,
    name: profile.name ?? 'Unknown',
    picture: profile.picture,
    color,
    canEdit: mode === 'edit',
    canComment: mode === 'comment',
  });
  return success(c, { ticket, canEdit: mode === 'edit', mode, color } satisfies SheetSession);
});

export default app;
