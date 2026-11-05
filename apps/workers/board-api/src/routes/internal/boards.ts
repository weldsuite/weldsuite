/**
 * What other workers do with boards, server-side:
 * /internal/boards/:workspaceId/*, reached only through the `BoardsInternal`
 * entrypoint (a service binding), so trusted by topology.
 *
 *   POST /find         → boards the person can open (by name, in a project, across projects)
 *   POST /create       → a new board (empty, from a snapshot, or from old WeldFlow elements)
 *   POST /:id/read     → a board as a summary, WeldFlow elements, an outline, text or a snapshot
 *   POST /:id/update   → rename, and/or make the board match WeldFlow elements
 *   POST /:id/apply    → commit board-engine ops
 *   POST /:id/add      → put a board spec on it (sticky notes, shapes, frames, lines, a mind map)
 *   POST /:id/edit     → change or remove elements by id (text, colour, position)
 *   POST /:id/delete   → move to the trash
 *
 * Callers: external-api's `/v1/boards` and deprecated `/v1/whiteboards` routes
 * (the WeldFlow elements format), the MCP server and the WeldAgent board tools, through
 * @weldsuite/board-domain/internal-client. Every call acts for someone:
 *
 *   - `x-weld-user`: a person. They see and change only what their WeldDrive
 *     access and project membership allow, with their `boards:*` permissions.
 *   - `x-weld-workspace-key`: a workspace API key, its scopes checked by the
 *     caller. It reaches every project's boards (WORKSPACE_KEY_PERMISSIONS).
 *
 * Writes go through the board's room, so everyone in the board sees them arrive.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  Board,
  boardOutline,
  boardToPlainText,
  convertLegacyWhiteboard,
  editOps,
  placeSpec,
  emptySnapshot,
  isWellFormedOp,
  isWellFormedSnapshot,
  legacyWriteOps,
  toLegacyElements,
  isNoop,
  type BoardSnapshot,
  type Op,
} from '@weldsuite/board-engine';
import { getWorkspaceContextForOrg, schema } from '@weldsuite/worker-kit/db';
import { createDrizzlePermissionQueries, hasContextPermission, resolveEffectivePermissions } from '@weldsuite/permissions/server';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { workspaceMovingResponse, workspaceReadOnlyBody } from '@weldsuite/worker-kit';
import { loadDriveAccessForUser, visibleFilesCondition, canEdit, type DriveRole } from '@weldsuite/core-domain/drive-access';
import { accessibleProjectIds } from '@weldsuite/flow-domain/project-access';
import {
  DEFAULT_BOARD_NAME,
  addToBoardSchema,
  editBoardElementsSchema,
  type AddToBoardResult,
  type EditBoardElementsResult,
} from '@weldsuite/app-api-client/schemas/boards';
import type { Env, Variables } from '../../types';
import { getLiveBoard, legacyElements, listBoards, trashBoard, trashLegacy, updateBoard, type BoardRecord, type BoardScope, type LiveBoardRecord } from '../../services/boards';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { convertInPlace, saveNewBoard } from '../boards';
import { driveRole, eventData, fileEventData, findBoard, mayEditBoard, mayOpenProject, projectAccess, roomFor, roomMeta } from '../boards/access';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Most elements a WeldFlow-format write may carry. */
const MAX_LEGACY_ELEMENTS = 10_000;
const legacyElementsInput = z.array(z.record(z.unknown())).max(MAX_LEGACY_ELEMENTS);

/**
 * The same refusal `licenceGate` answers a write with, ahead of the public
 * routes' handlers: a database move is retryable (503), any other read-only
 * reason is not (403). Null when the workspace may be written to.
 */
function readOnlyRefusal(c: Ctx): Response | null {
  if (!c.get('readOnly')) return null;
  const reason = c.get('readOnlyReason');
  if (reason === 'database_move') return workspaceMovingResponse(c);
  return c.json(workspaceReadOnlyBody(reason), 403);
}

