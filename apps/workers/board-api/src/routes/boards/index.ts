/**
 * Board routes — /api/boards/*.
 *
 * A board is a WeldDrive file plus a `whiteboards` row, so who may see or
 * change it follows WeldDrive's sharing rules on top of the `boards:*`
 * permissions; a WeldFlow project's board follows the project (./access.ts).
 * A board the caller may not see is a 404.
 *
 *   GET    /api/boards                → boards the caller can see (`projectId`, `projects`, `templates`)
 *   POST   /api/boards                → create (empty, from a snapshot, or a copy of another board)
 *   POST   /api/boards/import         → a new board from a file's content
 *   POST   /api/boards/convert        → an old WeldFlow whiteboard made a board, in place
 *   POST   /api/boards/unfurl         → what a link card shows for an address (services/unfurl.ts)
 *   POST   /api/boards/records        → what record cards show, for the records the caller may see
 *   POST   /api/boards/:id/tasks      → stickies made WeldFlow tasks, and task cards in their place
 *   GET    /api/boards/:id            → one board (an old WeldFlow whiteboard says `legacy`)
 *   PATCH  /api/boards/:id            → rename, move, make a template or not
 *   DELETE /api/boards/:id            → move to the trash
 *   POST   /api/boards/:id/session    → ticket for the board's room socket
 *   GET    /api/boards/:id/snapshot   → the board as the room holds it now
 *   GET    /api/boards/:id/thumbnail  → a small SVG of the board (as of its last checkpoint)
 *   /api/boards/:id/versions/*        → version history (./versions.ts)
 *
 * The board is otherwise edited over the room socket (`/api/boards/connect`,
 * see ../../room/connect.ts).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { copySnapshot, convertLegacyWhiteboard, emptySnapshot, isWellFormedSnapshot, newId, snapshotFromImport, Board, type BoardElement, type BoardSnapshot, type Op } from '@weldsuite/board-engine';
import { createTask } from '@weldsuite/flow-domain/tasks';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { canEdit, containerRole, loadDriveAccessForUser, visibleFilesCondition, type DriveRole } from '@weldsuite/core-domain/drive-access';
import { accessibleProjectIds } from '@weldsuite/flow-domain/project-access';
import {
  DEFAULT_BOARD_NAME,
  convertBoardSchema,
  createBoardSchema,
  importBoardSchema,
  listBoardsQuerySchema,
  boardTasksSchema,
  resolveBoardRecordsSchema,
  unfurlSchema,
  type BoardRecordKind,
  type BoardTasksResult,
  updateBoardSchema,
  type BoardSession,
  type BoardTemplateCategory,
} from '@weldsuite/app-api-client/schemas/boards';
import type { Env, Variables } from '../../types';
import {
  convertLegacy,
  createBoard,
  getLiveBoard,
  legacyElements,
  listBoards,
  memberProfile,
  projectExists,
  snapshotKeyFor,
  trashBoard,
  trashLegacy,
  updateBoard,
  type BoardRecord,
  type BoardScope,
  type LiveBoardRecord,
} from '../../services/boards';
import { readThumbnail, writeSnapshot } from '../../room/snapshot';
import { unfurl } from '../../services/unfurl';
import { RECORD_PERMISSION, resolveRecords } from '../../services/records';
import { colorFor } from '../../room/people';
import {
  VIEW_ONLY,
  driveRole,
  editableBoard,
  eventData,
  fileEventData,
  findBoard,
  findLiveBoard,
  mayOpenProject,
  mayUpdate,
  projectAccess,
  projectRole,
  roomFor,
  roomMeta,
  sessionMode,
  toSummary,
  type Ctx,
} from './access';
import versionRoutes from './versions';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_LIMIT = 50;

app.route('/:id/versions', versionRoutes);

// ---------------------------------------------------------------------------
// Listing and creating
// ---------------------------------------------------------------------------

app.get('/', requirePermission('boards:read'), zValidator('query', listBoardsQuerySchema), async (c) => {
  const { search, limit = DEFAULT_LIMIT, cursor, projectId, projects, templates } = c.req.valid('query');
  const db = c.get('tenantDb');
  const userId = c.get('userId') ?? null;
  const access = await loadDriveAccessForUser(db, userId);
  const offset = cursor ? Number(cursor) : 0;
  const mayEdit = await mayUpdate(c);

  let scope: BoardScope;
  // A project's boards are its members': the project decides, not the drive.
  let projectAs: 'editor' | 'viewer' | null = null;
  if (projectId) {
    const role = await projectRole(c, projectId, 'editor');
    if (!role) return error.notFound(c, 'Project', projectId);
    projectAs = role === 'viewer' ? 'viewer' : 'editor';
    scope = { kind: 'project', projectId };
  } else if (projects === 'true') {
    const scopeAll = await hasContextPermission(c, 'projects:scope:all');
    scope = { kind: 'projects', projectIds: await accessibleProjectIds(db, userId ?? undefined, { scopeAll }) };
  } else if (templates === 'true') {
    scope = { kind: 'templates' };
  } else {
    scope = { kind: 'drive' };
  }

  // Templates are open to everyone; drive boards follow the drive's sharing.
  const visible = scope.kind === 'drive' ? visibleFilesCondition(access) : undefined;
  const { rows, total } = await listBoards(db, { scope, visible, search, limit, offset });

  // Across projects, each board's role follows its own project.
  const projectRoles = new Map<string, 'editor' | 'viewer'>();
  if (scope.kind === 'projects') {
    const ids = [...new Set(rows.map((r) => r.projectId).filter((p): p is string => !!p))];
    const resolved = await Promise.all(ids.map(async (id) => [id, await projectAccess(c, id)] as const));
    for (const [id, a] of resolved) if (mayOpenProject(a)) projectRoles.set(id, a.canWrite ? 'editor' : 'viewer');
  }
  const roleOf = (board: (typeof rows)[number]): DriveRole => {
    const base = driveRole(access, board) ?? 'viewer';
    if (!board.projectId) return base;
    return (projectAs ?? projectRoles.get(board.projectId)) === 'editor' ? base : 'viewer';
  };
  const data = rows.map((board) => toSummary(board, roleOf(board), mayEdit));
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

/** A live project the caller may add work to, or the response to send instead. */
async function writableProject(c: Ctx, projectId: string): Promise<string | Response> {
  const access = await projectAccess(c, projectId);
  if (!(await projectExists(c.get('tenantDb'), projectId)) || !mayOpenProject(access)) return error.notFound(c, 'Project', projectId);
  if (!access.canWrite) return error.forbidden(c, 'You can view this project but not add to it');
  return projectId;
}

