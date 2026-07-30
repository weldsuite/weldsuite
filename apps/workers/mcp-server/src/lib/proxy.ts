import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpSession } from './api-types';
import type { Env } from '../types/env';
import type { ToolDefinition } from '../tools/registry';
import { toolResult, toolError } from '../tools/registry';
import { INTERNAL_ORIGIN, apiApp, internalEnv } from '../api/app';

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
  // Fill path params and track which inputs were consumed by the path.
  let path = tool.path;
  const consumed = new Set<string>();
  for (const [placeholder, field] of Object.entries(tool.pathParams ?? {})) {
    const value = args[field];
    if (value === undefined || value === null || value === '') {
      return toolError(`Missing required parameter: ${field}`);
    }
    path = path.replace(`:${placeholder}`, encodeURIComponent(String(value)));
    consumed.add(field);
  }

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key) || value === undefined) continue;
    rest[key] = value;
  }

  const url = new URL(path, INTERNAL_ORIGIN);
  let body: string | undefined;

  if (tool.method === 'GET' || tool.method === 'DELETE') {
    for (const [key, value] of Object.entries(rest)) {
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  } else {
    body = JSON.stringify(rest);
  }

  let res: Response;
  try {
    const request = new Request(url.toString(), {
      method: tool.method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });

    res = await apiApp.fetch(request, internalEnv(env, session), executionCtx);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error(`[MCP Tool] ${tool.method} ${url.pathname} failed: ${message}`);
    return toolError(`Failed to execute the request: ${message}`);
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
