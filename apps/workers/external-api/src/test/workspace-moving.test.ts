/**
 * The public API while a workspace's tenant database is being moved
 * (TASK-1150, ADR DATA-016): 503 WORKSPACE_MOVING + Retry-After for every write
 * once the move's lock starts, the same answer when the tenant database says the
 * workspace moved (read-only source, rotated password), and a stale cached URL
 * dropped instead of failing until the TTL runs out.
 *
 * The tenant database is the real neon-http driver pointed at a stubbed
 * `neonConfig.fetchFunction`, so the errors have the shape they have in
 * production: a `DrizzleQueryError` over a `NeonDbError`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Same stub as workspace-details.test.ts. Specs share one module registry here
// (`isolate: false`): whichever file first loads `middleware/auth` fixes what
// `neon-resolve` is for the files after it, so every file that loads it stubs
// it alike. These tests serve the workspace from the KV cache and never resolve.
vi.mock('@weldsuite/db/lib/neon-resolve', () => ({
  resolveDatabaseUrl: async () => 'postgres://resolved/tenant',
}));

import { Hono } from 'hono';
import { getTableColumns } from 'drizzle-orm';
import { NeonDbError, neonConfig } from '@neondatabase/serverless';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { workspaceApiKeys } from '@weldsuite/db/schema/workspace-api-keys';
import { sealCachedDatabaseUrl } from '@weldsuite/db/lib/workspace-url-cache';
import { authMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { licenceMiddleware, workspaceRestrictions } from '../middleware/licence';
import { reachErrorHandler } from '../lib/reach';
import type { ApiKeySession, HonoEnv } from '../types';

const movingBody = {
  error: {
    code: 'WORKSPACE_MOVING',
    message: 'This workspace is being moved to a new database. Try again in a minute.',
  },
};

const ENCRYPTION_KEY = 'a'.repeat(64);
const TENANT_URL = 'postgres://tenant_role:s3cret-pass@ep-test-123456.eu-central-1.aws.neon.tech/tenant_db';

/** The error neon-http + drizzle produce: the driver error (empty code) under a DrizzleQueryError. */
const passwordRotated = () =>
  new DrizzleQueryError('select "id" from "things"', [], new NeonDbError(`password authentication failed for user 'tenant_role'`));
const readOnlySource = () =>
  new DrizzleQueryError(
    'insert into "things" ("name") values ($1)',
    ['x'],
    Object.assign(new NeonDbError('cannot execute INSERT in a read-only transaction'), { code: '25006' }),
  );

const session = (extra: Partial<ApiKeySession> = {}): ApiKeySession => ({
  keyId: 'key_test',
  keyType: 'workspace',
  workspaceId: 'ws_1',
  userId: null,
  scopes: ['*'],
  tier: 'enterprise',
  databaseUrl: null,
  licensedApps: null,
  ...extra,
});

function fakeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const kv = {
    get: vi.fn(async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null)),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
  return { kv: kv as unknown as KVNamespace, mock: kv, store };
}

afterEach(() => vi.restoreAllMocks());

