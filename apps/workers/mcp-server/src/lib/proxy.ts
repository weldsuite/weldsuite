import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApiKeySession } from './api-types';
import type { ToolDefinition } from '../tools/registry';
import { toolResult, toolError } from '../tools/registry';

/**
 * Execute a tool by proxying to the External API worker.
 *
 * Tools are declarative — each carries an HTTP method + path template instead
 * of a DB handler. This forwards the caller's `wsk_` key so external-api runs
 * the same auth, validation, business logic, and entity-event publishing that
 * back every other API surface, guaranteeing the MCP server never drifts from
 * the REST API it mirrors.
 *
 * The request is issued over the `EXTERNAL_API` service binding rather than
 * the public hostname (`api.weldsuite.org`). Both workers live in the same
 * `weldsuite.org` zone, and a Worker→Worker subrequest to a same-zone public
 * hostname dies at the Cloudflare edge with an HTTP 530 (the upstream worker
 * never even sees the request). The service binding routes worker-to-worker
 * internally, bypassing the edge entirely. `baseUrl` is still used to build the
 * absolute request URL — the binding ignores the host but the path/query are
 * forwarded to external-api unchanged.
 *
 * Request shaping by method:
 *   - path `:params` are filled from the named input fields (`pathParams`)
 *   - GET/DELETE  → remaining inputs become query-string params
 *   - POST/PATCH  → remaining inputs become the JSON body
 *
 * Response shaping (external-api contract):
 *   - 204 No Content        → `{ data: { success: true } }`
 *   - 2xx `{ data, ... }`   → forwarded verbatim
 *   - non-2xx `{ error }`   → tool error with the API's message
 */
export async function executeTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  session: ApiKeySession,
  baseUrl: string,
  externalApi: Fetcher,
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

  const url = new URL(path, baseUrl);
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
    res = await externalApi.fetch(url.toString(), {
      method: tool.method,
      headers: {
        Authorization: `Bearer ${session.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    console.error(
      `[MCP Proxy] ${tool.method} ${url.pathname} failed to reach External API: ${message}`,
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
      `[MCP Proxy] ${tool.method} ${url.pathname} → non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
    );
    return toolError(`Unexpected non-JSON response (${res.status}) from the WeldSuite API`);
  }

  if (!res.ok) {
    const errObj = (json as { error?: { code?: string; message?: string } }).error;
    const message = errObj?.message ?? `Request failed with status ${res.status}`;
    console.error(
      `[MCP Proxy] ${tool.method} ${url.pathname} → ${res.status}: ${JSON.stringify(json).slice(0, 200)}`,
    );
    return toolError(errObj?.code ? `${errObj.code}: ${message}` : message);
  }

  return toolResult(json);
}
