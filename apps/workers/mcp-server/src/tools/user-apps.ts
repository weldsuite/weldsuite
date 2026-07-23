import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApiKeySession } from '../lib/api-types';
import { toolResult, toolError } from './registry';

/**
 * Dynamic agent tools declared by user-created WeldApps.
 *
 * Each installed app's manifest may declare `agentTools`. external-api exposes
 * the resolved list for the calling key at `GET /v1/user-apps/agent-tools`;
 * this module loads that list (with a short in-isolate cache, since the MCP
 * server is rebuilt per request) and executes the declarative actions by
 * proxying to external-api's app-storage / generic API endpoints — always
 * forwarding the caller's `wsk_` key plus the `X-App-Code` header that
 * app-storage requires.
 */

const userAppToolActionSchema = z.object({
  type: z.enum([
    'storage.list',
    'storage.create',
    'storage.update',
    'storage.delete',
    'api.request',
  ]),
  collection: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
});

const userAppToolSchema = z.object({
  appCode: z.string().min(1),
  appName: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.unknown()).nullable().optional(),
  action: userAppToolActionSchema,
  grantedScopes: z.array(z.string()).optional(),
});

export type UserAppTool = z.infer<typeof userAppToolSchema>;

// ── In-isolate cache ────────────────────────────────────────────────────────
// The MCP server (and its tool list) is rebuilt on every request, but the set
// of user-app tools for a given key changes rarely. Cache per hashed key for a
// short TTL so bursts of MCP traffic don't refetch the manifest list each time.

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  tools: UserAppTool[];
}

const toolsCache = new Map<string, CacheEntry>();

async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function pruneExpired(now: number): void {
  for (const [key, entry] of toolsCache) {
    if (entry.expiresAt <= now) toolsCache.delete(key);
  }
}

/**
 * Load the user-app agent tools available to the calling API key.
 *
 * Fetches `GET /v1/user-apps/agent-tools` from external-api over the service
 * binding (same mechanism as house tool calls — see `lib/proxy.ts` for why the
 * binding is used instead of the public hostname). Failures are logged and
 * yield an empty list so dynamic tools never break static tool registration.
 */
export async function loadUserAppTools(
  apiKey: string,
  baseUrl: string,
  externalApi: Fetcher,
): Promise<UserAppTool[]> {
  const now = Date.now();
  pruneExpired(now);

  const cacheKey = await hashApiKey(apiKey);
  const cached = toolsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.tools;

  try {
    const url = new URL('/v1/user-apps/agent-tools', baseUrl);
    const res = await externalApi.fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.error(
        `[MCP UserApps] GET /v1/user-apps/agent-tools → ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
      return [];
    }

    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json.data)) {
      console.error('[MCP UserApps] Unexpected agent-tools response shape');
      return [];
    }

    const tools: UserAppTool[] = [];
    for (const entry of json.data) {
      const parsed = userAppToolSchema.safeParse(entry);
      if (parsed.success) {
        tools.push(parsed.data);
      } else {
        console.error('[MCP UserApps] Skipping malformed agent tool entry');
      }
    }

    toolsCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, tools });
    return tools;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    console.error(`[MCP UserApps] Failed to load user-app agent tools: ${message}`);
    return [];
  }
}

// ── Input schema conversion ─────────────────────────────────────────────────

/**
 * Convert a manifest tool's JSON Schema `parameters` object into a Zod raw
 * shape for MCP registration. Only the top level is converted — nested values
 * for `array`/`object` properties are accepted as-is. Unknown or missing types
 * fall back to `z.unknown()`; properties not listed in `required` are optional.
 */
export function userAppInputShape(
  parameters: Record<string, unknown> | null | undefined,
): z.ZodRawShape {
  const properties = parameters?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};

  const required = new Set(
    Array.isArray(parameters?.required)
      ? parameters.required.filter((r): r is string => typeof r === 'string')
      : [],
  );

  const shape: z.ZodRawShape = {};
  for (const [key, rawProp] of Object.entries(properties as Record<string, unknown>)) {
    const prop =
      rawProp && typeof rawProp === 'object' && !Array.isArray(rawProp)
        ? (rawProp as Record<string, unknown>)
        : {};

    let type: z.ZodTypeAny;
    switch (prop.type) {
      case 'string':
        type = z.string();
        break;
      case 'number':
        type = z.number();
        break;
      case 'integer':
        type = z.number().int();
        break;
      case 'boolean':
        type = z.boolean();
        break;
      case 'array':
        type = z.array(z.unknown());
        break;
      case 'object':
        type = z.record(z.unknown());
        break;
      default:
        type = z.unknown();
    }

    if (typeof prop.description === 'string' && prop.description) {
      type = type.describe(prop.description);
    }
    if (!required.has(key)) type = type.optional();

    shape[key] = type;
  }

  return shape;
}

// ── Execution ───────────────────────────────────────────────────────────────

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const API_REQUEST_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

interface ShapedRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

function requireRecordId(args: Record<string, unknown>): string | null {
  const id = args.id;
  if (typeof id !== 'string' || id === '') return null;
  return id;
}

function storageRecordsPath(collection: string, id?: string): string {
  const base = `/v1/app-storage/collections/${encodeURIComponent(collection)}/records`;
  return id === undefined ? base : `${base}/${encodeURIComponent(id)}`;
}

/**
 * Map a declarative user-app tool action + call arguments onto an external-api
 * HTTP request. Returns a string error message when the manifest action or the
 * arguments are invalid.
 */
function shapeRequest(tool: UserAppTool, args: Record<string, unknown>): ShapedRequest | string {
  const { action } = tool;

  switch (action.type) {
    case 'storage.list': {
      if (!action.collection) return 'Tool action is missing a storage collection';
      const query: Record<string, unknown> = {};
      if (args.limit !== undefined) query.limit = args.limit;
      if (args.filter !== undefined) {
        query.filter = typeof args.filter === 'string' ? args.filter : JSON.stringify(args.filter);
      }
      return { method: 'GET', path: storageRecordsPath(action.collection), query };
    }

    case 'storage.create': {
      if (!action.collection) return 'Tool action is missing a storage collection';
      return { method: 'POST', path: storageRecordsPath(action.collection), body: { data: args } };
    }

    case 'storage.update': {
      if (!action.collection) return 'Tool action is missing a storage collection';
      const id = requireRecordId(args);
      if (!id) return 'Missing required parameter: id';
      let data: unknown;
      if (args.data !== undefined && args.data !== null) {
        data = args.data;
      } else {
        const rest: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args)) {
          if (key === 'id' || value === undefined) continue;
          rest[key] = value;
        }
        data = rest;
      }
      return { method: 'PATCH', path: storageRecordsPath(action.collection, id), body: { data } };
    }

    case 'storage.delete': {
      if (!action.collection) return 'Tool action is missing a storage collection';
      const id = requireRecordId(args);
      if (!id) return 'Missing required parameter: id';
      return { method: 'DELETE', path: storageRecordsPath(action.collection, id) };
    }

    case 'api.request': {
      const method = action.method?.toUpperCase() as HttpMethod | undefined;
      if (!method || !API_REQUEST_METHODS.includes(method)) {
        return `Unsupported API request method: ${action.method ?? '(none)'}`;
      }
      const path = action.path ?? '';
      // Strict allowlist BEFORE any URL resolution: no '..', '//', '\', or
      // percent-encoding that could escape the /v1/ prefix after
      // normalization.
      if (!/^\/v1\/[A-Za-z0-9\-_./]+$/.test(path) || path.includes('..') || path.includes('//')) {
        return 'API request paths must be a plain /v1/... path';
      }
      // Enforce the app's consented install scopes, not the invoking key's
      // privileges. App-storage paths are the app's own data plane and are
      // scoped by X-App-Code server-side; everything else needs a granted
      // `resource:action` scope.
      if (!path.startsWith('/v1/app-storage/')) {
        const resource = path.split('/')[2] ?? '';
        const requiredScope = `${resource}:${SCOPE_ACTION_BY_METHOD[method]}`;
        if (!appScopesAllow(tool.grantedScopes ?? [], requiredScope)) {
          return `The app's granted scopes do not allow ${requiredScope}`;
        }
      }
      if (method === 'GET' || method === 'DELETE') {
        return { method, path, query: args };
      }
      return { method, path, body: args };
    }
  }
}

