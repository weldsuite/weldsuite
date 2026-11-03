import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP tool annotations (TASK-1347): the hints clients and the Claude connector
 * directory use to decide which calls need a confirmation.
 *
 * Every tool here is a call into the v1 API, so the HTTP method says what the
 * call does, more reliably than the tool's name:
 *
 * - GET reads (`readOnlyHint`).
 * - POST creates or starts something; repeating it does it again.
 * - PATCH / PUT change fields of a record; repeating it changes nothing more.
 * - DELETE removes a record (`destructiveHint`).
 *
 * The spec defaults `destructiveHint` to true for a tool that isn't read-only,
 * so it is always set explicitly. `openWorldHint` is false: the tools work on
 * the workspace's own records. A tool whose effect leaves the workspace (it
 * mails a customer, publishes a post) sets it in its own `annotations`.
 */
export type ToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const METHOD_HINTS: Record<ToolMethod, Omit<ToolAnnotations, 'title'>> = {
  GET: { readOnlyHint: true, openWorldHint: false },
  POST: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  PATCH: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  PUT: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  DELETE: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

/** `search_tasks` → "Search tasks". */
export function toolTitle(name: string): string {
  const words = name.split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The annotations for a tool that calls `method`, with `overrides` (a tool's own
 * `annotations`) on top. A method the tool cannot know up front (a WeldApp's
 * `api.request` with an unrecognised method) is treated as a write that may
 * destroy data, which is the spec's own default.
 */
export function annotationsFor(
  method: string | undefined,
  title: string,
  overrides?: Partial<ToolAnnotations>,
): ToolAnnotations {
  const hints =
    METHOD_HINTS[(method ?? '').toUpperCase() as ToolMethod] ??
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  return { title, ...hints, ...overrides };
}