/**
 * What a workspace API key may do here (external-api has checked its
 * `whiteboards:*` scopes): every board of every live project, as WeldFlow's
 * whiteboard API allowed. It has no WeldDrive of its own, so boards outside a
 * project stay out of its reach unless shared with the whole workspace.
 */
const WORKSPACE_KEY_PERMISSIONS = {
  permissions: ['boards:read', 'boards:create', 'boards:update', 'boards:delete', 'projects:read', 'projects:scope:all'],
  role: 'member',
  roleId: null,
  isOwner: false,
};

app.use('/:workspaceId/*', async (c, next) => {
  const person = c.req.header('x-weld-user');
  const workspaceKey = c.req.header('x-weld-workspace-key');
  if (!person && !workspaceKey) return error.unauthorized(c);
  // A key's actor is the key id, as external-api records it.
  const userId = person || workspaceKey!;
  // Callers pass the workspace id or its Clerk org id; either resolves.
  const workspaceRef = c.req.param('workspaceId');
  c.set('userId', userId);
  // Same as workspaceDbMiddleware (the public routes' path): the tenant DB
  // plus the workspace's read-only state, so a lapsed workspace cannot be
  // written to through here either.
  const { id, clerkOrgId, db, readOnly, readOnlyReason } = await getWorkspaceContextForOrg(c.env, workspaceRef);
  c.set('workspaceId', id);
  c.set('clerkOrgId', clerkOrgId ?? workspaceRef);
  c.set('tenantDb', db);
  c.set('readOnly', readOnly);
  c.set('readOnlyReason', readOnlyReason);
  c.set('internalTrusted', true);
  // A person's permissions as they are now, for the same checks the public routes make.
  c.set(
    'userPermissions',
    person ? await resolveEffectivePermissions(createDrizzlePermissionQueries(db, schema, { eq, and, isNull }), person) : WORKSPACE_KEY_PERMISSIONS,
  );
  await next();
});

/** A board's address in the platform. */
function urlOf(board: Pick<BoardRecord, 'id' | 'projectId'>): string {
  return board.projectId ? `/weldflow/project/${board.projectId}/whiteboard/${board.id}` : `/weldboard/${board.id}`;
}

function brief(board: BoardRecord, role: DriveRole) {
  return {
    id: board.id,
    name: board.name,
    projectId: board.projectId,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
    updatedById: board.updatedById,
    revision: board.revision,
    role,
    legacy: board.legacy,
    url: urlOf(board),
  };
}

/** A board in the shape WeldFlow's `/whiteboards` API always returned (a `project_whiteboards` row). */
function legacyRow(board: BoardRecord, elements: unknown[]) {
  return {
    id: board.id,
    projectId: board.projectId,
    name: board.name,
    elements,
    appState: {},
    version: board.revision + 1,
    lastEditedBy: board.updatedById,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
    deletedAt: null,
  };
}

/** The live board as a Board, edits not checkpointed yet included. */
async function liveBoard(c: Ctx, board: LiveBoardRecord): Promise<{ board: Board; revision: number }> {
  const clerkOrgId = c.get('clerkOrgId')!;
  const live = await roomFor(c, clerkOrgId, board).snapshot(roomMeta(board, clerkOrgId));
  return { board: Board.fromSnapshot(JSON.parse(live.json) as BoardSnapshot), revision: live.revision };
}

/** The board converted if it was an old WeldFlow whiteboard (writes need a room); else the response to send. */
async function writable(c: Ctx, board: BoardRecord): Promise<LiveBoardRecord | Response> {
  if (!board.legacy) {
    const live = await getLiveBoard(c.get('tenantDb'), board.id);
    return live ?? error.notFound(c, 'Board', board.id);
  }
  const converted = await convertInPlace(c, board, { clerkOrgId: c.get('clerkOrgId')!, userId: c.get('userId')! });
  return converted?.board ?? error.notFound(c, 'Board', board.id);
}

async function commit(c: Ctx, board: LiveBoardRecord, op: Op): Promise<{ revision: number; committed: boolean; refused?: string }> {
  const clerkOrgId = c.get('clerkOrgId')!;
  return roomFor(c, clerkOrgId, board).applyOps(roomMeta(board, clerkOrgId), op, c.get('userId')!);
}

