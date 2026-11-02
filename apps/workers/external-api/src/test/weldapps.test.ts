/**
 * WeldApps' surface of the public API against real (pglite) master and
 * tenant databases: the `client_credentials` grant (`/v1/oauth/token`) and
 * the app storage data plane (`/v1/app-storage`), with every refusal.
 *
 * The routes open the master database themselves (`createMasterDb`), so this
 * file mocks that seam and runs in its own vitest process (see the `test`
 * script): with the shared module registry another file would have loaded
 * the routes before the mock.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import * as masterSchema from '@weldsuite/db/schema/master';
import { eq } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { ApiKeySession, Env } from '../types';
import type { Database } from '../db';

const master = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../lib/master-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/master-db')>()),
  createMasterDb: () => conformanceMasterDb(master.db),
}));

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let tenantDb: Database;
let masterDb: Database;

const appSession: ApiKeySession = {
  keyId: 'uat_test',
  keyType: 'app',
  workspaceId: 'ws_test',
  userId: null,
  scopes: ['tickets:read'],
  tier: 'enterprise',
  databaseUrl: null,
  licensedApps: null,
  appId: 'uapp_tasks',
  appCode: 'tasks-app',
  installId: 'uai_tasks',
} as ApiKeySession;

const workspaceKey = (scopes: string[]): ApiKeySession =>
  ({
    keyId: 'key_ws',
    keyType: 'workspace',
    workspaceId: 'ws_test',
    userId: null,
    scopes,
    tier: 'enterprise',
    databaseUrl: null,
    licensedApps: null,
  }) as ApiKeySession;

/** A test app with an `API_CACHE` namespace, as the worker has. */
function app(session: ApiKeySession | null) {
  return createExternalTestApp({
    session,
    tenantDb,
    masterDb,
    env: { API_CACHE: createMemoryKv() } as Partial<Env>,
  });
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db as Database;
  master.db = masterDb;
  const m = masterDb as unknown as import('drizzle-orm/pglite').PgliteDatabase<typeof masterSchema>;
  await m.insert(masterSchema.userApps).values([
    {
      id: 'uapp_tasks',
      code: 'tasks-app',
      name: 'Tasks',
      ownerWorkspaceId: 'ws_dev',
      createdBy: 'user_dev',
    },
    {
      id: 'uapp_gone',
      code: 'gone-app',
      name: 'Gone',
      ownerWorkspaceId: 'ws_dev',
      createdBy: 'user_dev',
      isActive: false,
    },
    {
      id: 'uapp_idle',
      code: 'idle-app',
      name: 'Idle',
      ownerWorkspaceId: 'ws_dev',
      createdBy: 'user_dev',
    },
  ] as (typeof masterSchema.userApps.$inferInsert)[]);
  await m.insert(masterSchema.userAppInstalls).values([
    {
      id: 'uai_tasks',
      appId: 'uapp_tasks',
      workspaceId: 'ws_test',
      installedBy: 'user_admin',
      grantedScopes: ['tickets:read', 'people:write'],
    },
    {
      id: 'uai_gone',
      appId: 'uapp_gone',
      workspaceId: 'ws_test',
      installedBy: 'user_admin',
      grantedScopes: [],
    },
  ] as (typeof masterSchema.userAppInstalls.$inferInsert)[]);
  await m.insert(masterSchema.userAppOauthClients).values([
    { id: 'uaoc_tasks', appId: 'uapp_tasks', clientId: 'wac_tasks', clientSecretHash: sha256('wacs_tasks') },
    { id: 'uaoc_gone', appId: 'uapp_gone', clientId: 'wac_gone', clientSecretHash: sha256('wacs_gone') },
    { id: 'uaoc_idle', appId: 'uapp_idle', clientId: 'wac_idle', clientSecretHash: sha256('wacs_idle') },
  ] as (typeof masterSchema.userAppOauthClients.$inferInsert)[]);
}, 120_000);

