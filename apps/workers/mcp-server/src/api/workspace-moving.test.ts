/**
 * The MCP server while a workspace's tenant database is being moved
 * (TASK-1150, ADR DATA-016): its tool calls that write are refused with
 * 503 WORKSPACE_MOVING (a tool error saying to try again), the same answer when
 * the tenant database says the workspace moved (read-only source, rotated
 * password), and a stale cached URL dropped instead of failing until the TTL
 * runs out.
 *
 * The tenant database is the real neon-http driver pointed at a stubbed
 * `neonConfig.fetchFunction`, so the errors have the shape they have in
 * production: a `DrizzleQueryError` over a `NeonDbError`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { NeonDbError, neonConfig } from '@neondatabase/serverless';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { INTERNAL_ORIGIN, apiApp, internalEnv } from './app';
import { errorHandler } from './middleware/error-handler';
import { executeTool } from '../lib/proxy';
import type { McpSession } from '../lib/api-types';
import type { ToolDefinition } from '../tools/registry';
import type { Env } from '../types/env';
import type { HonoEnv } from './types';

const movingBody = {
  error: {
    code: 'WORKSPACE_MOVING',
    message: 'This workspace is being moved to a new database. Try again in a minute.',
  },
};

const TENANT_URL = 'postgres://tenant_role:s3cret-pass@ep-test-123456.eu-central-1.aws.neon.tech/tenant_db';

const session = (extra: Partial<McpSession> = {}): McpSession => ({
  tokenId: 'oat_test',
  userId: 'user_test',
  clerkOrgId: 'org_test',
  workspaceId: 'ws_test',
  workspaceName: 'Test',
  tier: 'enterprise',
  databaseUrl: TENANT_URL,
  permissions: ['*'],
  permissionDenies: [],
  role: 'OWNER',
  clientId: null,
  licensedApps: null,
  ...extra,
});

const moving = (extra: Partial<McpSession> = {}) => session({ readOnly: true, readOnlyReason: 'database_move', ...extra });

function fakeKv() {
  const kv = { delete: vi.fn(async () => {}) };
  return { kv: kv as unknown as KVNamespace, mock: kv };
}

const dispatch = (s: McpSession, path: string, method = 'GET', env: Partial<Env> = {}) =>
  apiApp.fetch(new Request(`${INTERNAL_ORIGIN}${path}`, { method }), internalEnv(env as Env, s));

/** Stub the tenant database's HTTP endpoint with one reply to every statement. */
function stubTenantDatabase(reply: Response) {
  const sent: string[] = [];
  const previous = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (_url: unknown, init?: { body?: string }) => {
    sent.push((JSON.parse(String(init?.body)) as { query: string }).query);
    return reply.clone();
  };
  return {
    sent,
    restore: () => {
      neonConfig.fetchFunction = previous;
    },
  };
}