// ---------------------------------------------------------------------------

const findInput = z.object({
  query: z.string().trim().max(255).optional(),
  projectId: z.string().min(1).max(255).optional(),
  /** Every project board the person may open. */
  projects: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
});

app.post('/:workspaceId/find', zValidator('json', findInput), async (c) => {
  if (!(await hasContextPermission(c, 'boards:read'))) return error.forbidden(c);
  const db = c.get('tenantDb');
  const userId = c.get('userId') ?? null;
  const { query, projectId, projects, limit = 20, offset = 0 } = c.req.valid('json');
  const access = await loadDriveAccessForUser(db, userId);
  let scope: BoardScope = { kind: 'drive' };
  let projectWrite: boolean | null = null;
  if (projectId) {
    const a = await projectAccess(c, projectId);
    if (!mayOpenProject(a)) return error.notFound(c, 'Project', projectId);
    projectWrite = a.canWrite;
    scope = { kind: 'project', projectId };
  } else if (projects) {
    const scopeAll = await hasContextPermission(c, 'projects:scope:all');
    scope = { kind: 'projects', projectIds: await accessibleProjectIds(db, userId ?? undefined, { scopeAll }) };
  }
  const visible = scope.kind === 'drive' ? visibleFilesCondition(access) : undefined;
  const { rows, total } = await listBoards(db, { scope, visible, search: query, limit, offset });
  const writes = new Map<string, boolean>();
  if (scope.kind === 'projects') {
    for (const id of new Set(rows.map((r) => r.projectId).filter((p): p is string => !!p))) writes.set(id, (await projectAccess(c, id)).canWrite);
  }
  const data = rows.map((board) => {
    const base = driveRole(access, board) ?? 'viewer';
    const write = board.projectId ? (projectWrite ?? writes.get(board.projectId) ?? false) : true;
    return brief(board, write ? base : 'viewer');
  });
  return success(c, { boards: data, total, hasMore: offset + rows.length < total });
});

const createInput = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  projectId: z.string().min(1).max(255).optional(),
  /** Start from WeldFlow-format elements (the deprecated whiteboard API). */
  elements: legacyElementsInput.optional(),
  snapshot: z.unknown().optional(),
});

app.post('/:workspaceId/create', zValidator('json', createInput), async (c) => {
  if (!(await hasContextPermission(c, 'boards:create'))) return error.forbidden(c);
  const refused = readOnlyRefusal(c);
  if (refused) return refused;
  const { name, projectId, elements, snapshot } = c.req.valid('json');
  if (projectId) {
    const a = await projectAccess(c, projectId);
    if (!mayOpenProject(a)) return error.notFound(c, 'Project', projectId);
    if (!a.canWrite) return error.forbidden(c, 'You can view this project but not add to it');
  }
  let content: BoardSnapshot = emptySnapshot();
  if (elements) content = convertLegacyWhiteboard(elements, { createdBy: c.get('userId')! });
  else if (snapshot !== undefined) {
    if (!isWellFormedSnapshot(snapshot)) return error.badRequest(c, 'That is not a board snapshot');
    content = Board.fromSnapshot(snapshot).toSnapshot();
  }
  const board = await saveNewBoard(c, {
    workspaceId: c.get('clerkOrgId')!,
    userId: c.get('userId')!,
    name: name ?? DEFAULT_BOARD_NAME,
    folderId: null,
    snapshot: content,
    projectId: projectId ?? null,
  });
  const legacy = elements ? legacyRow(board, toLegacyElements(Board.fromSnapshot(content))) : undefined;
  return success(c, { ...brief(board, 'owner'), ...(legacy ? { legacy: false, row: legacy } : {}) }, 201);
});

const readInput = z.object({
  format: z.enum(['summary', 'legacy', 'outline', 'text', 'snapshot']).default('summary'),
  limit: z.number().int().min(1).max(5000).optional(),
});

