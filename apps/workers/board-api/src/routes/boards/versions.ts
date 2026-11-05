/**
 * Version history: /api/boards/:id/versions/*.
 *
 *   GET    /                        → saved versions, newest first (read access)
 *   POST   /                        → save the board as it is now under a name (edit access)
 *   PATCH  /:versionId              → rename a version (edit access)
 *   GET    /:versionId/snapshot     → the board as the version saved it (read access)
 *   POST   /:versionId/restore      → make the version the board again (edit access)
 *
 * The board's room holds the live board, so it writes the snapshots: a
 * version is the room's state when it was saved, edits not checkpointed yet
 * included. A restore first saves the board as it was as an automatic
 * version (no name), and every client in the room reloads (see BoardRoom).
 * The same routes as WeldDocs' and WeldSheets' version history.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  createBoardVersionSchema,
  listBoardVersionsQuerySchema,
  updateBoardVersionSchema,
  type BoardRestoreResult,
} from '@weldsuite/app-api-client/schemas/boards';
import type { Env, Variables } from '../../types';
import { getLiveBoard } from '../../services/boards';
import { getVersion, insertVersion, listVersions, renameVersion, toVersion, versionEventData, versionKeyFor } from '../../services/versions';
import { readSnapshot } from '../../room/snapshot';
import { editableBoard, eventData, findLiveBoard, roomFor, roomMeta, type Ctx } from './access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_LIMIT = 50;

app.get('/', requirePermission('boards:read'), zValidator('query', listBoardVersionsQuerySchema), async (c) => {
  const found = await findLiveBoard(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  const { limit = DEFAULT_LIMIT, cursor } = c.req.valid('query');
  const { rows, total, hasMore } = await listVersions(c.get('tenantDb'), found.board.id, { limit, after: cursor });
  const last = rows.at(-1);
  return list(c, rows.map(toVersion), cursorPagination(total, hasMore, hasMore && last ? last.id : null));
});

app.post('/', requirePermission('boards:update'), zValidator('json', createBoardVersionSchema), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  const board = await editableBoard(c);
  if (board instanceof Response) return board;

  const meta = roomMeta(board, clerkOrgId);
  const id = generateId('brdv');
  const snapshotKey = versionKeyFor(meta.snapshotKey, id);
  const saved = await roomFor(c, clerkOrgId, board).saveVersion(meta, snapshotKey);
  const row = await insertVersion(c.get('tenantDb'), {
    id,
    boardId: board.id,
    revision: saved.revision,
    name: c.req.valid('json').name,
    snapshotKey,
    size: saved.size,
    createdById: userId,
  });
  publishEntityEvent({ c, entityType: 'board_version', entityId: row.id, action: 'created', data: versionEventData(row) });
  return success(c, toVersion(row), 201);
});

app.patch('/:versionId', requirePermission('boards:update'), zValidator('json', updateBoardVersionSchema), async (c) => {
  const board = await editableBoard(c);
  if (board instanceof Response) return board;
  const versionId = c.req.param('versionId');
  const db = c.get('tenantDb');
  const previous = await getVersion(db, board.id, versionId);
  if (!previous) return error.notFound(c, 'Version', versionId);
  const row = await renameVersion(db, board.id, versionId, c.req.valid('json').name);
  if (!row) return error.notFound(c, 'Version', versionId);
  publishEntityEvent({
    c,
    entityType: 'board_version',
    entityId: row.id,
    action: 'updated',
    data: versionEventData(row),
    changes: { name: { old: previous.name, new: row.name } },
  });
  return success(c, toVersion(row));
});

app.get('/:versionId/snapshot', requirePermission('boards:read'), async (c: Ctx) => {
  const found = await findLiveBoard(c, c.req.param('id') ?? '');
  if (found instanceof Response) return found;
  const versionId = c.req.param('versionId') ?? '';
  const version = await getVersion(c.get('tenantDb'), found.board.id, versionId);
  const stored = version ? await readSnapshot(c.env.PRIVATE_STORAGE, version.snapshotKey) : null;
  if (!version || !stored) return error.notFound(c, 'Version', versionId);
  c.header('Cache-Control', 'private, no-store');
  return success(c, { revision: stored.revision, snapshot: stored.board });
});

app.post('/:versionId/restore', requirePermission('boards:update'), async (c) => {
  const userId = c.get('userId');
  const clerkOrgId = c.get('clerkOrgId');
  if (!userId) return error.unauthorized(c);
  if (!clerkOrgId) return error.orgRequired(c);
  const board = await editableBoard(c);
  if (board instanceof Response) return board;
  const versionId = c.req.param('versionId');
  const db = c.get('tenantDb');
  const version = await getVersion(db, board.id, versionId);
  if (!version) return error.notFound(c, 'Version', versionId);

  const autoVersionId = generateId('brdv');
  const outcome = await roomFor(c, clerkOrgId, board).restoreVersion({
    board: roomMeta(board, clerkOrgId),
    versionId,
    versionKey: version.snapshotKey,
    autoVersionId,
    userId,
  });
  if (!outcome.ok) return error.notFound(c, 'Version', versionId);
  const autoVersion = await getVersion(db, board.id, autoVersionId);
  if (!autoVersion) throw new Error(`The automatic version ${autoVersionId} is missing after a restore`);

  const updated = (await getLiveBoard(db, board.id)) ?? board;
  publishEntityEvent({ c, entityType: 'board_version', entityId: autoVersion.id, action: 'created', data: versionEventData(autoVersion) });
  publishEntityEvent({
    c,
    entityType: 'board',
    entityId: board.id,
    action: 'updated',
    data: { ...eventData(updated), revision: outcome.revision, updatedById: userId },
    changes: { revision: { old: autoVersion.revision, new: outcome.revision } },
  });
  return success(c, { revision: outcome.revision, autoVersion: toVersion(autoVersion) } satisfies BoardRestoreResult);
});

export default app;