/** Stores a new board holding `snapshot`, with its drive file, and reports both. */
export async function saveNewBoard(
  c: Ctx,
  params: {
    /** The Clerk org id: the R2 prefix of the checkpoint (workspace-id plan). */
    workspaceId: string;
    userId: string;
    name: string;
    folderId: string | null;
    snapshot: BoardSnapshot;
    projectId?: string | null;
    templateCategory?: BoardTemplateCategory | null;
  },
): Promise<LiveBoardRecord> {
  const { snapshot, ...record } = params;
  // The first checkpoint goes in before the rows, so a room never opens a board without one.
  const boardId = generateId('brd');
  const size = await writeSnapshot(c.env.PRIVATE_STORAGE, snapshotKeyFor(record.workspaceId, boardId), { revision: 0, board: snapshot });
  const board = await createBoard(c.get('tenantDb'), { ...record, boardId, snapshotSize: size });
  publishEntityEvent({ c, entityType: 'file', entityId: board.fileId, action: 'created', data: fileEventData(board, size) });
  publishEntityEvent({ c, entityType: 'board', entityId: board.id, action: 'created', data: eventData(board) });
  return board;
}

/** The content a copy starts from: another board as its room holds it now. Templates may be copied by anyone. */
async function copyOf(c: Ctx, clerkOrgId: string, sourceId: string): Promise<{ snapshot: BoardSnapshot; name: string } | Response> {
  const found = await findConverted(c, sourceId);
  if (found instanceof Response) return found;
  const live = await roomFor(c, clerkOrgId, found.board).snapshot(roomMeta(found.board, clerkOrgId));
  return { snapshot: copySnapshot(JSON.parse(live.json) as BoardSnapshot), name: found.board.name };
}

