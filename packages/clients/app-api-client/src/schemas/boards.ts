/**
 * WeldBoard: the contract between board-api and the platform. Zod v3.
 *
 * A board is a WeldDrive file (`files`) plus a `whiteboards` row. These
 * routes create, list, rename and trash it and open a session on it; the
 * content itself only travels over the board's room socket (the
 * @weldsuite/board-engine collab protocol). See docs/plans/weldboard.md.
 */

import { z } from 'zod';

/** MIME type of a board's drive file (it has no file of its own to download). */
export const WELDBOARD_MIME_TYPE = 'application/vnd.weldsuite.board+json';

/** Path of the room socket; the session ticket goes in `?ticket=`. */
export const BOARD_CONNECT_PATH = '/api/boards/connect';

/** Largest initial snapshot `POST /api/boards` takes, as JSON. */
export const BOARD_SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;

/** Name a board gets when none is given. */
export const DEFAULT_BOARD_NAME = 'Untitled board';

const boardName = z.string().trim().min(1).max(255);

/** A board snapshot (`BoardSnapshot` in @weldsuite/board-engine), typed by its version alone: board-api checks the rest. */
export interface BoardSnapshotLike {
  version: number;
}

const boardSnapshot = z.custom<BoardSnapshotLike>(
  (v) => typeof v === 'object' && v !== null && Number.isInteger((v as { version?: unknown }).version),
  'Expected a board snapshot',
);

export const TEMPLATE_CATEGORIES = ['meetings', 'ideation', 'planning', 'strategy', 'diagramming', 'other'] as const;
export type BoardTemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const createBoardSchema = z.object({
  name: boardName.optional(),
  folderId: z.string().nullish(),
  /** A WeldFlow project the board belongs to (its access follows the project). */
  projectId: z.string().min(1).max(255).optional(),
  /** The content to start from (an import, a built-in template placed by the platform). */
  snapshot: boardSnapshot.optional(),
  /** Start as a copy of another board (a workspace template, or "duplicate"). */
  fromBoardId: z.string().min(1).max(255).optional(),
  /** Save it as a workspace template. */
  template: z.object({ category: z.enum(TEMPLATE_CATEGORIES) }).optional(),
});
export type CreateBoardInput = z.infer<typeof createBoardSchema>;

export const updateBoardSchema = z
  .object({
    name: boardName.optional(),
    /** Move to a folder; null moves it to My Drive. */
    folderId: z.string().nullable().optional(),
    /** Make it a workspace template (a category), or stop (null). */
    template: z.object({ category: z.enum(TEMPLATE_CATEGORIES) }).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.folderId !== undefined || v.template !== undefined, 'Send a name, a folder or a template setting');
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>;

export const listBoardsQuerySchema = z.object({
  search: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  /** Only this project's boards (old WeldFlow whiteboards not converted yet included). */
  projectId: z.string().min(1).max(255).optional(),
  /** Every project board the caller may open, across projects. */
  projects: z.enum(['true', 'false']).optional(),
  /** Only workspace templates. */
  templates: z.enum(['true', 'false']).optional(),
});
export type ListBoardsQuery = z.input<typeof listBoardsQuerySchema>;

export type BoardRole = 'owner' | 'editor' | 'viewer';

export interface BoardSummary {
  id: string;
  /** The backing drive file; null for a WeldFlow whiteboard not converted yet. */
  fileId: string | null;
  name: string;
  folderId: string | null;
  /** The WeldFlow project it belongs to. */
  projectId: string | null;
  createdAt: string;
  /** Last change to the name or the content (content as of the room's last checkpoint). */
  updatedAt: string;
  createdById: string | null;
  updatedById: string | null;
  revision: number;
  /** The caller's role on the drive file (a project board: from the project). */
  role: BoardRole;
  /** The caller may change it. */
  canEdit: boolean;
  /** A workspace template, with its gallery category. */
  templateCategory: BoardTemplateCategory | null;
  /** An old WeldFlow whiteboard: it becomes a board the first time someone opens it. */
  legacy: boolean;
}

/**
 * What the room lets this person do: `edit` everything; `comment` only add,
 * move and resolve comment pins (a viewer with `boards:comment`); `view`
 * nothing (any op is refused).
 */
export type BoardSessionMode = 'edit' | 'comment' | 'view';

export interface BoardSession {
  /** Single-use, valid for a minute: `${BOARD_CONNECT_PATH}?ticket=…` opens the room. */
  ticket: string;
  canEdit: boolean;
  mode: BoardSessionMode;
  /** This person's colour in the room (cursor, selection, avatar). */
  color: string;
}

export interface BoardSnapshotResponse<Snapshot = BoardSnapshotLike> {
  revision: number;
  snapshot: Snapshot;
}

/** `POST /api/boards/convert`: an old WeldFlow whiteboard becomes a board, in place (same id). */
export const convertBoardSchema = z.object({ whiteboardId: z.string().min(1).max(255) });
export type ConvertBoardInput = z.infer<typeof convertBoardSchema>;

/** `POST /api/boards/import`: a new board from a file's content. */
export const importBoardSchema = z.object({
  name: boardName,
  format: z.enum(['excalidraw', 'csv', 'text', 'weldboard']),
  /** The file's text (JSON for excalidraw and weldboard). */
  content: z.string().min(1).max(BOARD_SNAPSHOT_MAX_BYTES),
  folderId: z.string().nullish(),
  projectId: z.string().min(1).max(255).optional(),
});
export type ImportBoardInput = z.infer<typeof importBoardSchema>;

/** `POST /api/boards/unfurl`: what a link card shows. */
export const unfurlSchema = z.object({ url: z.string().url().max(2048) });
export type UnfurlInput = z.infer<typeof unfurlSchema>;
export interface UnfurlResult {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

// ---------------------------------------------------------------- versions

const versionName = z.string().trim().min(1).max(255);

export const createBoardVersionSchema = z.object({ name: versionName });
export type CreateBoardVersionInput = z.infer<typeof createBoardVersionSchema>;

export const updateBoardVersionSchema = z.object({ name: versionName });
export type UpdateBoardVersionInput = z.infer<typeof updateBoardVersionSchema>;

export const listBoardVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(255).optional(),
});
export type ListBoardVersionsQuery = z.input<typeof listBoardVersionsQuerySchema>;