app.post('/:workspaceId/:id/read', zValidator('json', readInput), async (c) => {
  if (!(await hasContextPermission(c, 'boards:read'))) return error.forbidden(c);
  const found = await findBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  const { board, role } = found;
  const { format, limit } = c.req.valid('json');
  const summary = brief(board, role);
  if (format === 'summary') return success(c, summary);

  // An old WeldFlow whiteboard is read as it is; it is converted only to be written.
  if (board.legacy) {
    const old = await legacyElements(c.get('tenantDb'), board.id);
    if (!old) return error.notFound(c, 'Board', board.id);
    if (format === 'legacy') return success(c, { ...summary, row: legacyRow(board, old.elements) });
    const converted = Board.fromSnapshot(convertLegacyWhiteboard(old.elements));
    return success(c, { ...summary, ...readAs(converted, format, limit) });
  }
  const live = await getLiveBoard(c.get('tenantDb'), board.id);
  if (!live) return error.notFound(c, 'Board', board.id);
  const { board: content, revision } = await liveBoard(c, live);
  if (format === 'legacy') return success(c, { ...summary, revision, row: legacyRow({ ...live, revision }, toLegacyElements(content)) });
  return success(c, { ...summary, revision, ...readAs(content, format, limit) });
});

function readAs(board: Board, format: 'outline' | 'text' | 'snapshot', limit?: number) {
  if (format === 'outline') return { elements: boardOutline(board, limit ?? 500), count: board.size };
  if (format === 'text') return { text: boardToPlainText(board) };
  return { snapshot: board.toSnapshot() };
}

const updateInput = z
  .object({ name: z.string().trim().min(1).max(255).optional(), elements: legacyElementsInput.optional() })
  .refine((v) => v.name !== undefined || v.elements !== undefined, 'Send a name or elements');

/** Renames the board, with its `file` and `board` events; or the response to send. */
async function renameBoard(c: Ctx, board: LiveBoardRecord, name: string): Promise<LiveBoardRecord | Response> {
  const result = await updateBoard(c.get('tenantDb'), board, { name });
  if (!result.ok) {
    return result.reason === 'name_conflict' ? error.conflict(c, 'A file with this name already exists') : error.notFound(c, 'Board', board.id);
  }
  const changes = { name: { old: board.name, new: result.board.name } };
  publishEntityEvent({ c, entityType: 'file', entityId: result.board.fileId, action: 'updated', data: fileEventData(result.board), changes });
  publishEntityEvent({ c, entityType: 'board', entityId: result.board.id, action: 'updated', data: eventData(result.board), changes });
  return result.board;
}

/** Makes the board match WeldFlow-format elements through its room: the revision after, or the response to send. */
async function writeLegacyElements(c: Ctx, board: LiveBoardRecord, elements: Record<string, unknown>[]): Promise<number | Response> {
  const { board: content } = await liveBoard(c, board);
  const op = legacyWriteOps(content, elements);
  if (isNoop(op)) return board.revision;
  const result = await commit(c, board, op);
  if (!result.committed) return error.badRequest(c, `The change was refused: ${result.refused ?? 'unknown reason'}`);
  return result.revision;
}

app.post('/:workspaceId/:id/update', zValidator('json', updateInput), async (c) => {
  if (!(await hasContextPermission(c, 'boards:update'))) return error.forbidden(c);
  const refused = readOnlyRefusal(c);
  if (refused) return refused;
  const found = await findBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  if (!(await mayEditBoard(c, found.role))) return error.forbidden(c, 'You can view this board but not change it');
  const target = await writable(c, found.board);
  if (target instanceof Response) return target;
  const { name, elements } = c.req.valid('json');

  const board = name !== undefined && name !== target.name ? await renameBoard(c, target, name) : target;
  if (board instanceof Response) return board;
  const revision = elements ? await writeLegacyElements(c, board, elements) : board.revision;
  if (revision instanceof Response) return revision;
  const { board: after } = await liveBoard(c, board);
  return success(c, { ...brief({ ...board, revision }, found.role), row: legacyRow({ ...board, revision }, toLegacyElements(after)) });
});

