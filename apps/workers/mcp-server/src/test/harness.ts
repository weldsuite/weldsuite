/**
 * Test harness for the MCP endpoint (`POST /mcp`), and its conformance seam.
 *
 * `createMcpTestApp({ session, tenantDb })` mounts `/mcp` as `src/index.ts`
 * does, with the member's session in place of `authMiddleware` and
 * `rateLimitMiddleware` (which need Clerk, KV and Durable Objects), and the
 * internal `/v1` copy reading the test's tenant database (the test mocks
 * `createTenantDb` to return `currentTenantDb()`).
 *
 * With `CONFORMANCE_TARGET=rust` every request runs on both backends: the Rust
 * server's `/mcp` takes the session from the context (`mcpSession`), and the
 * JSON-RPC answers, the entity events and the database writes are compared.
 */

import { Hono } from 'hono';
import { matchedRoutes } from 'hono/route';
import {
  ROUTE_HEADER,
  conformanceRequest,
  conformanceTarget,
  createSideEffectRecorder,
  recordInventory,
  recordOnlyRequest,
  recordOnlyTarget,
} from '@weldsuite/worker-kit/testing/conformance';
import type { Database } from '@weldsuite/worker-kit/db';
import { createMcpServer } from '../lib/mcp-server';
import { serveMcpRequest } from '../lib/mcp-transport';
import type { McpSession } from '../lib/api-types';
import type { Env } from '../types/env';

/**
 * The tenant database the test's mocked `createTenantDb` hands out, per run:
 * `vi.mock('../api/db', …)` with `createTenantDb: () => currentTenantDb()`.
 */
export function currentTenantDb(): Database {
  return (globalThis as Record<string, unknown>).__mcpTestTenantDb as Database;
}

export const testSession = (overrides: Partial<McpSession> = {}): McpSession => ({
  tokenId: 'oat_test',
  userId: 'user_test',
  clerkOrgId: 'org_test',
  workspaceId: 'ws_test',
  workspaceName: 'Test workspace',
  tier: 'enterprise',
  databaseUrl: 'postgres://test:test@localhost:5432/test',
  permissions: ['*'],
  permissionDenies: [],
  role: 'OWNER',
  clientId: null,
  licensedApps: null,
  ...overrides,
});

export interface CreateMcpTestAppOptions {
  session?: McpSession;
  tenantDb: Database;
  masterDb?: Database;
  env?: Partial<Env>;
}

/** The headers an MCP client sends with a JSON-RPC message. */
export const MCP_HEADERS = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};

export function createMcpTestApp(options: CreateMcpTestAppOptions) {
  const session = options.session ?? testSession();
  const target = conformanceTarget();
  const recorder = target ? null : recordOnlyTarget();
  const sideEffects = target ? createSideEffectRecorder() : null;
  const env = { ENVIRONMENT: 'test', ...(sideEffects?.bindings ?? {}), ...options.env } as unknown as Env;
  const reporting = target ?? recorder;

  const buildApp = () => {
    const app = new Hono<{ Bindings: Env }>();
    // The worker's own error answer (src/index.ts).
    app.onError(() =>
      Response.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, { status: 500 }),
    );
    app.use('*', async (c, next) => {
      await next();
      if (reporting) {
        const endpoint = matchedRoutes(c)[c.req.routeIndex];
        if (endpoint && endpoint.method !== 'ALL') c.res.headers.set(ROUTE_HEADER, endpoint.path);
      }
    });
    const serve = async (c: { env: Env; executionCtx: ExecutionContext; req: { raw: Request } }) => {
      const server = await createMcpServer(session, c.env, c.executionCtx);
      return serveMcpRequest(server, c.req.raw, undefined);
    };
    app.post('/mcp', (c) => serve(c));
    app.get('/mcp', (c) => serve(c));
    app.delete('/mcp', (c) => serve(c));
    return app;
  };
  const app = buildApp();

  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      if (typeof promise?.catch === 'function') promise.catch(() => {});
      if (sideEffects && promise) sideEffects.track(promise);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  let inventory: Promise<void> = Promise.resolve();
  if (reporting) inventory = recordInventory(reporting, app.routes);

  const runHere = (db: Database, input: string, init?: RequestInit, runEnv?: Record<string, unknown>) => {
    (globalThis as Record<string, unknown>).__mcpTestTenantDb = db;
    return Promise.resolve(app.request(input, init, (runEnv ?? env) as unknown as Record<string, unknown>, executionCtx));
  };

  const request = async (input: string, init?: RequestInit): Promise<Response> => {
    if (target) {
      await inventory;
      return conformanceRequest({
        target,
        ctx: {
          userId: session.userId,
          orgId: session.clerkOrgId,
          workspaceId: session.workspaceId,
          clerkOrgId: session.clerkOrgId,
          sessionId: '',
          tenantDb: options.tenantDb,
          masterDb: options.masterDb,
        },
        env: env as unknown as Record<string, unknown>,
        input,
        init,
        runTypeScript: (runDb, path, requestInit, runEnv) => runHere(runDb as Database, path, requestInit, runEnv),
        sideEffects: sideEffects!,
        context: { mcpSession: session },
      });
    }
    if (recorder) {
      await inventory;
      return recordOnlyRequest(recorder, init?.method ?? 'GET', input, () => runHere(options.tenantDb, input, init));
    }
    return runHere(options.tenantDb, input, init);
  };

  let nextId = 1;
  /** One JSON-RPC request to `POST /mcp`; the parsed answer. */
  const rpc = async (method: string, params?: unknown, headers: Record<string, string> = {}) => {
    const res = await request('/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  /** `tools/call`: the result's text and whether it is an error. */
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const { body } = await rpc('tools/call', { name, arguments: args });
    const result = body.result as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0]?.text ?? '', isError: result.isError === true, body };
  };

  return { app, env, session, request, rpc, callTool };
}
