/**
 * `/v1/boards` — WeldBoard whiteboards, through board-api's BoardsInternal
 * entrypoint (BOARDS_INTERNAL). Scopes `boards:read` and `boards:write`.
 *
 *   GET    /v1/boards                  → boards (`search`, `projectId`, `scope`)
 *   GET    /v1/boards/:id              → one board, with its elements (`format=outline|text`)
 *   POST   /v1/boards                  → create, optionally with content (a board spec)
 *   PATCH  /v1/boards/:id              → rename
 *   POST   /v1/boards/:id/elements     → add content: sticky notes, shapes, text, cards, frames, arrows, a mind map
 *   PATCH  /v1/boards/:id/elements     → change or remove elements by id
 *   DELETE /v1/boards/:id              → move to the trash
 *
 * Content is described, not drawn (`boardSpecSchema` in
 * @weldsuite/app-api-client/schemas/boards); board-api lays it out and commits
 * it through the board's room, so people with the board open see it arrive.
 *
 * Who the call acts for: a personal key acts as its owner (their WeldDrive
 * access and project membership); a workspace key reaches every project's
 * boards and no one's own drive. board-api publishes the `board` and `file`
 * entity events, except for an old WeldFlow whiteboard nobody opened since
 * WeldBoard: its deletion is a `project_whiteboard` one, published here.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { boardsInternal, type BoardBrief } from '@weldsuite/board-domain/internal-client';
import { addToBoardSchema, boardSpecSchema, editBoardElementsSchema } from '@weldsuite/app-api-client/schemas/boards';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, list, noContent, success } from '../../../lib/response';

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

const listBoardsQuery = z.object({
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().max(255).optional(),
  projectId: z.string().max(255).optional(),
  /** `drive`: the caller's WeldDrive boards; `projects`: every project board they may open. */
  scope: z.enum(['drive', 'projects']).optional(),
});

const readQuery = z.object({
  format: z.enum(['outline', 'text']).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

const createBoardBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  projectId: z.string().max(255).optional(),
  content: boardSpecSchema.optional(),
});

const renameBody = z.object({ name: z.string().trim().min(1).max(255) });

const app = new Hono<HonoEnv>();

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
  return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'WeldBoard is not available on this server' } }, 503);
}

/** board-api's refusal as it was, or the `data` of its answer. */
async function unwrap<T>(res: Response): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  if (!res.ok) return { ok: false, response: new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } }) };
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: ((await res.json()) as { data: T }).data };
}

/** A board as the public API shows it (board-api's brief, without its internal fields). */
function view(b: BoardBrief) {
  return { id: b.id, name: b.name, projectId: b.projectId, revision: b.revision, role: b.role, url: b.url, createdAt: b.createdAt, updatedAt: b.updatedAt, updatedById: b.updatedById };
}

app.get('/', requireScope('boards:read'), zValidator('query', listBoardsQuery), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const q = c.req.valid('query');
  const limit = Math.min(q.limit ?? DEFAULT_PAGE, MAX_PAGE);
  const offset = q.cursor ? Number(q.cursor) : 0;
  // A workspace key has no drive of its own: its boards are the projects'.
  const projects = q.scope === 'projects' || (!q.scope && !c.get('apiSession')?.userId);
  let scope: { projectId: string } | { projects: true } | object = {};
  if (q.projectId) scope = { projectId: q.projectId };
  else if (projects) scope = { projects: true };
  const found = await unwrap<{ boards: BoardBrief[]; total: number; hasMore: boolean }>(await client.find({ query: q.search, limit, offset, ...scope }));
  if (!found.ok) return found.response;
  const { boards: rows, total, hasMore } = found.data;
  return list(c, rows.map(view), cursorPagination(total, hasMore, hasMore ? String(offset + rows.length) : null));
});

app.get('/:id', requireScope('boards:read'), zValidator('query', readQuery), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const { format = 'outline', limit } = c.req.valid('query');
  const read = await unwrap<BoardBrief & Record<string, unknown>>(await client.read(c.req.param('id'), format, limit));
  if (!read.ok) return read.response;
  const { elements, count, text } = read.data as { elements?: unknown; count?: number; text?: string };
  return success(c, { ...view(read.data), ...(format === 'text' ? { text } : { elements, count }) });
});

app.post('/', requireScope('boards:write'), zValidator('json', createBoardBody), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const { content, ...input } = c.req.valid('json');
  if (!input.projectId && !c.get('apiSession')?.userId) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'A workspace key creates project boards only: send a projectId' } }, 400);
  }
  const created = await unwrap<BoardBrief>(await client.create(input));
  if (!created.ok) return created.response;
  if (!content) return success(c, view(created.data), 201);
  const added = await unwrap<{ revision: number; elementIds: string[]; keys: Record<string, string> }>(await client.add(created.data.id, { spec: content }));
  if (!added.ok) return added.response;
  return success(c, { ...view(created.data), revision: added.data.revision, elementIds: added.data.elementIds, keys: added.data.keys }, 201);
});

app.patch('/:id', requireScope('boards:write'), zValidator('json', renameBody), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const updated = await unwrap<BoardBrief>(await client.update(c.req.param('id'), c.req.valid('json')));
  if (!updated.ok) return updated.response;
  return success(c, view(updated.data));
});

app.post('/:id/elements', requireScope('boards:write'), zValidator('json', addToBoardSchema), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const added = await unwrap<Record<string, unknown>>(await client.add(c.req.param('id'), c.req.valid('json')));
  if (!added.ok) return added.response;
  return success(c, added.data, 201);
});

app.patch('/:id/elements', requireScope('boards:write'), zValidator('json', editBoardElementsSchema), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const edited = await unwrap<Record<string, unknown>>(await client.edit(c.req.param('id'), c.req.valid('json')));
  if (!edited.ok) return edited.response;
  return success(c, edited.data);
});

app.delete('/:id', requireScope('boards:write'), async (c) => {
  const client = boards(c);
  if (!client) return unavailable(c);
  const id = c.req.param('id');
  const brief = await unwrap<BoardBrief>(await client.read(id, 'summary'));
  if (!brief.ok) return brief.response;
  const removed = await unwrap<void>(await client.remove(id));
  if (!removed.ok) return removed.response;
  if (brief.data.legacy) publishEntityEvent({ c, entityType: 'project_whiteboard', entityId: id, action: 'deleted', data: { id } });
  return noContent(c);
});

export default app;
