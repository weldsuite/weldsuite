import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpSession } from './api-types';
import type { Env } from '../types/env';
import type { ToolDefinition } from '../tools/registry';
import { toolResult, toolError } from '../tools/registry';
import { INTERNAL_ORIGIN, apiApp, internalEnv } from '../api/app';
import { labelFor } from './present';

/**
 * How many candidates to fetch when resolving a name, and how many to offer
 * back when the name is ambiguous.
 */
const NAME_RESOLUTION_LIMIT = 5;

/**
 * Look up a record by name within a collection.
 *
 * Only ever called after a request has already come back 404, so it costs
 * nothing on the normal path and cannot change the meaning of a call that
 * already worked. Collections without a `search` query parameter (16 of 49)
 * simply fail here, and the caller keeps the original 404.
 *
 * Returns the resolved id, or the candidate labels when the name matches
 * several records — guessing between them would be worse than asking.
 */
async function resolveIdByName(
  collectionPath: string,
  name: string,
  session: McpSession,
  env: Env,
  executionCtx: ExecutionContext,
): Promise<{ id: string } | { ambiguous: string[] } | null> {
  const url = new URL(collectionPath, INTERNAL_ORIGIN);
  url.searchParams.set('search', name);
  url.searchParams.set('limit', String(NAME_RESOLUTION_LIMIT));

  let res: Response;
  try {
    res = await apiApp.fetch(
      new Request(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } }),
      internalEnv(env, session),
      executionCtx,
    );
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let rows: Array<Record<string, unknown>>;
  try {
    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json.data)) return null;
    rows = json.data.filter(
      (row): row is Record<string, unknown> => row !== null && typeof row === 'object',
    );
  } catch {
    return null;
  }

  if (rows.length === 0) return null;

  // Prefer an exact, case-insensitive label match — searching for "Acme" should
  // land on "Acme" rather than being blocked by "Acme Industries".
  const wanted = name.trim().toLowerCase();
  const exact = rows.filter((row) => labelFor(row)?.trim().toLowerCase() === wanted);
  const shortlist = exact.length > 0 ? exact : rows;

  if (shortlist.length === 1) {
    const id = shortlist[0]?.id;
    return typeof id === 'string' ? { id } : null;
  }

  return {
    ambiguous: shortlist
      .map((row) => labelFor(row))
      .filter((label): label is string => label !== null),
  };
}

/** Fill a tool's path params from its input fields, tracking which inputs the path consumed. */
function fillPathParams(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): { path: string; consumed: Set<string> } | { missing: string } {
  let path = tool.path;
  const consumed = new Set<string>();
  for (const [placeholder, field] of Object.entries(tool.pathParams ?? {})) {
    const value = args[field];
    if (value === undefined || value === null || value === '') {
      return { missing: field };
    }
    path = path.replace(`:${placeholder}`, encodeURIComponent(String(value)));
    consumed.add(field);
  }
  return { path, consumed };
}