/**
 * A board with the caller's role on it, an old WeldFlow whiteboard converted
 * first (renaming or copying one from the project's list should not need it
 * opened). `mayConvert` says whether this caller may trigger that.
 */
async function findConverted(
  c: Ctx,
  id: string,
  mayConvert: (role: DriveRole) => boolean = () => true,
): Promise<{ board: LiveBoardRecord; role: DriveRole } | Response> {
  const found = await findBoard(c, id);
  if (found instanceof Response) return found;
  if (!found.board.legacy) return findLiveBoard(c, id);
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  if (!mayConvert(found.role)) return error.forbidden(c, VIEW_ONLY);
  const converted = await convertInPlace(c, found.board, { clerkOrgId, userId });
  return converted ? { board: converted.board, role: found.role } : error.notFound(c, 'Board', id);
}

/** A snapshot from a client, checked and made canonical; null when it is not one. */
function clientSnapshot(v: unknown): BoardSnapshot | null {
  return isWellFormedSnapshot(v) ? Board.fromSnapshot(v).toSnapshot() : null;
}

app.post('/', requirePermission('boards:create'), zValidator('json', createBoardSchema), async (c) => {
  const userId = c.get('userId');
  // Room names and R2 keys stay on the Clerk org id: renaming would split live sessions (workspace-id plan).
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  if (c.get('readOnly')) return error.forbidden(c, 'This workspace is read-only');
  const { name, folderId = null, projectId, snapshot, fromBoardId, template } = c.req.valid('json');
  if (projectId && template) return error.badRequest(c, "A project's board cannot be a workspace template");
  const project = projectId ? await writableProject(c, projectId) : null;
  if (project instanceof Response) return project;
  const folder = project ? null : await editableFolder(c, folderId);
  if (folder instanceof Response) return folder;

  let content: BoardSnapshot = emptySnapshot();
  let fallbackName = DEFAULT_BOARD_NAME;
  if (fromBoardId) {
    const copied = await copyOf(c, clerkOrgId, fromBoardId);
    if (copied instanceof Response) return copied;
    content = copied.snapshot;
    fallbackName = copied.name;
  } else if (snapshot) {
    const checked = clientSnapshot(snapshot);
    if (!checked) return error.badRequest(c, 'That is not a board snapshot');
    content = checked;
  }
  const board = await saveNewBoard(c, {
    workspaceId: clerkOrgId,
    userId,
    name: name ?? fallbackName,
    folderId: folder,
    snapshot: content,
    projectId: project,
    templateCategory: template?.category ?? null,
  });
  return success(c, toSummary(board, 'owner', await mayUpdate(c)), 201);
});

app.post('/import', requirePermission('boards:create'), zValidator('json', importBoardSchema), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  if (c.get('readOnly')) return error.forbidden(c, 'This workspace is read-only');
  const { name, format, content, folderId = null, projectId } = c.req.valid('json');
  const project = projectId ? await writableProject(c, projectId) : null;
  if (project instanceof Response) return project;
  const folder = project ? null : await editableFolder(c, folderId);
  if (folder instanceof Response) return folder;
  const read = snapshotFromImport(format, content, () => generateId('el'));
  if (!read) return error.badRequest(c, 'This file could not be read as a board', { reason: 'unreadable' });
  const board = await saveNewBoard(c, { workspaceId: clerkOrgId, userId, name, folderId: folder, snapshot: read.snapshot, projectId: project });
  return success(c, { ...toSummary(board, 'owner', await mayUpdate(c)), skipped: read.skipped }, 201);
});