describe('external-api · database move gate', () => {
  /** A request through the real licence gate with a moving workspace's session. */
  function gate(method: string, path = '/v1/tickets/t_1') {
    const app = new Hono<HonoEnv>();
    app.use('*', async (c, next) => {
      c.set('apiSession', session({ readOnly: true, readOnlyReason: 'database_move' }));
      await next();
    });
    app.use('/v1/*', licenceMiddleware);
    app.all('/v1/*', (c) => c.json({ ok: true }));
    return app.request(path, { method });
  }

  it('refuses every write with 503 WORKSPACE_MOVING and Retry-After', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await gate(method);
      expect(res.status, method).toBe(503);
      expect(res.headers.get('Retry-After'), method).toBe('30');
      expect(await res.json()).toEqual(movingBody);
    }
  });

  it('keeps the licence read-only exception: a search POST passes, a look-alike path does not', async () => {
    expect((await gate('POST', '/v1/search')).status).toBe(200);
    expect((await gate('POST', '/v1/search/global')).status).toBe(200);
    expect((await gate('POST', '/v1/search-things')).status).toBe(503);
    expect((await gate('POST', '/v1/tickets/export')).status).toBe(503);
  });

  it('still serves reads', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await gate(method);
      expect(res.status, method).toBe(200);
      expect(res.headers.get('Retry-After'), method).toBeNull();
    }
  });

  it('checks the app licence first', async () => {
    const app = new Hono<HonoEnv>();
    app.use('*', async (c, next) => {
      c.set('apiSession', session({ licensedApps: ['welddesk'], readOnly: true, readOnlyReason: 'database_move' }));
      await next();
    });
    app.use('/v1/*', licenceMiddleware);
    app.all('/v1/*', (c) => c.json({ ok: true }));
    const res = await app.request('/v1/invoices', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_NOT_LICENSED' } });
  });

  it('leaves the licence read-only answer (403 WORKSPACE_READ_ONLY) alone', async () => {
    const app = new Hono<HonoEnv>();
    app.use('*', async (c, next) => {
      c.set('apiSession', session({ readOnly: true, readOnlyReason: 'partner_suspended' }));
      await next();
    });
    app.use('/v1/*', licenceMiddleware);
    app.all('/v1/*', (c) => c.json({ ok: true }));
    const res = await app.request('/v1/tickets', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(await res.json()).toMatchObject({ error: { code: 'WORKSPACE_READ_ONLY' } });
  });
});

describe('external-api · workspaceRestrictions · database move', () => {
  const base = { billingMode: 'direct', licenceStatus: null, licenceApps: null, partnerStatus: null };

  it('makes a workspace read-only with reason database_move, and keeps its licensed apps', () => {
    expect(workspaceRestrictions({ ...base, databaseMoveInProgress: true })).toEqual({
      licensedApps: null,
      readOnly: true,
      readOnlyReason: 'database_move',
    });
    expect(
      workspaceRestrictions({
        billingMode: 'partner',
        licenceStatus: 'active',
        licenceApps: ['weldcrm'],
        partnerStatus: 'active',
        databaseMoveInProgress: true,
      }),
    ).toEqual({ licensedApps: ['weldcrm'], readOnly: true, readOnlyReason: 'database_move' });
  });

  it('lets the move outrank a licence reason', () => {
    expect(
      workspaceRestrictions({
        billingMode: 'partner',
        licenceStatus: 'ended',
        licenceApps: ['weldcrm'],
        partnerStatus: 'suspended',
        databaseMoveInProgress: true,
      }).readOnlyReason,
    ).toBe('database_move');
  });

  it('changes nothing when no move is running', () => {
    for (const databaseMoveInProgress of [false, null, undefined]) {
      expect(workspaceRestrictions({ ...base, databaseMoveInProgress })).toEqual({
        licensedApps: null,
        readOnly: false,
        readOnlyReason: null,
      });
    }
  });
});

