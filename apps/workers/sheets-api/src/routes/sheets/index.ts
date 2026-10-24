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
 *
 * The workbook never travels through these routes: it is edited over the
 * room socket (`/api/sheets/connect`, see ../../room/connect.ts).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { Sheet, Workbook } from '@weldsuite/sheets-engine';
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
  createSheetSchema,
  listSheetsQuerySchema,
  updateSheetSchema,
  type SheetSession,
  type SheetSummary,
} from '@weldsuite/app-api-client/schemas/sheets';
import type { Env, Variables } from '../../types';
import {
  createSheet,
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

app.post('/', requirePermission('sheets:create'), zValidator('json', createSheetSchema), async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  if (!userId) return error.unauthorized(c);
  if (!workspaceId) return error.orgRequired(c);
  const { name, folderId = null, firstTabName } = c.req.valid('json');
  const db = c.get('tenantDb');

  if (folderId) {
    const role = containerRole(await loadDriveAccessForUser(db, userId), folderId);
    if (!role) return error.notFound(c, 'Folder', folderId);
    if (!canEdit(role)) return error.forbidden(c, 'You can view this folder but not add to it');
  }

  // The first checkpoint goes in before the rows, so a room never opens a sheet without one.
  const sheetId = generateId('sht');
  const workbook = new Workbook();
  workbook.sheets.push(new Sheet(newTabId(), firstTabName ?? 'Sheet1'));
  const size = await writeSnapshot(c.env.PRIVATE_STORAGE, snapshotKeyFor(workspaceId, sheetId), {
    revision: 0,
    workbook: workbook.toJSON(),
  });
  const sheet = await createSheet(db, { workspaceId, sheetId, name, folderId, userId, snapshotSize: size });

  publishEntityEvent({
    c,
    entityType: 'file',
    entityId: sheet.fileId,
    action: 'created',
    data: { id: sheet.fileId, name: sheet.name, folderId: sheet.folderId, fileType: 'spreadsheet', fileSize: size },
  });
  publishEntityEvent({ c, entityType: 'sheet', entityId: sheet.id, action: 'created', data: eventData(sheet) });
  return success(c, toSummary(sheet, 'owner', await mayUpdate(c)), 201);
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
