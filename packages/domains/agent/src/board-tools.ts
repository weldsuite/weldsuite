/**
 * WeldAgent tools for WeldBoard boards.
 *
 * A board lives in its room (board-api's BoardRoom Durable Object), so these
 * tools call board-api over its `BoardsInternal` service binding
 * (`BOARDS_INTERNAL`), through @weldsuite/board-domain's client. Every call
 * acts for the person the agent works for: it finds, reads and changes only
 * the boards their WeldDrive access (and project membership) allows, and a
 * write is an edit everyone with the board open watches arrive.
 *
 * Agents do not draw: they describe what goes on the board (sticky notes,
 * shapes, frames, arrows, a mind map) and board-api lays it out.
 */

import { z } from 'zod';
import { boardsInternal, type BoardsInternalClient } from '@weldsuite/board-domain/internal-client';
import { BOARD_SPEC_COLORS, boardSpecToolSchema } from '@weldsuite/app-api-client/schemas/boards';
import type { PlatformToolDefinition, ToolContext } from './tools';

const boardParam = z.string().min(1).max(255).describe('The board id (from find_boards or create_board)');
const color = z.enum(BOARD_SPEC_COLORS);
const spec = boardSpecToolSchema.describe('What to put on the board; board-api lays it out');

const findParams = z.object({
  query: z.string().max(255).optional().describe('Part of the board name'),
  projectId: z.string().max(255).optional().describe('Only this WeldFlow project’s boards'),
  limit: z.number().int().min(1).max(50).optional(),
});

const createParams = z.object({
  name: z.string().trim().min(1).max(255),
  projectId: z.string().max(255).optional().describe('Make it a board of this WeldFlow project (default: the user’s My Drive)'),
  content: spec.optional().describe('Optional starting content'),
});

const readParams = z.object({
  boardId: boardParam,
  format: z.enum(['outline', 'text']).optional().describe('outline: elements with id, type, text, position and frame (default); text: the board’s text only'),
  limit: z.number().int().min(1).max(2000).optional().describe('Most elements in an outline (default 500)'),
});

const addParams = z.object({
  boardId: boardParam,
  content: spec,
  at: z.object({ x: z.number(), y: z.number() }).optional().describe('Board point for the middle of the new content; default right of what is there'),
});

const updateParams = z.object({
  boardId: boardParam,
  name: z.string().trim().min(1).max(255).optional().describe('A new name for the board'),
  changes: z
    .array(
      z.object({
        id: z.string().min(1).max(64).describe('An element id from read_board'),
        text: z.string().max(2000).optional(),
        color: color.optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        delete: z.boolean().optional(),
      }),
    )
    .max(500)
    .optional(),
});

function client(ctx: ToolContext): BoardsInternalClient | null {
  const fetcher = ctx.env?.BOARDS_INTERNAL;
  return fetcher ? boardsInternal({ fetcher, workspace: ctx.workspaceId, actor: { userId: ctx.actorUserId } }) : null;
}

const UNAVAILABLE = { error: 'Boards are not available to agents here' };

/** The `data` of board-api's answer, or its refusal as an error the agent can read. */
async function unwrap(res: Response): Promise<unknown> {
  const payload = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
  if (!res.ok) return { error: payload?.error?.message ?? `The board request failed (${res.status})` };
  return payload?.data ?? { ok: true };
}

export const BOARD_TOOLS: PlatformToolDefinition[] = [
  {
    id: 'boards.find',
    name: 'find_boards',
    description: 'Find WeldBoard whiteboards by name (the ones the user can open), most recently changed first; or the boards of a WeldFlow project.',
    requiredPermissions: ['boards:read'],
    parameters: findParams,
    async execute(ctx, raw) {
      const api = client(ctx);
      if (!api) return UNAVAILABLE;
      return unwrap(await api.find(findParams.parse(raw)));
    },
  },
  {
    id: 'boards.create',
    name: 'create_board',
    description: 'Create a new WeldBoard whiteboard (in the user’s My Drive, or in a WeldFlow project), optionally with sticky notes, shapes, frames, arrows or a mind map on it.',
    requiredPermissions: ['boards:create'],
    parameters: createParams,
    async execute(ctx, raw) {
      const api = client(ctx);
      if (!api) return UNAVAILABLE;
      const { content, ...input } = createParams.parse(raw);
      const created = (await unwrap(await api.create(input))) as { id?: string; error?: string };
      if (!content || created.error || !created.id) return created;
      const added = (await unwrap(await api.add(created.id, { spec: content }))) as Record<string, unknown>;
      return { ...created, content: added };
    },
  },
  {
    id: 'boards.read',
    name: 'read_board',
    description: 'Read a board: its elements (id, type, text, position, frame) or just its text. Includes edits others are making right now.',
    requiredPermissions: ['boards:read'],
    parameters: readParams,
    async execute(ctx, raw) {
      const api = client(ctx);
      if (!api) return UNAVAILABLE;
      const { boardId, format = 'outline', limit } = readParams.parse(raw);
      return unwrap(await api.read(boardId, format, limit));
    },
  },
  {
    id: 'boards.add',
    name: 'add_to_board',
    description:
      'Put sticky notes, shapes, text, cards, frames, arrows or a mind map on a board. Describe them; the board lays them out. Everyone with the board open sees them arrive; the user can undo it from version history.',
    requiredPermissions: ['boards:update'],
    parameters: addParams,
    async execute(ctx, raw) {
      const api = client(ctx);
      if (!api) return UNAVAILABLE;
      const { boardId, content, at } = addParams.parse(raw);
      return unwrap(await api.add(boardId, { spec: content, ...(at ? { at } : {}) }));
    },
  },
  {
    id: 'boards.update',
    name: 'update_board',
    description: 'Rename a board, and change or remove elements on it by id (text, colour, position, delete). Get the ids from read_board.',
    requiredPermissions: ['boards:update'],
    parameters: updateParams,
    async execute(ctx, raw) {
      const api = client(ctx);
      if (!api) return UNAVAILABLE;
      const { boardId, name, changes } = updateParams.parse(raw);
      if (!name && !changes?.length) return { error: 'Send a name or changes' };
      const out: Record<string, unknown> = {};
      if (name) {
        const renamed = (await unwrap(await api.update(boardId, { name }))) as { error?: string; name?: string; url?: string };
        if (renamed.error) return renamed;
        out.name = renamed.name;
        out.url = renamed.url;
      }
      if (changes?.length) {
        const edited = (await unwrap(await api.edit(boardId, { changes }))) as Record<string, unknown>;
        if (edited.error) return edited;
        Object.assign(out, edited);
      }
      return out;
    },
  },
];