/** Put the remaining inputs on the query string (GET/DELETE) or in the JSON body (POST/PATCH). */
function buildRequestTarget(
  tool: ToolDefinition,
  path: string,
  rest: Record<string, unknown>,
): { url: URL; body: string | undefined } {
  const url = new URL(path, INTERNAL_ORIGIN);
  if (tool.method !== 'GET' && tool.method !== 'DELETE') {
    return { url, body: JSON.stringify(rest) };
  }
  for (const [key, value] of Object.entries(rest)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return { url, body: undefined };
}

/**
 * The caller may have passed a name where an id was expected — an assistant
 * that has just been told not to surface ids will naturally do this. Resolve
 * it and retry, but only after a 404, so a working call is never re-sent and
 * the failed attempt had no side effect.
 *
 * Returns the retried response, a tool error when the name is ambiguous, or
 * null when nothing could be resolved (the caller keeps the original 404).
 */
async function retryWithResolvedName(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  placeholder: string,
  field: string,
  url: URL,
  send: (target: URL) => Promise<Response>,
  session: McpSession,
  env: Env,
  executionCtx: ExecutionContext,
): Promise<Response | CallToolResult | null> {
  const supplied = String(args[field]);
  const collectionPath = tool.path.split('/:')[0];
  if (!collectionPath || collectionPath === tool.path) return null;

  const resolved = await resolveIdByName(collectionPath, supplied, session, env, executionCtx);
  if (!resolved) return null;

  if ('ambiguous' in resolved) {
    return toolError(
      `"${supplied}" matches several records: ${resolved.ambiguous.join('; ')}. ` +
        'Ask which one is meant, then retry with a more specific name.',
    );
  }

  const retryUrl = new URL(
    tool.path.replace(`:${placeholder}`, encodeURIComponent(resolved.id)),
    INTERNAL_ORIGIN,
  );
  retryUrl.search = url.search;
  return send(retryUrl);
}

/** Turn an API response into a tool result (v1 contract, see `executeTool`). */
async function shapeResponse(
  tool: ToolDefinition,
  url: URL,
  res: Response,
): Promise<CallToolResult> {
  if (res.status === 204) {
    return toolResult({ data: { success: true } });
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    console.error(
      `[MCP Tool] ${tool.method} ${url.pathname} → non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
    );
    return toolError(`Unexpected non-JSON response (${res.status})`);
  }

  if (!res.ok) {
    const errObj = (json as { error?: { code?: string; message?: string } }).error;
    const message = errObj?.message ?? `Request failed with status ${res.status}`;
    console.error(
      `[MCP Tool] ${tool.method} ${url.pathname} → ${res.status}: ${JSON.stringify(json).slice(0, 200)}`,
    );
    return toolError(errObj?.code ? `${errObj.code}: ${message}` : message);
  }

  return toolResult(json);
}

/**
 * Execute a tool against the MCP server's own v1 resource API.
 *
 * Tools are declarative — each carries an HTTP method + path template instead
 * of a DB handler. The request is dispatched **in-process** into `apiApp`
 * (`src/api/`), which is this worker's copy of the resource routes. There is no
 * network hop and no dependency on another worker: the MCP server owns its data
 * plane end to end.
 *
 * Routing a tool call through an HTTP-shaped dispatch rather than calling a
 * handler directly is deliberate — it keeps the ported routes byte-identical to
 * their origin in external-api, so they can still be diffed and re-synced.
 *
 * Request shaping by method:
 *   - path `:params` are filled from the named input fields (`pathParams`)
 *   - GET/DELETE  → remaining inputs become query-string params
 *   - POST/PATCH  → remaining inputs become the JSON body
 *
 * Response shaping (v1 contract):
 *   - 204 No Content        → `{ data: { success: true } }`
 *   - 2xx `{ data, ... }`   → forwarded verbatim
 *   - non-2xx `{ error }`   → tool error with the API's message
 */
export async function executeTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  session: McpSession,
  env: Env,
  executionCtx: ExecutionContext,
): Promise<CallToolResult> {
  const filled = fillPathParams(tool, args);
  if ('missing' in filled) {
    return toolError(`Missing required parameter: ${filled.missing}`);
  }
  const { path, consumed } = filled;

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key) || value === undefined) continue;
    rest[key] = value;
  }

  const { url, body } = buildRequestTarget(tool, path, rest);

  const send = async (target: URL): Promise<Response> =>
    apiApp.fetch(
      new Request(target.toString(), {
        method: tool.method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
      }),
      internalEnv(env, session),
      executionCtx,
    );

  const pathParamEntries = Object.entries(tool.pathParams ?? {});
  let res: Response;
  try {
    res = await send(url);

    if (res.status === 404 && pathParamEntries.length === 1) {
      const [[placeholder, field]] = pathParamEntries as [[string, string]];
      const retried = await retryWithResolvedName(
        tool,
        args,
        placeholder,
        field,
        url,
        send,
        session,
        env,
        executionCtx,
      );
      if (retried instanceof Response) res = retried;
      else if (retried) return retried;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error(`[MCP Tool] ${tool.method} ${url.pathname} failed: ${message}`);
    return toolError(`Failed to execute the request: ${message}`);
  }

  return shapeResponse(tool, url, res);
}