const dbError = (message: string, code?: string) =>
  new Response(JSON.stringify({ message, severity: 'FATAL', ...(code ? { code } : {}) }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

let stub: ReturnType<typeof stubTenantDatabase> | null = null;
afterEach(() => {
  stub?.restore();
  stub = null;
  vi.restoreAllMocks();
});

describe('mcp-server internal API · database move gate', () => {
  it('refuses every write with 503 WORKSPACE_MOVING and Retry-After', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await dispatch(moving(), '/v1/tickets/t_1', method);
      expect(res.status, method).toBe(503);
      expect(res.headers.get('Retry-After'), method).toBe('30');
      expect(await res.json()).toEqual(movingBody);
    }
  });

  it('keeps the licence read-only exception: a search POST passes the gate, a look-alike path does not', async () => {
    // Past the gate, the router has no such object here: 404, not 503.
    expect((await dispatch(moving(), '/v1/search', 'POST')).status).not.toBe(503);
    expect((await dispatch(moving(), '/v1/search-things', 'POST')).status).toBe(503);
    expect((await dispatch(moving(), '/v1/tickets/export', 'POST')).status).toBe(503);
  });

  it('lets reads past the gate', async () => {
    // An unknown object 404s in the router, after the gate.
    expect((await dispatch(moving(), '/v1/no-such-object', 'GET')).status).toBe(404);
  });

  it('checks the app licence first', async () => {
    const res = await dispatch(moving({ licensedApps: ['welddesk'] }), '/v1/invoices', 'POST');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_NOT_LICENSED' } });
  });

  it('leaves the licence read-only answer (403 WORKSPACE_READ_ONLY) alone', async () => {
    const res = await dispatch(
      session({ readOnly: true, readOnlyReason: 'partner_suspended' }),
      '/v1/tickets/t_1',
      'POST',
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(await res.json()).toMatchObject({ error: { code: 'WORKSPACE_READ_ONLY' } });
  });

  it('does not touch writable sessions', async () => {
    expect((await dispatch(session(), '/v1/no-such-object', 'POST')).status).toBe(404);
  });
});

describe('mcp-server internal API · a database that moved under the request', () => {
  it('answers a rotated password with 503 WORKSPACE_MOVING and drops the cached workspace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stub = stubTenantDatabase(dbError(`password authentication failed for user 'tenant_role'`));
    const { kv, mock } = fakeKv();

    const res = await dispatch(session(), '/v1/leads', 'GET', { API_CACHE: kv });

    expect(stub.sent.length).toBeGreaterThan(0);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual(movingBody);
    expect(mock.delete).toHaveBeenCalledWith('mcp:org:org_test');
    // The connection string stays out of the logs.
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('s3cret-pass');
  });

  it('answers a read-only source (25006) with 503 and keeps the cached workspace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub = stubTenantDatabase(dbError('cannot execute SELECT in a read-only transaction', '25006'));
    const { kv, mock } = fakeKv();
    const res = await dispatch(session(), '/v1/leads', 'GET', { API_CACHE: kv });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(movingBody);
    expect(mock.delete).not.toHaveBeenCalled();
  });

  it('still answers 503 when the purge fails or there is no KV binding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub = stubTenantDatabase(dbError(`password authentication failed for user 'tenant_role'`));
    const failing = { delete: () => Promise.reject(new Error('kv down')) } as unknown as KVNamespace;
    expect((await dispatch(session(), '/v1/leads', 'GET', { API_CACHE: failing })).status).toBe(503);
    expect((await dispatch(session(), '/v1/leads', 'GET', {})).status).toBe(503);
  });

  it('keeps Hono\'s default for every other error: a logged 500, and the cache alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stub = stubTenantDatabase(dbError('relation "leads" does not exist', '42P01'));
    const { kv, mock } = fakeKv();
    const res = await dispatch(session(), '/v1/leads', 'GET', { API_CACHE: kv });
    expect(res.status).toBe(500);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(mock.delete).not.toHaveBeenCalled();
  });
});

describe('mcp-server reach router · errorHandler', () => {
  function appThatThrows(err: unknown) {
    const app = new Hono<HonoEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('apiSession', { keyId: 'k', keyType: 'personal', workspaceId: 'ws_test', clerkOrgId: 'org_test', userId: 'u', scopes: [], tier: 'enterprise', databaseUrl: null });
      await next();
    });
    app.all('/v1/things', () => {
      throw err;
    });
    return app;
  }

  it('answers a moved database with 503 and drops the cached workspace on a rotated password', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kv, mock } = fakeKv();
    const rotated = new DrizzleQueryError('select 1', [], new NeonDbError(`password authentication failed for user 'tenant_role'`));
    const res = await appThatThrows(rotated).request('/v1/things', {}, { API_CACHE: kv });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual(movingBody);
    expect(mock.delete).toHaveBeenCalledWith('mcp:org:org_test');

    const readOnly = Object.assign(new NeonDbError('cannot execute INSERT in a read-only transaction'), { code: '25006' });
    const second = await appThatThrows(readOnly).request('/v1/things', { method: 'POST' }, { API_CACHE: kv });
    expect(second.status).toBe(503);
    expect(mock.delete).toHaveBeenCalledTimes(1);
  });

  it('leaves other errors a 500 envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appThatThrows(new Error('boom')).request('/v1/things', {}, { API_CACHE: fakeKv().kv });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('mcp-server tools · a workspace that is moving', () => {
  const createLead: ToolDefinition = {
    name: 'create_lead',
    scope: 'leads:write',
    description: 'Create a lead',
    inputSchema: {},
    method: 'POST',
    path: '/v1/leads',
  };
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it('turns the 503 into a tool error that names the code and says to try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await executeTool(createLead, { name: 'Acme' }, moving(), {} as Env, executionCtx);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'WORKSPACE_MOVING: This workspace is being moved to a new database. Try again in a minute.',
      },
    ]);
  });
});