describe('external-api · errorHandler · a database that moved under the request', () => {
  /** An app whose route throws `err`; `workspaceId` is what authMiddleware would have set. */
  function appThatThrows(err: unknown, apiSession: ApiKeySession | null = session()) {
    const app = new Hono<HonoEnv>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      if (apiSession) c.set('apiSession', apiSession);
      await next();
    });
    app.all('/v1/things', () => {
      throw err;
    });
    return app;
  }

  it('answers a read-only source (25006) with 503 WORKSPACE_MOVING and Retry-After, keeping the cached URL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kv, mock } = fakeKv();
    const res = await appThatThrows(readOnlySource()).request('/v1/things', { method: 'POST' }, { API_CACHE: kv });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual(movingBody);
    expect(mock.delete).not.toHaveBeenCalled();
  });

  it('answers a rotated password with 503 and drops the workspace cache entry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kv, mock, store } = fakeKv({
      'wsx:id:ws_1': { databaseUrlSealed: 'sealed' },
      'ws:ws_1': { databaseUrl: TENANT_URL },
    });
    const res = await appThatThrows(passwordRotated()).request('/v1/things', {}, { API_CACHE: kv });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual(movingBody);
    // Both the sealed entry and the plaintext key an older worker may still write.
    expect(mock.delete).toHaveBeenCalledTimes(2);
    expect(mock.delete).toHaveBeenCalledWith('wsx:id:ws_1');
    expect(mock.delete).toHaveBeenCalledWith('ws:ws_1');
    expect(store.size).toBe(0);
  });

  it('skips the purge without a session, and still answers 503', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kv, mock } = fakeKv();
    const res = await appThatThrows(passwordRotated(), null).request('/v1/things', {}, { API_CACHE: kv });
    expect(res.status).toBe(503);
    expect(mock.delete).not.toHaveBeenCalled();
  });

  it('still answers 503 when the purge fails or there is no KV binding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = { delete: () => Promise.reject(new Error('kv down')) } as unknown as KVNamespace;
    expect((await appThatThrows(passwordRotated()).request('/v1/things', {}, { API_CACHE: failing })).status).toBe(503);
    expect((await appThatThrows(passwordRotated()).request('/v1/things', {}, {})).status).toBe(503);
  });

  it('does not log the error: its message can carry a connection string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error(`password authentication failed for user 'tenant_role' (${TENANT_URL})`);
    await appThatThrows(err).request('/v1/things', {}, { API_CACHE: fakeKv().kv });
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain('s3cret-pass');
    expect(logged).not.toContain('postgres://');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ws_1'));
  });

  it('leaves every other error as it was: a 500 envelope, and the cache alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { kv, mock } = fakeKv();
    const unique = new DrizzleQueryError('insert into "t" ("a") values ($1)', ['x'], Object.assign(new NeonDbError('duplicate key'), { code: '23505' }));
    for (const err of [new Error('boom'), unique]) {
      const res = await appThatThrows(err).request('/v1/things', { method: 'POST' }, { API_CACHE: kv });
      expect(res.status).toBe(500);
      expect(res.headers.get('Retry-After')).toBeNull();
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
    }
    expect(mock.delete).not.toHaveBeenCalled();
  });

  it('reaches the reach router too: its error handler falls back to this one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = new Hono<HonoEnv>();
    app.onError(reachErrorHandler);
    app.use('*', async (c, next) => {
      c.set('apiSession', session());
      await next();
    });
    app.get('/v1/reach/things', () => {
      throw passwordRotated();
    });
    const { kv, mock } = fakeKv();
    const res = await app.request('/v1/reach/things', {}, { API_CACHE: kv });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(movingBody);
    expect(mock.delete).toHaveBeenCalledTimes(2);
    expect(mock.delete).toHaveBeenCalledWith('wsx:id:ws_1');
    expect(mock.delete).toHaveBeenCalledWith('ws:ws_1');
  });
});