/**
 * An old WeldFlow whiteboard made a board in place: same id, same project,
 * its elements converted (board-engine's legacy/weldflow.ts). A board someone
 * else converted meanwhile is returned as theirs. Null when it is gone.
 */
export async function convertInPlace(
  c: Ctx,
  legacy: BoardRecord,
  params: { clerkOrgId: string; userId: string },
): Promise<{ board: LiveBoardRecord; created: boolean } | null> {
  const db = c.get('tenantDb');
  const old = await legacyElements(db, legacy.id);
  if (!old) {
    const winner = await getLiveBoard(db, legacy.id);
    return winner ? { board: winner, created: false } : null;
  }
  const snapshot = convertLegacyWhiteboard(old.elements, old.lastEditedBy ? { createdBy: old.lastEditedBy } : {});
  const key = snapshotKeyFor(params.clerkOrgId, legacy.id);
  // Only when there is none yet: a board converted meanwhile may already have checkpointed edits there.
  const size = (await writeSnapshot(c.env.PRIVATE_STORAGE, key, { revision: 0, board: snapshot }, { onlyIfAbsent: true })) ?? 0;
  const converted = await convertLegacy(db, { legacy, workspaceId: params.clerkOrgId, snapshotSize: size, userId: params.userId });
  if (!converted) {
    const winner = await getLiveBoard(db, legacy.id);
    return winner ? { board: winner, created: false } : null;
  }
  publishEntityEvent({ c, entityType: 'file', entityId: converted.fileId, action: 'created', data: fileEventData(converted, size) });
  publishEntityEvent({ c, entityType: 'board', entityId: converted.id, action: 'created', data: eventData(converted) });
  return { board: converted, created: true };
}

/**
 * Converts an old WeldFlow whiteboard the first time someone opens it.
 * Anyone who may open the project's boards may trigger it; a board already
 * converted (by them or someone else) is returned as it is.
 */
app.post('/convert', requirePermission('boards:read'), zValidator('json', convertBoardSchema), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  const { whiteboardId } = c.req.valid('json');
  const found = await findBoard(c, whiteboardId);
  if (found instanceof Response) return found;
  const { board, role } = found;
  const mayEdit = await mayUpdate(c);
  if (!board.legacy) return success(c, toSummary(board, role, mayEdit));
  const result = await convertInPlace(c, board, { clerkOrgId, userId });
  if (!result) return error.notFound(c, 'Board', whiteboardId);
  return success(c, toSummary(result.board, role, mayEdit), result.created ? 201 : 200);
});

/** A link card's preview. Never an error for a page that cannot be read: the card just shows the address. */
app.post('/unfurl', requirePermission('boards:read'), zValidator('json', unfurlSchema), async (c) => {
  return success(c, await unfurl(c.req.valid('json').url));
});

/** What record cards show: each record as far as the caller may see it (services/records.ts). */
app.post('/records', requirePermission('boards:read'), zValidator('json', resolveBoardRecordsSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const kinds = new Set<BoardRecordKind>();
  for (const [kind, permission] of Object.entries(RECORD_PERMISSION) as [BoardRecordKind, string][]) {
    if (await hasContextPermission(c, permission)) kinds.add(kind);
  }
  const scopeAll = await hasContextPermission(c, 'projects:scope:all');
  const views = await resolveRecords(c.get('tenantDb'), { userId, scopeAll, kinds }, c.req.valid('json').refs);
  c.header('Cache-Control', 'private, no-store');
  return success(c, { views });
});

/** The first line of an element's text as a task title, the rest as its description. */
function taskFields(el: BoardElement): { title: string; description?: string } | null {
  const text = (el.text?.text ?? el.title ?? '').trim();
  if (!text) return null;
  const [first, ...rest] = text.split('\n');
  const description = rest.join('\n').trim();
  return { title: first!.trim().slice(0, 500) || text.slice(0, 500), ...(description ? { description: description.slice(0, 10_000) } : {}) };
}