export interface BoardVersion {
  id: string;
  boardId: string;
  revision: number;
  /** Null for an automatic version (the board as it was before a restore). */
  name: string | null;
  size: number;
  createdAt: string;
  createdById: string | null;
}

export interface BoardRestoreResult {
  revision: number;
  autoVersion: BoardVersion;
}

/** `GET /api/boards/:id/render`: the live board as SVG. */
export interface BoardRender {
  revision: number;
  svg: string;
  /** Elements on the board, and how many the SVG draws (the first ones in paint order). */
  elements: number;
  drawn: number;
}

// ---------------------------------------------------------------- AI

export const BOARD_AI_ACTIONS = ['mindmap', 'diagram', 'stickies', 'cluster', 'summarize', 'ideas'] as const;
export type BoardAiAction = (typeof BOARD_AI_ACTIONS)[number];

/** `POST /api/boards/:id/ai`. Generated content is applied as ops through the room, so everyone sees it arrive. */
export const boardAiSchema = z.object({
  action: z.enum(BOARD_AI_ACTIONS),
  /** What to generate (mindmap, diagram, stickies). */
  prompt: z.string().trim().max(4000).optional(),
  /** Elements the action works on (cluster, summarize, ideas). */
  elementIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  /** Where new content goes, board units. */
  at: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  locale: z.enum(['en', 'nl', 'es', 'fr']).optional(),
});
export type BoardAiInput = z.infer<typeof boardAiSchema>;

export interface BoardAiResult {
  /** Ids of the elements the action created or moved. */
  elementIds: string[];
  /**
   * The summary, as Markdown (summarize). Nothing is written for it: the
   * platform saves it as a WeldDocs document with the person's own access.
   */
  text?: string;
  /** A title for the summary's document. */
  title?: string;
}

// ---------------------------------------------------------------- specs

/**
 * Colours, shapes and item types a board spec may use (board-engine
 * `SPEC_COLORS`, `SHAPE_KINDS`, `SPEC_ITEM_TYPES`; the engine clamps again).
 */
export const BOARD_SPEC_COLORS = ['yellow', 'orange', 'red', 'pink', 'violet', 'blue', 'cyan', 'teal', 'green', 'lime', 'grey', 'white'] as const;
export const BOARD_SPEC_SHAPES = [
  'rectangle', 'rounded', 'ellipse', 'triangle', 'diamond', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon', 'octagon',
  'star', 'cross', 'cylinder', 'cloud', 'callout', 'arrow-right', 'arrow-left', 'chevron', 'document', 'predefined', 'data',
  'terminator', 'delay', 'manual-input',
] as const;
export const BOARD_SPEC_ITEM_TYPES = ['sticky', 'shape', 'text', 'card'] as const;

const specKey = z.string().trim().min(1).max(100);
const specColor = z.enum(BOARD_SPEC_COLORS);

const boardSpecItem = z.object({
  key: specKey.optional().describe('A name for this item, unique in the spec, for lines to refer to'),
  type: z.enum(BOARD_SPEC_ITEM_TYPES),
  text: z.string().max(2000),
  shape: z.enum(BOARD_SPEC_SHAPES).optional().describe('For a shape: its kind (default rounded)'),
  color: specColor.optional(),
  description: z.string().max(5000).optional().describe('For a card: the text under its title'),
  frame: specKey.optional().describe('The key of the frame this item goes in'),
});

