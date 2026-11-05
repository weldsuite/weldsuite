import { z } from 'zod';
import {
  BOARD_SPEC_COLORS,
  boardSpecToolSchema,
} from '@weldsuite/app-api-client/schemas/boards';
import type { ToolDefinition } from '../registry';

/**
 * WeldBoard tools: whiteboards in the user's WeldDrive and in WeldFlow
 * projects. Content is described, not drawn (a board spec); the board lays it
 * out, and people with the board open watch it arrive.
 */

const boardId = z.string().describe('The board — its name, or the id from an earlier search');

export const weldboardTools: ToolDefinition[] = [
  {
    name: 'search_boards',
    scope: 'boards:read',
    description:
      'List/search WeldBoard whiteboards the user can open: their WeldDrive boards by default, or every project board (scope "projects"), or one project\'s. Cursor-paginated.',
    inputSchema: {
      search: z.string().optional().describe('Match against the board name'),
      projectId: z.string().optional().describe('Only this WeldFlow project\'s boards'),
      scope: z.enum(['drive', 'projects']).optional().describe('drive: the user\'s WeldDrive boards; projects: every project board they can open'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
      limit: z.number().min(1).max(100).optional().describe('Page size (1-100, default 25)'),
    },
    method: 'GET',
    path: '/v1/boards',
  },
  {
    name: 'get_board',
    scope: 'boards:read',
    description:
      'Get a board with its elements (id, type, text, position, frame) — or just its text — including edits people are making right now.',
    inputSchema: {
      id: boardId,
      format: z.enum(['outline', 'text']).optional().describe('outline (default): the elements; text: the board\'s text only'),
      limit: z.number().min(1).max(2000).optional().describe('Most elements in an outline (default 500)'),
    },
    method: 'GET',
    path: '/v1/boards/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'create_board',
    scope: 'boards:write',
    description:
      'Create a WeldBoard whiteboard in the user\'s My Drive or in a WeldFlow project, optionally with content: sticky notes, shapes, text, cards, frames, arrows or a mind map.',
    inputSchema: {
      name: z.string().max(255).optional(),
      projectId: z.string().optional().describe('Make it a board of this project'),
      content: boardSpecToolSchema.optional().describe('What to put on the new board'),
    },
    method: 'POST',
    path: '/v1/boards',
  },
  {
    name: 'add_to_board',
    scope: 'boards:write',
    description:
      'Put sticky notes, shapes, text, cards, frames, arrows or a mind map on a board. Describe them; the board lays them out (a flowchart follows its arrows). Can be undone from version history.',
    inputSchema: {
      id: boardId,
      spec: boardSpecToolSchema,
      at: z.object({ x: z.number(), y: z.number() }).optional().describe('Board point for the middle of the new content; default right of what is there'),
    },
    method: 'POST',
    path: '/v1/boards/:id/elements',
    pathParams: { id: 'id' },
  },
  {
    name: 'update_board_elements',
    scope: 'boards:write',
    description: 'Change or remove elements on a board by id (from get_board): new text, a colour, a position, or delete.',
    inputSchema: {
      id: boardId,
      changes: z
        .array(
          z.object({
            id: z.string().describe('An element id from get_board'),
            text: z.string().max(2000).optional(),
            color: z.enum(BOARD_SPEC_COLORS).optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            delete: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(500),
    },
    method: 'PATCH',
    path: '/v1/boards/:id/elements',
    pathParams: { id: 'id' },
    annotations: { destructiveHint: true },
  },
  {
    name: 'update_board',
    scope: 'boards:write',
    description: 'Rename a board.',
    inputSchema: { id: boardId, name: z.string().min(1).max(255) },
    method: 'PATCH',
    path: '/v1/boards/:id',
    pathParams: { id: 'id' },
  },
  {
    name: 'delete_board',
    scope: 'boards:write',
    description: 'Move a board to the trash (WeldDrive empties it after 30 days).',
    inputSchema: { id: boardId },
    method: 'DELETE',
    path: '/v1/boards/:id',
    pathParams: { id: 'id' },
    exactId: true,
  },
];
