import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpSession } from '../lib/api-types';
import type { Env } from '../types/env';
import { INTERNAL_ORIGIN, apiApp, internalEnv } from '../api/app';
import { toolResult, toolError } from './registry';

/**
 * Dynamic agent tools for WeldObjects — user-defined custom objects.
 *
 * Structurally identical to `tools/user-apps.ts`, and deliberately so: both
 * expose runtime-defined capabilities that cannot be in the static registry,
 * both discover them through a `/v1/.../agent-tools` endpoint, and both execute
 * by dispatching in-process against the server's own v1 API so the canonical
 * auth / validation / entity-event path runs exactly once.
 *
 * Each object opted into agent tooling yields five tools:
 *
 *   list_<slug>    search + page records
 *   get_<slug>     one record by id
 *   create_<slug>  create, with a per-object input schema
 *   update_<slug>  patch fields
 *   delete_<slug>  delete
 *
 * The input schemas are synthesised from the object's own field definitions, so
 * an LLM sees `serial_number (string, required)` rather than an opaque blob.
 */

// ── Wire shapes ─────────────────────────────────────────────────────────────

const toolFieldSchema = z.object({
  slug: z.string(),
  name: z.string(),
  fieldType: z.string(),
  required: z.boolean(),
  description: z.string().nullable(),
  options: z.array(z.string()).nullable(),
});

const toolObjectSchema = z.object({
  slug: z.string().min(1),
  entityKey: z.string().min(1),
  labelSingular: z.string().min(1),
  labelPlural: z.string().min(1),
  description: z.string().nullable(),
  fields: z.array(toolFieldSchema),
});

export type CustomObjectToolDescriptor = z.infer<typeof toolObjectSchema>;

// ── In-isolate cache ────────────────────────────────────────────────────────
// The MCP server is rebuilt per request, but a workspace's object definitions
// change rarely. Same TTL and rationale as the user-app tool cache.

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  objects: CustomObjectToolDescriptor[];
}

const objectsCache = new Map<string, CacheEntry>();

function cacheKeyFor(session: McpSession): string {
  return `${session.workspaceId}:${session.userId}`;
}

function pruneExpired(now: number): void {
  for (const [key, entry] of objectsCache) {
    if (entry.expiresAt <= now) objectsCache.delete(key);
  }
}

/**
 * Load the custom objects exposed as agent tools for this caller.
 *
 * Failures are logged and yield an empty list — a misconfigured object must
 * never prevent the static tools from registering.
 */