const TASKABLE = new Set<BoardElement['type']>(['sticky', 'card', 'shape', 'text']);

/**
 * Stickies (and cards, shapes, texts) made WeldFlow tasks in a project: one
 * task per element, from its text, and a task card where the element was, so
 * the board keeps showing it with the task's live title and status.
 */
app.post('/:id/tasks', requirePermission('boards:update'), zValidator('json', boardTasksSchema), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  if (!(await hasContextPermission(c, 'tasks:create'))) return error.forbidden(c, 'You may not create tasks');
  const board = await editableBoard(c);
  if (board instanceof Response) return board;
  const { elementIds, projectId } = c.req.valid('json');
  const project = await writableProject(c, projectId);
  if (project instanceof Response) return project;

  const meta = roomMeta(board, clerkOrgId);
  const room = roomFor(c, clerkOrgId, board);
  const content = Board.fromSnapshot(JSON.parse((await room.snapshot(meta)).json) as BoardSnapshot);
  const picked = [...new Set(elementIds)]
    .map((id) => content.get(id))
    .filter((el): el is BoardElement => !!el && TASKABLE.has(el.type) && !el.locked && taskFields(el) !== null);
  if (picked.length === 0) return error.badRequest(c, 'None of these elements has text to make a task of');

  const db = c.get('tenantDb');
  const created: BoardTasksResult['created'] = [];
  const ops: Op[] = [];
  const now = Date.now();
  for (const el of picked) {
    const { row } = await createTask(db, taskFields(el)!, { projectId: project, userId });
    publishEntityEvent({ c, entityType: 'task', entityId: row.id, action: 'created', data: { id: row.id, title: row.title, number: row.number, status: row.status, priority: row.priority, projectId: row.projectId, assigneeId: row.assigneeId } });
    created.push({ elementId: el.id, taskId: row.id });
    const card: BoardElement = {
      id: newId(),
      type: 'record',
      order: el.order,
      ...(el.parent ? { parent: el.parent } : {}),
      x: el.x,
      y: el.y,
      w: Math.max(240, Math.min(el.w, 400)),
      h: 96,
      record: { kind: 'task', id: row.id },
      createdBy: userId,
      createdAt: now,
    };
    ops.push({ type: 'create', elements: [card] }, { type: 'delete', ids: [el.id] });
  }
  const result = await room.applyOps(meta, { type: 'batch', ops }, userId);
  // The tasks stand even when the board changed meanwhile; the stickies then simply stay.
  if (!result.committed) console.warn('[board-api/tasks] the task cards could not be placed:', result.refused);
  return success(c, { created } satisfies BoardTasksResult, 201);
});

// ---------------------------------------------------------------------------
// One board
// ---------------------------------------------------------------------------

app.get('/:id', requirePermission('boards:read'), async (c) => {
  const found = await findBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  return success(c, toSummary(found.board, found.role, await mayUpdate(c)));
});