describe('external-api · POST /v1/oauth/token', () => {
  const post = (body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
    app(null).request('/v1/oauth/token', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('mints a one-hour session token with the install scopes', async () => {
    const res = await post({
      grant_type: 'client_credentials',
      client_id: 'wac_tasks',
      client_secret: 'wacs_tasks',
      workspace_id: 'ws_test',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string; expires_in: number; scope: string };
    expect(body.access_token).toMatch(/^wsat_[0-9a-f]{40}$/);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'tickets:read people:write' });
    const m = masterDb as unknown as import('drizzle-orm/pglite').PgliteDatabase<typeof masterSchema>;
    const [row] = await m
      .select()
      .from(masterSchema.userAppTokens)
      .where(eq(masterSchema.userAppTokens.tokenHash, sha256(body.access_token)));
    expect(row).toMatchObject({ tokenType: 'session', installId: 'uai_tasks', appId: 'uapp_tasks' });
  });

  it('accepts a form-encoded grant', async () => {
    const res = await post(
      'grant_type=client_credentials&client_id=wac_tasks&client_secret=wacs_tasks&workspace_id=ws_test',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
    expect(res.status).toBe(200);
  });

  it('refuses another grant type', async () => {
    const res = await post({ grant_type: 'authorization_code', client_id: 'wac_tasks' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unsupported_grant_type',
      error_description: 'Only grant_type=client_credentials is supported',
    });
  });

  it('requires the client id, secret and workspace', async () => {
    const res = await post({ grant_type: 'client_credentials', client_id: 'wac_tasks', client_secret: '' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('answers a body that is not JSON', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_description: string }).error_description).toBe('Malformed request body');
  });

  it('refuses a wrong secret, an unknown client and an inactive app', async () => {
    for (const [clientId, secret] of [
      ['wac_tasks', 'wacs_wrong'],
      ['wac_nobody', 'wacs_tasks'],
      ['wac_gone', 'wacs_gone'],
    ]) {
      const res = await post({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
        workspace_id: 'ws_test',
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
    }
  });

  it('refuses a workspace the app is not installed in', async () => {
    const res = await post({
      grant_type: 'client_credentials',
      client_id: 'wac_idle',
      client_secret: 'wacs_idle',
      workspace_id: 'ws_test',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_description: string }).error_description).toBe(
      'App is not installed (or install is revoked) in the requested workspace',
    );
  });
});

describe('external-api · /v1/app-storage', () => {
  const records = '/v1/app-storage/collections/tasks/records';

  it('stores, reads, lists, updates and deletes an app token’s records', async () => {
    const { request } = app(appSession);
    const created = await request(records, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: { title: 'First', status: 'open' } }),
    });
    expect(created.status).toBe(201);
    const { data: first } = (await created.json()) as { data: { id: string; appCode: string; createdBy: string } };
    expect(first).toMatchObject({ appCode: 'tasks-app', createdBy: 'uat_test' });
    await request(records, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: { title: 'Second', status: 'done' } }),
    });

    expect((await request(`${records}/${first.id}`)).status).toBe(200);
    const listed = (await (await request(records)).json()) as { data: unknown[]; pagination: { totalCount: number } };
    expect(listed.pagination.totalCount).toBe(2);
    const open = (await (await request(`${records}?filter=${encodeURIComponent('{"status":"open"}')}`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(open.data.map((r) => r.id)).toEqual([first.id]);
    const page = (await (await request(`${records}?limit=1`)).json()) as {
      pagination: { hasMore: boolean; cursor: string };
    };
    expect(page.pagination.hasMore).toBe(true);
    const next = (await (await request(`${records}?limit=1&cursor=${page.pagination.cursor}`)).json()) as {
      data: unknown[];
    };
    expect(next.data).toHaveLength(1);

    const patched = await request(`${records}/${first.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: { title: 'First', status: 'done' } }),
    });
    expect(patched.status).toBe(200);
    expect((await request(`${records}/${first.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${records}/${first.id}`)).status).toBe(404);
    expect((await request(`${records}/${first.id}`, { method: 'DELETE' })).status).toBe(404);
    const missing = await request(`${records}/arec_missing`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: {} }),
    });
    expect(missing.status).toBe(404);
  });

  it('validates bodies, queries, filters and collection names', async () => {
    const { request } = app(appSession);
    const noData = await request(records, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}) });
    expect(noData.status).toBe(400);
    const listData = await request(records, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: [1, 2] }),
    });
    expect(listData.status).toBe(400);
    const badPatch = await request(`${records}/arec_x`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: 'text' }),
    });
    expect(badPatch.status).toBe(400);
    expect((await request(`${records}?limit=500`)).status).toBe(400);
    expect((await request(`${records}?limit=1.5`)).status).toBe(400);
    const badFilter = await request(`${records}?filter=${encodeURIComponent('{nope')}`);
    expect(badFilter.status).toBe(400);
    expect(((await badFilter.json()) as { error: { message: string } }).error.message).toBe(
      'filter must be a valid JSON string',
    );
    for (const name of ['Tasks', '9tasks', 'a'.repeat(101)]) {
      const res = await request(`/v1/app-storage/collections/${name}/records`);
      expect(res.status).toBe(400);
    }
    const badName = await request('/v1/app-storage/collections/Bad/records', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: {} }),
    });
    expect(badName.status).toBe(400);
    expect((await request('/v1/app-storage/collections/Bad/records/arec_x')).status).toBe(400);
    expect((await request('/v1/app-storage/collections/Bad/records/arec_x', { method: 'DELETE' })).status).toBe(400);
  });

  it('keeps key-value pairs per app', async () => {
    const { request } = app(appSession);
    const kv = '/v1/app-storage/kv/settings';
    expect((await request(kv)).status).toBe(404);
    const put = await request(kv, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ value: { theme: 'dark' } }) });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ data: { key: 'settings', value: { theme: 'dark' } } });
    // No `value`: the stored one stays.
    const keep = await request(kv, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({}) });
    expect(await keep.json()).toEqual({ data: { key: 'settings', value: { theme: 'dark' } } });
    const cleared = await request(kv, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ value: null }) });
    expect(await cleared.json()).toEqual({ data: { key: 'settings', value: null } });
    const fresh = await request('/v1/app-storage/kv/fresh', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({}) });
    expect(await fresh.json()).toEqual({ data: { key: 'fresh', value: null } });
    expect((await request(kv)).status).toBe(200);
    expect((await request(kv, { method: 'DELETE' })).status).toBe(204);
    expect((await request(kv, { method: 'DELETE' })).status).toBe(404);
    const long = `/v1/app-storage/kv/${'k'.repeat(256)}`;
    expect((await request(long)).status).toBe(400);
    expect((await request(long, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ value: 1 }) })).status).toBe(400);
    expect((await request(long, { method: 'DELETE' })).status).toBe(400);
    const notObject = await request(kv, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify('x') });
    expect(notObject.status).toBe(400);
  });

  it('lets a workspace key reach an installed app with X-App-Code', async () => {
    const key = app(workspaceKey(['user-apps:manage']));
    const res = await key.request(records, { headers: { 'X-App-Code': 'tasks-app' } });
    expect(res.status).toBe(200);
    // Cached for the next request.
    expect((await key.request('/v1/app-storage/kv/settings', { headers: { 'X-App-Code': 'tasks-app' } })).status).toBe(
      404,
    );
  });

  it('refuses a workspace key without the header, the scope or an active install', async () => {
    const noHeader = await app(workspaceKey(['user-apps:manage'])).request(records);
    expect(noHeader.status).toBe(400);
    const noScope = await app(workspaceKey(['tickets:read'])).request(records, { headers: { 'X-App-Code': 'tasks-app' } });
    expect(noScope.status).toBe(403);
    for (const code of ['gone-app', 'idle-app', 'nobody']) {
      const res = await app(workspaceKey(['*'])).request('/v1/app-storage/kv/settings', {
        headers: { 'X-App-Code': code },
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
        `Installed app with ID '${code}' not found`,
      );
    }
  });
});
