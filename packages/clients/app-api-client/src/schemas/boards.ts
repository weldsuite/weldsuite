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
  /** Text an action answered with (summarize). */
  text?: string;
  /** A WeldDocs document the summary was saved to. */
  docId?: string;
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