app.patch('/:id', requirePermission('boards:update'), zValidator('json', updateBoardSchema), async (c) => {
  const writable = (role: DriveRole) => canEdit(role) && !c.get('readOnly');
  const found = await findConverted(c, c.req.param('id'), writable);
  if (found instanceof Response) return found;
  if (!writable(found.role)) return error.forbidden(c, VIEW_ONLY);
  const changes = c.req.valid('json');
  if (found.board.projectId && (changes.folderId !== undefined || changes.template !== undefined)) {
    return error.badRequest(c, "A project's board stays with the project: it cannot be moved or made a template");
  }
  if (changes.template !== undefined && !(await hasContextPermission(c, 'boards:create'))) {
    return error.forbidden(c, 'You may not publish workspace templates');
  }
  if (changes.folderId) {
    const folder = await editableFolder(c, changes.folderId);
    if (folder instanceof Response) return folder;
  }
  const result = await updateBoard(c.get('tenantDb'), found.board, changes);
  if (!result.ok) {
    return result.reason === 'name_conflict'
      ? error.conflict(c, 'A file with this name already exists in this folder')
      : error.notFound(c, 'Board', found.board.id);
  }
  const { board } = result;
  const before = found.board;
  const changed = {
    ...(before.name !== board.name ? { name: { old: before.name, new: board.name } } : {}),
    ...(before.folderId !== board.folderId ? { folderId: { old: before.folderId, new: board.folderId } } : {}),
    ...(before.templateCategory !== board.templateCategory ? { templateCategory: { old: before.templateCategory, new: board.templateCategory } } : {}),
  };
  if (changed.name || changed.folderId) {
    publishEntityEvent({ c, entityType: 'file', entityId: board.fileId, action: 'updated', data: fileEventData(board), changes: changed });
  }
  publishEntityEvent({ c, entityType: 'board', entityId: board.id, action: 'updated', data: eventData(board), changes: changed });
  return success(c, toSummary(board, found.role, true));
});

app.delete('/:id', requirePermission('boards:delete'), async (c) => {
  const found = await findBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  if (!canEdit(found.role) || c.get('readOnly')) return error.forbidden(c, VIEW_ONLY);
  const db = c.get('tenantDb');
  const { board } = found;
  if (board.legacy) {
    // An old WeldFlow whiteboard nobody opened since WeldBoard: deleted as WeldFlow did.
    if (!(await trashLegacy(db, board.id))) return error.notFound(c, 'Board', board.id);
    publishEntityEvent({ c, entityType: 'project_whiteboard', entityId: board.id, action: 'deleted', data: { id: board.id } });
    return noContent(c);
  }
  const live = await getLiveBoard(db, board.id);
  if (!live || !(await trashBoard(db, live))) return error.notFound(c, 'Board', board.id);
  publishEntityEvent({ c, entityType: 'file', entityId: live.fileId, action: 'deleted', data: fileEventData(live) });
  publishEntityEvent({ c, entityType: 'board', entityId: live.id, action: 'deleted', data: eventData(live) });
  return noContent(c);
});

app.post('/:id/session', requirePermission('boards:read'), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  const found = await findLiveBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const { board, role } = found;

  const mode = await sessionMode(c, role);
  const profile = await memberProfile(c.get('tenantDb'), userId);
  const color = colorFor(userId);
  const ticket = await roomFor(c, clerkOrgId, board).admit({
    ...roomMeta(board, clerkOrgId),
    userId,
    name: profile.name ?? 'Unknown',
    picture: profile.picture,
    color,
    canEdit: mode === 'edit',
    canComment: mode === 'comment',
  });
  return success(c, { ticket, canEdit: mode === 'edit', mode, color } satisfies BoardSession);
});

app.get('/:id/snapshot', requirePermission('boards:read'), async (c) => {
  const clerkOrgId = c.get('clerkOrgId');
  if (!clerkOrgId) return error.orgRequired(c);
  const found = await findLiveBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const live = await roomFor(c, clerkOrgId, found.board).snapshot(roomMeta(found.board, clerkOrgId));
  // The room hands over JSON text; splice it in rather than parse and re-encode a large board.
  return new Response(`{"data":{"revision":${live.revision},"snapshot":${live.json}}}`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
});

app.get('/:id/thumbnail', requirePermission('boards:read'), async (c) => {
  const clerkOrgId = c.get('clerkOrgId');
  if (!clerkOrgId) return error.orgRequired(c);
  const found = await findLiveBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const svg = await readThumbnail(c.env.PRIVATE_STORAGE, roomMeta(found.board, clerkOrgId).snapshotKey);
  if (svg === null) return error.notFound(c, 'Thumbnail', found.board.id);
  c.header('Cache-Control', 'private, max-age=60');
  return success(c, { svg, revision: found.board.revision });
});

export default app;