app.post('/:workspaceId/:id/apply', zValidator('json', z.object({ op: z.unknown() })), async (c) => {
  if (!(await hasContextPermission(c, 'boards:update'))) return error.forbidden(c);
  const refused = readOnlyRefusal(c);
  if (refused) return refused;
  const { op } = c.req.valid('json');
  if (!isWellFormedOp(op)) return error.badRequest(c, 'That is not a board op');
  const found = await findBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  if (!(await mayEditBoard(c, found.role))) return error.forbidden(c, 'You can view this board but not change it');
  const target = await writable(c, found.board);
  if (target instanceof Response) return target;
  const result = await commit(c, target, op);
  if (!result.committed) return error.badRequest(c, `The change was refused: ${result.refused ?? 'unknown reason'}`);
  return success(c, { revision: result.revision, url: urlOf(target) });
});

/** The board to write to, converted if it was an old WeldFlow whiteboard; else the response to send. */
async function writeTarget(c: Ctx): Promise<LiveBoardRecord | Response> {
  if (!(await hasContextPermission(c, 'boards:update'))) return error.forbidden(c);
  const refused = readOnlyRefusal(c);
  if (refused) return refused;
  const found = await findBoard(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  if (!(await mayEditBoard(c, found.role))) return error.forbidden(c, 'You can view this board but not change it');
  return writable(c, found.board);
}

app.post('/:workspaceId/:id/add', zValidator('json', addToBoardSchema), async (c) => {
  const target = await writeTarget(c);
  if (target instanceof Response) return target;
  const { spec, at } = c.req.valid('json');
  const { board } = await liveBoard(c, target);
  const placed = placeSpec(board, spec, { createdBy: c.get('userId')!, now: Date.now(), ...(at ? { at } : {}) });
  if (!placed.all.length) return error.badRequest(c, 'There is nothing to add');
  const result = await commit(c, target, placed.op);
  if (!result.committed) return error.badRequest(c, `The change was refused: ${result.refused ?? 'unknown reason'}`);
  return success(c, { revision: result.revision, elementIds: placed.ids, keys: placed.keys, url: urlOf(target) } satisfies AddToBoardResult, 201);
});

app.post('/:workspaceId/:id/edit', zValidator('json', editBoardElementsSchema), async (c) => {
  const target = await writeTarget(c);
  if (target instanceof Response) return target;
  const { board, revision } = await liveBoard(c, target);
  const { op, changed, skipped } = editOps(board, c.req.valid('json').changes);
  if (isNoop(op)) return success(c, { revision, changed: [], skipped, url: urlOf(target) } satisfies EditBoardElementsResult);
  const result = await commit(c, target, op);
  if (!result.committed) return error.badRequest(c, `The change was refused: ${result.refused ?? 'unknown reason'}`);
  return success(c, { revision: result.revision, changed, skipped, url: urlOf(target) } satisfies EditBoardElementsResult);
});

app.post('/:workspaceId/:id/delete', async (c) => {
  if (!(await hasContextPermission(c, 'boards:delete'))) return error.forbidden(c);
  const refused = readOnlyRefusal(c);
  if (refused) return refused;
  const found = await findBoard(c, c.req.param('id'));
  if (found instanceof Response) return found;
  if (!canEdit(found.role)) return error.forbidden(c, 'You can view this board but not change it');
  const db = c.get('tenantDb');
  if (found.board.legacy) {
    // The caller (the deprecated whiteboard API) reports it as a `project_whiteboard` deletion.
    if (!(await trashLegacy(db, found.board.id))) return error.notFound(c, 'Board', found.board.id);
    return noContent(c);
  }
  const live = await getLiveBoard(db, found.board.id);
  if (!live || !(await trashBoard(db, live))) return error.notFound(c, 'Board', found.board.id);
  publishEntityEvent({ c, entityType: 'file', entityId: live.fileId, action: 'deleted', data: fileEventData(live) });
  publishEntityEvent({ c, entityType: 'board', entityId: live.id, action: 'deleted', data: eventData(live) });
  return noContent(c);
});

export default app;
