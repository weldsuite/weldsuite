/**
 * What every board route needs: the board with the caller's role on it,
 * whether they may change it or comment on it, and its room.
 *
 * Who may see a board is WeldDrive's sharing rules on its file (owner,
 * shares, general access, folders), with two additions:
 *
 *   - A WeldFlow project's board follows the project: its members may open
 *     it, and only those who may change the project's work may edit it. An
 *     old WeldFlow whiteboard not converted yet has only the project.
 *   - A workspace template may be opened by everyone (to start a board from).
 *
 * A board the caller may not see is a 404.
 */

import type { Context } from 'hono';
import { hasContextPermission } from '@weldsuite/permissions/server';
import type { DataFor } from '@weldsuite/entity-events/events';
import { error } from '@weldsuite/worker-kit/response';
import { canEdit, fileRole, loadDriveAccessForUser, type DriveAccessIndex, type DriveRole } from '@weldsuite/core-domain/drive-access';
import { resolveProjectAccess, type ProjectAccess } from '@weldsuite/flow-domain/project-access';
import type { BoardSessionMode, BoardSummary } from '@weldsuite/app-api-client/schemas/boards';
import type { Env, Variables } from '../../types';
import type { RoomMeta } from '../../room/board-room';
import { getBoard, isLive, snapshotKeyFor, type BoardRecord, type LiveBoardRecord } from '../../services/boards';

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export const VIEW_ONLY = 'You can view this board but not change it';

/** The caller's role on a board given their drive access, before any project narrowing. */
export function driveRole(access: DriveAccessIndex, board: BoardRecord): DriveRole | null {
  const role = board.file ? fileRole(access, board.file) : null;
  if (role) return role;
  if (board.templateCategory) return 'viewer';
  // A legacy whiteboard has no file: the project alone decides (projectRole).
  return board.legacy ? 'editor' : null;
}

/** The board with the caller's role on it, or the response to send instead. */
export async function findBoard(c: Ctx, id: string): Promise<{ board: BoardRecord; role: DriveRole } | Response> {
  const db = c.get('tenantDb');
  const board = await getBoard(db, id);
  let role = board ? driveRole(await loadDriveAccessForUser(db, c.get('userId') ?? null), board) : null;
  if (board?.projectId && role) role = await projectRole(c, board.projectId, role);
  if (!board || !role) return error.notFound(c, 'Board', id);
  return { board, role };
}

/** A converted board with the caller's role on it (a legacy whiteboard is a 404 here: open it first). */
export async function findLiveBoard(c: Ctx, id: string): Promise<{ board: LiveBoardRecord; role: DriveRole } | Response> {
  const found = await findBoard(c, id);
  if (found instanceof Response) return found;
  if (!isLive(found.board)) return error.notFound(c, 'Board', id);
  return { board: found.board, role: found.role };
}

export async function projectAccess(c: Ctx, projectId: string): Promise<ProjectAccess> {
  const scopeAll = await hasContextPermission(c, 'projects:scope:all');
  return resolveProjectAccess(c.get('tenantDb'), c.get('userId') ?? undefined, { scopeAll }, projectId);
}

/**
 * A WeldFlow project's board follows the project: its members may open it,
 * and only those who may change the project's work may edit it.
 */
export async function projectRole(c: Ctx, projectId: string, role: DriveRole): Promise<DriveRole | null> {
  const access = await projectAccess(c, projectId);
  if (!mayOpenProject(access)) return null;
  return access.canWrite ? role : 'viewer';
}

/** Whether a project's access lets its holder open what's in it at all: scope:all, its manager, or any active membership row (any role). */
export function mayOpenProject(access: Pick<ProjectAccess, 'deleted' | 'scopeAll' | 'isManager' | 'isMember'>): boolean {
  return !access.deleted && (access.scopeAll || access.isManager || access.isMember);
}

/** Write access needs the role, `boards:update`, and a workspace that is not read-only. */
export async function mayUpdate(c: Ctx): Promise<boolean> {
  return !c.get('readOnly') && (await hasContextPermission(c, 'boards:update'));
}

/** May change this board: an owner or editor, with `boards:update`. */
export async function mayEditBoard(c: Ctx, role: DriveRole): Promise<boolean> {
  return canEdit(role) && (await mayUpdate(c));
}

/**
 * What the room lets the caller do: edit (owner or editor with
 * `boards:update`), comment (anyone else who may see it, with
 * `boards:comment`), or only view. A read-only workspace is view only.
 */
export async function sessionMode(c: Ctx, role: DriveRole): Promise<BoardSessionMode> {
  if (await mayEditBoard(c, role)) return 'edit';
  if (!c.get('readOnly') && (await hasContextPermission(c, 'boards:comment'))) return 'comment';
  return 'view';
}

/** The converted board, if the caller may change it; else the response to send. */
export async function editableBoard(c: Ctx): Promise<LiveBoardRecord | Response> {
  const found = await findLiveBoard(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  if (!(await mayEditBoard(c, found.role))) return error.forbidden(c, VIEW_ONLY);
  return found.board;
}

export function toSummary(board: BoardRecord, role: DriveRole, mayEdit: boolean): BoardSummary {
  return {
    id: board.id,
    fileId: board.fileId,
    name: board.name,
    folderId: board.folderId,
    projectId: board.projectId,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
    createdById: board.createdById,
    updatedById: board.updatedById,
    revision: board.revision,
    role,
    canEdit: mayEdit && canEdit(role),
    templateCategory: board.templateCategory,
    legacy: board.legacy,
  };
}

export function eventData(board: LiveBoardRecord): DataFor<'board'> {
  return {
    id: board.id,
    fileId: board.fileId,
    name: board.name,
    projectId: board.projectId,
    revision: board.revision,
    updatedById: board.updatedById,
  };
}

/** What a `file` event says about a board's drive file. */
export function fileEventData(board: LiveBoardRecord, fileSize?: number) {
  return {
    id: board.fileId,
    name: board.name,
    folderId: board.folderId,
    fileType: 'whiteboard',
    ...(fileSize !== undefined ? { fileSize } : {}),
  };
}

/**
 * The room for a board: one Durable Object per board, named by workspace and id.
 * `workspaceId` is the Clerk org id: the room name and the R2 prefix use it,
 * as WeldDocs' and WeldSheets' rooms do (workspace-id plan).
 */
export function roomFor(c: Pick<Ctx, 'env'>, workspaceId: string, board: { id: string }) {
  return c.env.BOARD_ROOM.get(c.env.BOARD_ROOM.idFromName(`${workspaceId}:${board.id}`));
}

/** What the room needs to know about the board it holds. */
export function roomMeta(board: { id: string; snapshotKey: string | null }, workspaceId: string): RoomMeta {
  return { workspaceId, boardId: board.id, snapshotKey: board.snapshotKey ?? snapshotKeyFor(workspaceId, board.id) };
}