const SCOPE_ACTION_BY_METHOD: Record<HttpMethod, string> = {
  GET: 'read',
  POST: 'create',
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};

/**
 * Strict scope matcher for an app install's consented scopes. Unlike the
 * API-key `hasScope` helper, an EMPTY list grants nothing — apps only get
 * what the workspace admin explicitly consented to.
 */
function appScopesAllow(granted: string[], required: string): boolean {
  if (granted.includes('*') || granted.includes(required)) return true;
  const parts = required.split(':');
  for (let i = parts.length - 1; i > 0; i--) {
    if (granted.includes(`${parts.slice(0, i).join(':')}:*`)) return true;
  }
  return false;
}

/**
 * Execute a user-app tool by proxying its declarative action to external-api.
 *
 * Mirrors `lib/proxy.ts` request/response shaping, but additionally forwards
 * the `X-App-Code` header required by external-api's app-storage routes so the
 * call is attributed (and scoped) to the owning WeldApp.
 */
export async function executeUserAppTool(
  tool: UserAppTool,
  args: Record<string, unknown>,
  session: ApiKeySession,
  baseUrl: string,
  externalApi: Fetcher,
): Promise<CallToolResult> {
  const shaped = shapeRequest(tool, args);
  if (typeof shaped === 'string') return toolError(shaped);

  const url = new URL(shaped.path, baseUrl);
  for (const [key, value] of Object.entries(shaped.query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const body = shaped.body === undefined ? undefined : JSON.stringify(shaped.body);

  let res: Response;
  try {
    res = await externalApi.fetch(url.toString(), {
      method: shaped.method,
      headers: {
        Authorization: `Bearer ${session.apiKey}`,
        Accept: 'application/json',
        'X-App-Code': tool.appCode,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    console.error(
      `[MCP UserApps] ${shaped.method} ${url.pathname} failed to reach External API: ${message}`,
    );
    return toolError(`Failed to reach the WeldSuite API: ${message}`);
  }

  if (res.status === 204) {
    return toolResult({ data: { success: true } });
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    console.error(
      `[MCP UserApps] ${shaped.method} ${url.pathname} → non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
    );
    return toolError(`Unexpected non-JSON response (${res.status}) from the WeldSuite API`);
  }

  if (!res.ok) {
    const errObj = (json as { error?: { code?: string; message?: string } }).error;
    const message = errObj?.message ?? `Request failed with status ${res.status}`;
    console.error(
      `[MCP UserApps] ${shaped.method} ${url.pathname} → ${res.status}: ${JSON.stringify(json).slice(0, 200)}`,
    );
    return toolError(errObj?.code ? `${errObj.code}: ${message}` : message);
  }

  return toolResult(json);
}
