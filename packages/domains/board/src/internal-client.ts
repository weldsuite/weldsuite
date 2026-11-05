/**
 * A client for board-api's `BoardsInternal` entrypoint (a service binding
 * with entrypoint = "BoardsInternal"), for the workers that read or write
 * WeldBoard boards for someone: external-api's and the MCP server's
 * deprecated `/v1/whiteboards` (WeldFlow's old elements format), and the
 * WeldAgent board tools. See apps/workers/board-api/src/routes/internal/boards.ts.
 *
 * Every call acts for someone: a person (their WeldDrive access, project
 * membership and `boards:*` permissions apply), or a workspace API key
 * (project boards only, its scopes already checked by the caller).
 *
 * Calls return the `Response` as board-api sent it (the usual `{ data }` or
 * `{ error }` envelope), so a caller can pass a refusal straight through.
 */

export type BoardActor =
  /** A person: Clerk user id. */
  | { userId: string }
  /** A workspace API key (no person): its id, for the trail. */
  | { workspaceKey: string };

export interface BoardsInternalOptions {
  /** The BOARDS_INTERNAL service binding. */
  fetcher: Pick<Fetcher, 'fetch'>;
  /** The workspace (`workspaces.id`) or its Clerk org id; either resolves. */
  workspace: string;
  actor: BoardActor;
}

/** A board in the shape WeldFlow's whiteboard API always returned (a `project_whiteboards` row). */
export interface LegacyWhiteboardRow {
  id: string;
  projectId: string | null;
  name: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  version: number;
  lastEditedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
}

export interface BoardBrief {
  id: string;
  name: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  updatedById: string | null;
  revision: number;
  role: 'owner' | 'editor' | 'viewer';
  /** An old WeldFlow whiteboard not opened since WeldBoard (still in `project_whiteboards`). */
  legacy: boolean;
  /** Its address in the platform. */
  url: string;
}

export interface FindBoardsInput {
  query?: string;
  projectId?: string;
  /** Every project board the actor may open. */
  projects?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateBoardInput {
  name?: string;
  projectId?: string;
  /** Start from WeldFlow-format elements. */
  elements?: unknown[];
  /** Start from a board-engine snapshot. */
  snapshot?: unknown;
}

export type ReadFormat = 'summary' | 'legacy' | 'outline' | 'text' | 'snapshot';

export function boardsInternal(options: BoardsInternalOptions) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if ('userId' in options.actor) headers['x-weld-user'] = options.actor.userId;
  else headers['x-weld-workspace-key'] = options.actor.workspaceKey;
  const base = `https://board-api/internal/boards/${encodeURIComponent(options.workspace)}`;
  const call = (path: string, body: unknown = {}) =>
    options.fetcher.fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const one = (id: string, action: string, body?: unknown) => call(`/${encodeURIComponent(id)}/${action}`, body);

  return {
    /** `{ data: { boards: BoardBrief[], total, hasMore } }` */
    find: (input: FindBoardsInput) => call('/find', input),
    /** `{ data: BoardBrief & { row?: LegacyWhiteboardRow } }` (the row when created from elements) */
    create: (input: CreateBoardInput) => call('/create', input),
    /** `{ data: BoardBrief & { row | elements | text | snapshot } }`, as `format` says */
    read: (id: string, format: ReadFormat = 'summary', limit?: number) => one(id, 'read', { format, ...(limit ? { limit } : {}) }),
    /** Rename and/or make the board match WeldFlow-format elements: `{ data: BoardBrief & { row } }` */
    update: (id: string, input: { name?: string; elements?: unknown[] }) => one(id, 'update', input),
    /** Commit a board-engine op: `{ data: { revision, url } }` */
    apply: (id: string, op: unknown) => one(id, 'apply', { op }),
    /** Move to the trash: 204 */
    remove: (id: string) => one(id, 'delete'),
  };
}

export type BoardsInternalClient = ReturnType<typeof boardsInternal>;
