/**
 * `/v1/whiteboards` — deprecated. WeldFlow's project whiteboards are WeldBoard
 * boards now (docs/plans/weldboard.md, ADR BOARD-001); this keeps the old API
 * working on top of them, in WeldFlow's elements format, through board-api's
 * BoardsInternal entrypoint (BOARDS_INTERNAL). A write is turned into board
 * ops and committed through the board's room, so people with the board open
 * see it arrive.
 *
 *   - Only a project's boards are whiteboards here, as before.
 *   - Elements the old format cannot show (frames, cards, mind maps, …) are
 *     left out of a read and left alone by a write.
 *   - Lists are offset pages (the cursor is the next offset); at most 50 a page,
 *     since every row carries its elements.
 *
 * On a backend without WeldBoard (BOARDS_INTERNAL unset: the Rust backend's
 * editions) the Rust worker serves this route on `project_whiteboards`.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { boardsInternal, type BoardBrief, type LegacyWhiteboardRow } from '@weldsuite/board-domain/internal-client';
import { createWhiteboardSchema, updateWhiteboardSchema } from '@weldsuite/core-api-client/schemas/whiteboards';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, error, list, noContent, success } from '../../../lib/response';

const MAX_PAGE = 50;
const DEFAULT_PAGE = 20;
/** The name WeldFlow gave a whiteboard created without one. */
const DEFAULT_NAME = 'Main Whiteboard';

const listWhiteboardsQuery = z.object({
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().max(255).optional(),
  projectId: z.string().optional(),
});

const app = new Hono<HonoEnv>();

/** The board-api client for this request's caller, or null when this backend has no WeldBoard. */
function boards(c: Context<HonoEnv>) {
  const fetcher = c.env.BOARDS_INTERNAL;
  const session = c.get('apiSession');
  if (!fetcher || !session) return null;
  return boardsInternal({
    fetcher,
    workspace: session.workspaceId,
    actor: session.userId ? { userId: session.userId } : { workspaceKey: session.keyId },
  });
}

function unavailable(c: Context<HonoEnv>) {
  return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Whiteboards are not available on this server' } }, 503);
}

/** board-api's refusal as it was, or the `data` of its answer. */
async function unwrap<T>(res: Response): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  if (!res.ok) return { ok: false, response: new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } }) };
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: ((await res.json()) as { data: T }).data };
}

type Client = NonNullable<ReturnType<typeof boards>>;

/**
 * A board as a whiteboard row, when it is a project's board; or the response
 * to send. Only a project's boards are whiteboards here: a board in someone's
 * WeldDrive is a 404, whatever the caller may do to it through `/v1/boards`.
 */
async function projectWhiteboard(c: Context<HonoEnv>, client: Client, id: string): Promise<LegacyWhiteboardRow | Response> {
  const read = await unwrap<{ row: LegacyWhiteboardRow }>(await client.read(id, 'legacy'));
  if (!read.ok) return read.response;
  if (!read.data.row.projectId) return error.notFound(c, 'Whiteboard', id);
  return read.data.row;
}

function eventData(row: Pick<LegacyWhiteboardRow, 'id' | 'name' | 'projectId'>) {
  return { id: row.id, name: row.name, projectId: row.projectId };
}

app.get('/', requireScope('whiteboards:read'), zValidator('query', listWhiteboardsQuery), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const q = c.req.valid('query');
  const limit = Math.min(q.limit ?? DEFAULT_PAGE, MAX_PAGE);
  const offset = q.cursor ? Number(q.cursor) : 0;
  const found = await unwrap<{ boards: BoardBrief[]; total: number; hasMore: boolean }>(
    await client.find({ query: q.search, limit, offset, ...(q.projectId ? { projectId: q.projectId } : { projects: true }) }),
  );
  if (!found.ok) return found.response;
  const rows = await Promise.all(
    found.data.boards.map(async (b) => {
      const read = await unwrap<{ row: LegacyWhiteboardRow }>(await client.read(b.id, 'legacy'));
      return read.ok ? read.data.row : null;
    }),
  );
  const { total, hasMore } = found.data;
  const next = offset + found.data.boards.length;
  return list(c, rows.filter((r): r is LegacyWhiteboardRow => r !== null), cursorPagination(total, hasMore, hasMore ? String(next) : null));
});

app.get('/:id', requireScope('whiteboards:read'), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const row = await projectWhiteboard(c, client, c.req.param('id'));
  if (row instanceof Response) return row;
  return success(c, row);
});

app.post('/', requireScope('whiteboards:write'), zValidator('json', createWhiteboardSchema), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const body = c.req.valid('json') as { name?: string; projectId?: string | null; elements?: unknown };
  if (!body.projectId) return error.badRequest(c, 'A whiteboard belongs to a project: send its projectId');
  const elements = Array.isArray(body.elements) ? body.elements : [];
  const created = await unwrap<{ row: LegacyWhiteboardRow }>(
    await client.create({ name: body.name || DEFAULT_NAME, projectId: body.projectId, elements }),
  );
  if (!created.ok) return created.response;
  const row = created.data.row;
  publishEntityEvent({ c, entityType: 'project_whiteboard', entityId: row.id, action: 'created', data: eventData(row) });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('whiteboards:write'), zValidator('json', updateWhiteboardSchema), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const id = c.req.param('id');
  const body = c.req.valid('json') as { name?: string; elements?: unknown };
  const changes = {
    ...(typeof body.name === 'string' && body.name ? { name: body.name } : {}),
    ...(Array.isArray(body.elements) ? { elements: body.elements } : {}),
  };
  const current = await projectWhiteboard(c, client, id);
  if (current instanceof Response) return current;
  let row = current;
  if (Object.keys(changes).length > 0) {
    const updated = await unwrap<{ row: LegacyWhiteboardRow }>(await client.update(id, changes));
    if (!updated.ok) return updated.response;
    row = updated.data.row;
  }
  publishEntityEvent({ c, entityType: 'project_whiteboard', entityId: id, action: 'updated', data: eventData(row) });
  return success(c, row);
});

app.delete('/:id', requireScope('whiteboards:write'), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const id = c.req.param('id');
  const current = await projectWhiteboard(c, client, id);
  if (current instanceof Response) return current;
  const removed = await unwrap<void>(await client.remove(id));
  if (!removed.ok) return removed.response;
  publishEntityEvent({ c, entityType: 'project_whiteboard', entityId: id, action: 'deleted', data: { id } });
  return noContent(c);
});

export default app;