interface SpecMindNodeInput {
  text: string;
  children?: SpecMindNodeInput[];
}
const mindNode: z.ZodType<SpecMindNodeInput> = z.lazy(() =>
  z.object({ text: z.string().max(300), children: z.array(mindNode).max(40).optional() }),
);

/**
 * Things to put on a board, laid out by the engine (`placeSpec`): sticky
 * notes, shapes, text and cards, frames holding them, lines between them, or
 * a mind map. For the agent tools and the public API, which do not draw.
 */
export const boardSpecSchema = z.object({
  layout: z.enum(['grid', 'flow']).optional().describe('grid: rows of items; flow: layers following the lines, a flowchart. Default flow when there are lines'),
  direction: z.enum(['down', 'right']).optional().describe('Which way a flow runs (default down)'),
  items: z.array(boardSpecItem).max(500).optional(),
  frames: z.array(z.object({ key: specKey, title: z.string().max(200) })).max(50).optional().describe('Frames side by side, each holding the items that name it'),
  lines: z.array(z.object({ from: specKey, to: specKey, label: z.string().max(200).optional() })).max(1000).optional().describe('Arrows between items, by key'),
  mindmap: mindNode.optional().describe('A mind map: the central topic and its branches'),
});
export type BoardSpecInput = z.infer<typeof boardSpecSchema>;

// The mind map spelled out three levels deep instead of recursive: what tool
// definitions (WeldAgent, MCP) take, so their JSON schema has no $ref for a
// model to follow. Anything it accepts, boardSpecSchema accepts too.
const mindLeaf = z.object({ text: z.string().max(300) });
const mindTwig = z.object({ text: z.string().max(300), children: z.array(mindLeaf).max(12).optional() });
const mindBranch = z.object({ text: z.string().max(300), children: z.array(mindTwig).max(12).optional() });

/** {@link boardSpecSchema} for tool definitions: a mind map at most four levels deep. */
export const boardSpecToolSchema = boardSpecSchema.extend({
  mindmap: z
    .object({ text: z.string().max(300), children: z.array(mindBranch).max(16).optional() })
    .optional()
    .describe('A mind map: the central topic and its branches'),
});

/** Add a spec to a board (internal and public API). */
export const addToBoardSchema = z.object({
  spec: boardSpecSchema,
  at: z.object({ x: z.number().finite(), y: z.number().finite() }).optional().describe('Where the middle of the new content goes; default right of what is on the board'),
});
export type AddToBoardInput = z.infer<typeof addToBoardSchema>;

export interface AddToBoardResult {
  revision: number;
  /** The new top-level elements. */
  elementIds: string[];
  /** The element id each keyed item got. */
  keys: Record<string, string>;
  url: string;
}

/** Change or remove elements already on a board, by id (internal and public API). */
export const editBoardElementsSchema = z.object({
  changes: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        text: z.string().max(2000).optional().describe('New text (replaces the old)'),
        color: specColor.optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        delete: z.boolean().optional().describe('Remove the element (and what is inside it)'),
      }),
    )
    .min(1)
    .max(500),
});
export type EditBoardElementsInput = z.infer<typeof editBoardElementsSchema>;

export interface EditBoardElementsResult {
  revision: number;
  /** Ids that were changed or removed. */
  changed: string[];
  /** Ids that are not on the board (or cannot be changed), left alone. */
  skipped: string[];
  url: string;
}

// ---------------------------------------------------------------- records

/** WeldSuite records a board can hold as cards (board-engine `RecordKind`). */
export const BOARD_RECORD_KINDS = ['task', 'project', 'company', 'person', 'opportunity', 'ticket'] as const;
export type BoardRecordKind = (typeof BOARD_RECORD_KINDS)[number];

/** `POST /api/boards/records`: what the cards on a board show, as far as the caller may see each record. */
export const resolveBoardRecordsSchema = z.object({
  refs: z.array(z.object({ kind: z.enum(BOARD_RECORD_KINDS), id: z.string().min(1).max(255) })).min(1).max(500),
});
export type ResolveBoardRecordsInput = z.infer<typeof resolveBoardRecordsSchema>;

export interface BoardRecordView {
  title: string;
  subtitle: string | null;
  status: string | null;
}

export interface ResolveBoardRecordsResult {
  /** By `kind:id`; null for a record the caller may not see, or that is gone. */
  views: Record<string, BoardRecordView | null>;
}

// ---------------------------------------------------------------- tasks

/** `POST /api/boards/:id/tasks`: turn stickies into WeldFlow tasks (they become task cards in place). */
export const boardTasksSchema = z.object({
  elementIds: z.array(z.string().min(1).max(64)).min(1).max(200),
  projectId: z.string().min(1).max(255),
});
export type BoardTasksInput = z.infer<typeof boardTasksSchema>;
export interface BoardTasksResult {
  created: { elementId: string; taskId: string }[];
}
