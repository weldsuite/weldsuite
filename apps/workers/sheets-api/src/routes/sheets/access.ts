/**
 * What every spreadsheet route needs: the sheet with the caller's WeldDrive
 * role on it, whether they may change it or comment on it, and its room.
 */

import type { Context } from 'hono';
import { hasContextPermission } from '@weldsuite/permissions/server';
import type { DataFor } from '@weldsuite/entity-events/events';
import { error } from '@weldsuite/worker-kit/response';
import { canEdit, fileRole, loadDriveAccessForUser, type DriveRole } from '@weldsuite/core-domain/drive-access';
import { resolveProjectAccess, type ProjectAccess } from '@weldsuite/flow-domain/project-access';
import type { SheetSessionMode, SheetSummary } from '@weldsuite/app-api-client/schemas/sheets';
import type { Env, Variables } from '../../types';
import type { RoomMeta } from '../../room/sheet-room';
import { getSheet, snapshotKeyFor, type SheetRecord } from '../../services/sheets';

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export const VIEW_ONLY = 'You can view this spreadsheet but not change it';

/** The sheet with the caller's role on it, or the response to send instead. */
export async function findSheet(c: Ctx, id: string): Promise<{ sheet: SheetRecord; role: DriveRole } | Response> {
  const db = c.get('tenantDb');
  const sheet = await getSheet(db, id);
  let role = sheet ? fileRole(await loadDriveAccessForUser(db, c.get('userId') ?? null), sheet.file) : null;
  if (sheet?.projectId && role) role = await projectRole(c, sheet.projectId, role);
  if (!sheet || !role) return error.notFound(c, 'Spreadsheet', id);
  return { sheet, role };
}

/**
 * A WeldFlow project's sheet follows the project: its members may open it,
 * and only those who may change the project's work may edit it.
 */
export async function projectRole(c: Ctx, projectId: string, role: DriveRole): Promise<DriveRole | null> {
  const scopeAll = await hasContextPermission(c, 'projects:scope:all');
  const access = await resolveProjectAccess(c.get('tenantDb'), c.get('userId') ?? undefined, { scopeAll }, projectId);
  if (!mayOpenProject(access)) return null;
  return access.canWrite ? role : 'viewer';
}

/** Whether a project's access lets its holder open what's in it at all: scope:all, its manager, or any active membership row (any role). */
function mayOpenProject(access: Pick<ProjectAccess, 'deleted' | 'scopeAll' | 'isManager' | 'isMember'>): boolean {
  return !access.deleted && (access.scopeAll || access.isManager || access.isMember);
}

/** Write access needs the drive role, `sheets:update`, and a workspace that is not read-only. */
export async function mayUpdate(c: Ctx): Promise<boolean> {
  return !c.get('readOnly') && (await hasContextPermission(c, 'sheets:update'));
}

/** May change this sheet: an owner or editor on its file, with `sheets:update`. */
export async function mayEditSheet(c: Ctx, role: DriveRole): Promise<boolean> {
  return canEdit(role) && (await mayUpdate(c));
}

/**
 * What the room lets the caller do: edit (owner or editor with
 * `sheets:update`), comment (anyone else who may see it, with
 * `sheets:comment`), or only view. A read-only workspace is view only.
 */
export async function sessionMode(c: Ctx, role: DriveRole): Promise<SheetSessionMode> {
  if (await mayEditSheet(c, role)) return 'edit';
  if (!c.get('readOnly') && (await hasContextPermission(c, 'sheets:comment'))) return 'comment';
  return 'view';
}

/** The sheet, if the caller may change it; else the response to send. */
export async function editableSheet(c: Ctx): Promise<SheetRecord | Response> {
  const found = await findSheet(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  if (!(await mayEditSheet(c, found.role))) return error.forbidden(c, VIEW_ONLY);
  return found.sheet;
}

export function toSummary(sheet: SheetRecord, role: DriveRole, mayEdit: boolean): SheetSummary {
  return {
    id: sheet.id,
    fileId: sheet.fileId,
    name: sheet.name,
    folderId: sheet.folderId,
    projectId: sheet.projectId,
    createdAt: sheet.createdAt.toISOString(),
    updatedAt: sheet.updatedAt.toISOString(),
    createdById: sheet.createdById,
    updatedById: sheet.updatedById,
    role,
    canEdit: mayEdit && canEdit(role),
  };
}

export function eventData(sheet: SheetRecord): DataFor<'sheet'> {
  return { id: sheet.id, fileId: sheet.fileId, name: sheet.name, updatedById: sheet.updatedById };
}

/** The room for a sheet: one Durable Object per sheet, named by workspace and id. */
export function roomFor(c: Ctx, workspaceId: string, sheet: SheetRecord) {
  return c.env.SHEET_ROOM.get(c.env.SHEET_ROOM.idFromName(`${workspaceId}:${sheet.id}`));
}

/** What the room needs to know about the sheet it holds. */
export function roomMeta(sheet: SheetRecord, workspaceId: string): RoomMeta {
  return { workspaceId, sheetId: sheet.id, snapshotKey: sheet.snapshotKey ?? snapshotKeyFor(workspaceId, sheet.id) };
}
