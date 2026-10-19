/**
 * The MCP endpoint's auth step while a workspace's tenant database is being moved
 * (TASK-1150): it reads the caller's permissions from the tenant database, so a
 * database that moved under the request (source set read-only, role password
 * rotated) answers 503 + Retry-After instead of "could not resolve permissions",
 * and a rotated password drops the cached tenant URL.
 *
 * Clerk is stubbed (the token is "verified"); the tenant database is the real
 * neon-http driver pointed at a stubbed `neonConfig.fetchFunction`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    authenticateRequest: async () => ({
      reason: null,
      toAuth: () => ({ isAuthenticated: true, id: 'oat_1', userId: 'user_1', clientId: null, tokenType: 'oauth_token' }),
    }),
  }),
}));

import { Hono } from 'hono';
import { neonConfig } from '@neondatabase/serverless';
import { sealCachedDatabaseUrl } from '@weldsuite/db/lib/workspace-url-cache';
import { authMiddleware } from './auth';
import type { HonoEnv } from '../lib/api-types';

const ENCRYPTION_KEY = 'a'.repeat(64);
const TENANT_URL = 'postgres://tenant_role:s3cret-pass@ep-test-123456.eu-central-1.aws.neon.tech/tenant_db';

const base64Url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A JWT-shaped access token carrying the org claim; Clerk's verification is stubbed. */
const TOKEN = `${base64Url({ alg: 'none' })}.${base64Url({ org_id: 'org_1' })}.sig`;

/**
 * A KV holding the workspace the way the worker caches it: sealed under
 * `mcpx:org:<org>`, plus the plaintext `mcp:org:<org>` copy a not-yet-redeployed
 * worker may still have written (never read, but a purge must drop it).
 */
async function fakeKv() {
  const entry = { workspaceId: 'ws_1', name: 'Acme', tier: 'business', licensedApps: null };
  const store = new Map<string, string>([
    [
      'mcpx:org:org_1',
      JSON.stringify({ ...entry, databaseUrlSealed: await sealCachedDatabaseUrl(TENANT_URL, { v1: ENCRYPTION_KEY }) }),
    ],
    ['mcp:org:org_1', JSON.stringify({ ...entry, databaseUrl: TENANT_URL })],
  ]);
  const kv = {
    get: vi.fn(async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null)),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
  return { kv: kv as unknown as KVNamespace, mock: kv, store };
}

function call(kv: KVNamespace) {
  const app = new Hono<HonoEnv>();
  app.all('/mcp', authMiddleware, (c) => c.json({ ok: true }));
  return app.request(
    '/mcp',
    { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } },
    {
      API_CACHE: kv,
      DATABASE_URL_MASTER: 'postgres://master:master@ep-master-123456.eu-central-1.aws.neon.tech/master',
      NEON_API_KEY: 'neon-test',
      DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
      CLERK_SECRET_KEY: 'sk_test',
      CLERK_PUBLISHABLE_KEY: 'pk_test_Zm9vLmNsZXJrLmFjY291bnRzLmRldiQ',
      MCP_SERVER_URL: 'https://mcp.test',
    },
  );
}

const dbError = (message: string, code?: string) =>
  new Response(JSON.stringify({ message, severity: 'FATAL', ...(code ? { code } : {}) }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

let restoreNeon: (() => void) | null = null;
function stubTenantDatabase(reply: Response) {
  const previous = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async () => reply.clone();
  restoreNeon = () => {
    neonConfig.fetchFunction = previous;
  };
}

afterEach(() => {
  restoreNeon?.();
  restoreNeon = null;
  vi.restoreAllMocks();
});

describe('mcp-server · authMiddleware · a tenant database that moved', () => {
  it('answers 503 + Retry-After, not a 500, when the role password was rotated, and drops the cached workspace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubTenantDatabase(dbError(`password authentication failed for user 'tenant_role'`));
    const { kv, mock, store } = await fakeKv();

    const res = await call(kv);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'This workspace is being moved to a new database. Try again in a minute.',
        data: { code: 'WORKSPACE_MOVING' },
      },
      id: null,
    });
    // Both the sealed entry and the plaintext key are dropped.
    expect(mock.delete).toHaveBeenCalledTimes(2);
    expect(mock.delete).toHaveBeenCalledWith('mcpx:org:org_1');
    expect(mock.delete).toHaveBeenCalledWith('mcp:org:org_1');
    expect(store.has('mcpx:org:org_1')).toBe(false);
    expect(store.has('mcp:org:org_1')).toBe(false);
    // The connection string stays out of the logs.
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('s3cret-pass');
  });

  it('answers 503 on a read-only source as well, keeping the cached workspace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubTenantDatabase(dbError('cannot execute SELECT in a read-only transaction', '25006'));
    const { kv, mock } = await fakeKv();
    const res = await call(kv);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(mock.delete).not.toHaveBeenCalled();
  });

  it('keeps the 500 for a database error that has nothing to do with a move', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubTenantDatabase(dbError('relation "team_members" does not exist', '42P01'));
    const { kv, mock } = await fakeKv();
    const res = await call(kv);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { message: 'Could not resolve permissions.' } });
    expect(mock.delete).not.toHaveBeenCalled();
  });
});