export async function loadCustomObjectTools(
  session: McpSession,
  env: Env,
  executionCtx: ExecutionContext,
): Promise<CustomObjectToolDescriptor[]> {
  const now = Date.now();
  pruneExpired(now);

  const cacheKey = cacheKeyFor(session);
  const cached = objectsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.objects;

  try {
    const url = new URL('/v1/custom-objects/agent-tools', INTERNAL_ORIGIN);
    const res = await apiApp.fetch(
      new Request(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } }),
      internalEnv(env, session),
      executionCtx,
    );

    if (!res.ok) {
      console.error(
        `[MCP CustomObjects] GET /v1/custom-objects/agent-tools → ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
      return [];
    }

    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json.data)) {
      console.error('[MCP CustomObjects] Unexpected agent-tools response shape');
      return [];
    }

    const objects: CustomObjectToolDescriptor[] = [];
    for (const entry of json.data) {
      const parsed = toolObjectSchema.safeParse(entry);
      if (parsed.success) {
        objects.push(parsed.data);
      } else {
        console.error('[MCP CustomObjects] Skipping malformed object descriptor');
      }
    }

    objectsCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, objects });
    return objects;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    console.error(`[MCP CustomObjects] Failed to load custom object tools: ${message}`);
    return [];
  }
}

// ── Input schema synthesis ──────────────────────────────────────────────────

/** Map a WeldSuite field type onto the Zod type an LLM should supply. */
function zodForField(field: CustomObjectToolDescriptor['fields'][number]): z.ZodTypeAny {
  switch (field.fieldType) {
    case 'number':
    case 'currency':
    case 'rating':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.string().describe('ISO 8601 date');
    case 'multi_select':
      return field.options && field.options.length > 0
        ? z.array(z.enum(field.options as [string, ...string[]]))
        : z.array(z.string());
    case 'single_select':
      return field.options && field.options.length > 0
        ? z.enum(field.options as [string, ...string[]])
        : z.string();
    default:
      return z.string();
  }
}

/**
 * Field inputs for one object.
 *
 * `forCreate` controls whether required fields are actually required: a create
 * must supply them, an update patches only what it names. Marking them required
 * on update would force the model to re-send unchanged values, which is both
 * wasteful and a good way to clobber a field with a stale guess.
 */
function fieldShape(
  object: CustomObjectToolDescriptor,
  forCreate: boolean,
): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const field of object.fields) {
    let schema = zodForField(field);
    const description = field.description
      ? `${field.name} — ${field.description}`
      : field.name;
    schema = schema.describe(description);
    shape[field.slug] = forCreate && field.required ? schema : schema.optional();
  }
  return shape;
}

export interface CustomObjectTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  object: CustomObjectToolDescriptor;
  operation: 'list' | 'get' | 'create' | 'update' | 'delete';
}

/** The five tools one object contributes. */
export function buildCustomObjectTools(
  object: CustomObjectToolDescriptor,
): CustomObjectTool[] {
  const singular = object.labelSingular.toLowerCase();
  const plural = object.labelPlural.toLowerCase();
  const context = object.description ? ` ${object.description}` : '';

  return [
    {
      name: `list_${object.slug}`,
      description: `Search and list ${plural}.${context}`,
      inputSchema: {
        search: z.string().optional().describe(`Filter ${plural} by name`),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional().describe('Pagination cursor from a previous call'),
      },
      object,
      operation: 'list',
    },
    {
      name: `get_${object.slug}`,
      description: `Get one ${singular} by id.${context}`,
      inputSchema: { id: z.string().describe(`The ${singular} id`) },
      object,
      operation: 'get',
    },
    {
      name: `create_${object.slug}`,
      description: `Create a ${singular}.${context}`,
      inputSchema: fieldShape(object, true),
      object,
      operation: 'create',
    },
    {
      name: `update_${object.slug}`,
      description: `Update a ${singular}. Only the fields you supply are changed.${context}`,
      inputSchema: {
        id: z.string().describe(`The ${singular} id`),
        ...fieldShape(object, false),
      },
      object,
      operation: 'update',
    },
    {
      name: `delete_${object.slug}`,
      description: `Delete a ${singular}.${context}`,
      inputSchema: { id: z.string().describe(`The ${singular} id`) },
      object,
      operation: 'delete',
    },
  ];
}

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * Execute a custom object tool by dispatching against the server's own v1 API.
 *
 * Going through HTTP rather than straight to the database is the point: the
 * external-api route owns scope checks, per-field validation, title
 * maintenance and entity-event publishing, and a second code path here would
 * inevitably drift from it.
 */
export async function executeCustomObjectTool(
  tool: CustomObjectTool,
  args: Record<string, unknown>,
  session: McpSession,
  env: Env,
  executionCtx: ExecutionContext,
): Promise<CallToolResult> {
  const base = `/v1/custom-objects/${tool.object.slug}`;

  let path = `${base}/records`;
  let method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET';
  let body: Record<string, unknown> | undefined;
  const query = new URLSearchParams();

  switch (tool.operation) {
    case 'list': {
      if (typeof args.search === 'string') query.set('search', args.search);
      if (typeof args.limit === 'number') query.set('limit', String(args.limit));
      if (typeof args.cursor === 'string') query.set('cursor', args.cursor);
      break;
    }
    case 'get': {
      if (typeof args.id !== 'string') return toolError('An id is required');
      path = `${base}/records/${encodeURIComponent(args.id)}`;
      break;
    }
    case 'create': {
      method = 'POST';
      body = { fields: args };
      break;
    }
    case 'update': {
      const { id, ...fields } = args;
      if (typeof id !== 'string') return toolError('An id is required');
      method = 'PATCH';
      path = `${base}/records/${encodeURIComponent(id)}`;
      body = { fields };
      break;
    }
    case 'delete': {
      if (typeof args.id !== 'string') return toolError('An id is required');
      method = 'DELETE';
      path = `${base}/records/${encodeURIComponent(args.id)}`;
      break;
    }
  }

  const url = new URL(path, INTERNAL_ORIGIN);
  for (const [key, value] of query) url.searchParams.set(key, value);

  try {
    const res = await apiApp.fetch(
      new Request(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      internalEnv(env, session),
      executionCtx,
    );

    if (res.status === 204) {
      return toolResult({ deleted: true });
    }

    const json = (await res.json()) as { data?: unknown; error?: { message?: string } };
    if (!res.ok) {
      return toolError(json.error?.message ?? `Request failed with status ${res.status}`);
    }
    return toolResult(json.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return toolError(`Failed to ${tool.operation} ${tool.object.labelSingular}: ${message}`);
  }
}