describe('external-api · authMiddleware · a workspace key against a tenant database that moved', () => {
  const API_KEY = 'wsk_moving_test_key';

  async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Cached registry + workspace entries, so master (Hyperdrive) is never asked.
   * The workspace is cached the way the worker writes it, sealed under
   * `wsx:id:<id>`; the plaintext `ws:<id>` copy is what a not-yet-redeployed
   * worker may still have written: never read, but a purge must drop it.
   */
  async function cachedKv(workspace: Record<string, unknown> = {}) {
    const entry = { tier: 'business', clerkOrgId: 'org_1', licensedApps: null, readOnly: false, ...workspace };
    return fakeKv({
      [`akr:${await sha256Hex(API_KEY)}`]: { workspaceId: 'ws_1', keyType: 'workspace', tenantKeyId: 'wk_1' },
      'wsx:id:ws_1': { ...entry, databaseUrlSealed: await sealCachedDatabaseUrl(TENANT_URL, { v1: ENCRYPTION_KEY }) },
      'ws:ws_1': { ...entry, databaseUrl: TENANT_URL },
    });
  }

  function appUnderTest() {
    const app = new Hono<HonoEnv>();
    app.onError(errorHandler);
    app.use('/v1/*', authMiddleware);
    app.use('/v1/*', licenceMiddleware);
    app.all('/v1/things', (c) => c.json({ data: { workspaceId: c.get('workspaceId') } }));
    return app;
  }

  const bindings = (kv: KVNamespace) => ({
    API_CACHE: kv,
    HYPERDRIVE_MASTER: { connectionString: 'postgres://master:master@localhost:5432/master' },
    NEON_API_KEY: 'neon-test',
    DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });

  const request = (kv: KVNamespace, method = 'GET') =>
    appUnderTest().request('/v1/things', { method, headers: { Authorization: `Bearer ${API_KEY}` } }, bindings(kv));

  interface Sent {
    query: string;
  }

  /** Stub the tenant database's HTTP endpoint; `answer` decides each statement's reply. */
  function stubTenantDatabase(answer: (query: string) => Response) {
    const sent: Sent[] = [];
    const previous = neonConfig.fetchFunction;
    neonConfig.fetchFunction = async (_url: unknown, init?: { body?: string }) => {
      const { query } = JSON.parse(String(init?.body)) as Sent;
      sent.push({ query });
      return answer(query);
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

  /** A one-row answer to `select … from workspace_api_keys`: only the id is set. */
  function keyRow(): Response {
    const columns = Object.values(getTableColumns(workspaceApiKeys));
    return new Response(
      JSON.stringify({
        command: 'SELECT',
        rowCount: 1,
        rowAsArray: true,
        fields: columns.map((column) => ({ name: column.name, dataTypeID: 25 })),
        rows: [columns.map((column) => (column.name === 'id' ? 'wk_1' : null))],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  let stub: ReturnType<typeof stubTenantDatabase> | null = null;
  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  it('answers 503 WORKSPACE_MOVING, not 401 "invalid key", when the role password was rotated, and drops the cached URL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stub = stubTenantDatabase(() => dbError(`password authentication failed for user 'tenant_role'`));
    const { kv, mock, store } = await cachedKv();

    const res = await request(kv);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual(movingBody);
    // Both the sealed entry and the plaintext key are dropped.
    expect(mock.delete).toHaveBeenCalledTimes(2);
    expect(mock.delete).toHaveBeenCalledWith('wsx:id:ws_1');
    expect(mock.delete).toHaveBeenCalledWith('ws:ws_1');
    expect(store.has('wsx:id:ws_1')).toBe(false);
    expect(store.has('ws:ws_1')).toBe(false);
    // The connection string stays out of the logs.
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('s3cret-pass');
  });

  it('answers 503 on a read-only source as well', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub = stubTenantDatabase(() => dbError('cannot execute SELECT in a read-only transaction', '25006'));
    const { kv, mock } = await cachedKv();
    const res = await request(kv);
    expect(res.status).toBe(503);
    expect(mock.delete).not.toHaveBeenCalled();
  });

  it('still answers 401 for a database error that has nothing to do with a move', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stub = stubTenantDatabase(() => dbError('relation "workspace_api_keys" does not exist', '42P01'));
    const { kv } = await cachedKv();
    expect((await request(kv)).status).toBe(401);
  });

  it('lets a key through and records its use on a workspace that is not moving', async () => {
    stub = stubTenantDatabase((query) => (query.startsWith('select') ? keyRow() : new Response(JSON.stringify({ command: 'UPDATE', rowCount: 1, fields: [], rows: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { kv } = await cachedKv();

    const res = await request(kv, 'POST');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(res.status).toBe(200);
    expect(stub.sent.some((s) => s.query.startsWith('update "workspace_api_keys"'))).toBe(true);
  });

  it('refuses writes on a moving workspace, and does not write lastUsedAt into the database being copied', async () => {
    stub = stubTenantDatabase(() => keyRow());
    const { kv } = await cachedKv({ readOnly: true, readOnlyReason: 'database_move' });

    const write = await request(kv, 'POST');
    const read = await request(kv, 'GET');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(write.status).toBe(503);
    expect(await write.json()).toEqual(movingBody);
    expect(read.status).toBe(200);
    expect(stub.sent.length).toBeGreaterThan(0);
    expect(stub.sent.every((s) => s.query.startsWith('select'))).toBe(true);
  });

  it('serves an entry cached before database moves existed as not moving', async () => {
    stub = stubTenantDatabase((query) => (query.startsWith('select') ? keyRow() : new Response(JSON.stringify({ command: 'UPDATE', rowCount: 1, fields: [], rows: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { kv } = await cachedKv({ readOnly: undefined, readOnlyReason: undefined });
    const res = await request(kv, 'POST');
    expect(res.status).toBe(200);
  });
});
