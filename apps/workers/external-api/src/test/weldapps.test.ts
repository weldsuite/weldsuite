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
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
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

describe('external-api · /v1/user-apps', () => {
  const developerKey = (scopes = ['user-apps:manage']) => workspaceKey(scopes);
  const storage = createMemoryR2();
  const dev = (session: ApiKeySession = developerKey()) =>
    createExternalTestApp({
      session,
      tenantDb,
      masterDb,
      env: { API_CACHE: createMemoryKv(), STORAGE: storage } as Partial<Env>,
    });
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const upload = (manifest: unknown, files: Array<[string, string]>, extra: Record<string, string> = {}) => {
    const form = new FormData();
    if (manifest !== undefined) form.append('manifest', typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    for (const [key, value] of Object.entries(extra)) form.append(key, value);
    for (const [name, text] of files) form.append('files', new File([text], name, { type: 'text/plain' }));
    return { method: 'POST', body: form } as RequestInit;
  };
  const manifest = (code: string, version: string) => ({
    code,
    name: 'Notes',
    version,
    scopes: ['people:read', 'tickets:read'],
    agentTools: [
      { name: 'list_notes', description: 'List notes', action: { type: 'api.request', method: 'GET', path: '/v1/people' } },
    ],
  });

  it('gates developer routes on a non-app key with user-apps:manage', async () => {
    const asApp = await dev(appSession).request('/v1/user-apps');
    expect(asApp.status).toBe(403);
    const noScope = await dev(developerKey(['tickets:read'])).request('/v1/user-apps', json('POST', {}));
    expect(noScope.status).toBe(403);
  });

  it('lists installed agent tools, an app token only its own', async () => {
    const m = masterDb as unknown as import('drizzle-orm/pglite').PgliteDatabase<typeof masterSchema>;
    await m
      .update(masterSchema.userApps)
      .set({ manifest: manifest('tasks-app', '1.0.0') as never })
      .where(eq(masterSchema.userApps.id, 'uapp_tasks'));
    const all = await dev(developerKey(['tickets:read'])).request('/v1/user-apps/agent-tools');
    expect(all.status).toBe(200);
    expect(((await all.json()) as { data: unknown[] }).data).toHaveLength(1);
    const own = await dev(appSession).request('/v1/user-apps/agent-tools');
    expect(((await own.json()) as { data: Array<{ appCode: string }> }).data[0]?.appCode).toBe('tasks-app');
  });

  it('creates, reads, updates and deletes an app', async () => {
    const { request } = dev();
    expect((await request('/v1/user-apps', json('POST', { code: 'notes-app' }))).status).toBe(400);
    expect((await request('/v1/user-apps', json('POST', { code: 'weldcrm', name: 'CRM' }))).status).toBe(409);
    expect((await request('/v1/user-apps', json('POST', { code: 'tasks-app', name: 'Tasks' }))).status).toBe(409);
    const created = await request(
      '/v1/user-apps',
      json('POST', { code: 'notes-app', name: 'Notes', description: 'Team notes', icon: 'NotebookPen', screenshots: [] }),
    );
    expect(created.status).toBe(201);
    const { data: app } = (await created.json()) as { data: { id: string; publisherType: string; icon: string } };
    expect(app).toMatchObject({ publisherType: 'community', icon: 'NotebookPen' });

    const listed = (await (await request('/v1/user-apps')).json()) as { data: Array<{ id: string }> };
    expect(listed.data.map((a) => a.id)).toContain(app.id);
    expect((await request(`/v1/user-apps/${app.id}`)).status).toBe(200);
    expect((await request('/v1/user-apps/uapp_tasks')).status).toBe(404);

    const patched = await request(
      `/v1/user-apps/${app.id}`,
      json('PATCH', { name: 'Team notes', websiteUrl: null, isActive: false, category: 'Docs' }),
    );
    expect(patched.status).toBe(200);
    expect((await request(`/v1/user-apps/${app.id}`, json('PATCH', { name: '' }))).status).toBe(400);
    expect((await request('/v1/user-apps/uapp_missing', json('PATCH', { name: 'X' }))).status).toBe(404);

    expect((await request(`/v1/user-apps/${app.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`/v1/user-apps/${app.id}`)).status).toBe(404);
    expect((await request(`/v1/user-apps/${app.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses to delete an app installed elsewhere', async () => {
    const m = masterDb as unknown as import('drizzle-orm/pglite').PgliteDatabase<typeof masterSchema>;
    await m.insert(masterSchema.userApps).values({
      id: 'uapp_shared',
      code: 'shared-app',
      name: 'Shared',
      ownerWorkspaceId: 'ws_test',
      createdBy: 'user_dev',
    } as typeof masterSchema.userApps.$inferInsert);
    await m.insert(masterSchema.userAppInstalls).values({
      id: 'uai_shared_other',
      appId: 'uapp_shared',
      workspaceId: 'ws_other',
      installedBy: 'user_other',
    } as typeof masterSchema.userAppInstalls.$inferInsert);
    const res = await dev().request('/v1/user-apps/uapp_shared', { method: 'DELETE' });
    expect(res.status).toBe(409);
  });

  it('uploads versions, publishes them and submits the app for review', async () => {
    const { request } = dev();
    const created = await request('/v1/user-apps', json('POST', { code: 'board-app', name: 'Board' }));
    const { data: app } = (await created.json()) as { data: { id: string } };
    const versions = `/v1/user-apps/${app.id}/versions`;

    expect((await request(`/v1/user-apps/${app.id}/submit`, json('POST', {}))).status).toBe(400);
    expect((await request(versions, upload(undefined, [['index.html', '<html>']]))).status).toBe(400);
    expect((await request(versions, upload('{nope', [['index.html', '<html>']]))).status).toBe(400);
    const invalid = await request(versions, upload({ code: 'board-app' }, [['index.html', '<html>']]));
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { details: unknown } }).error.details).toBeTruthy();
    expect((await request(versions, upload(manifest('other-app', '1.0.0'), [['index.html', '<html>']]))).status).toBe(
      400,
    );
    expect((await request(versions, upload(manifest('board-app', '1.0.0'), []))).status).toBe(400);
    expect((await request(versions, upload(manifest('board-app', '1.0.0'), [['../escape.html', 'x']]))).status).toBe(
      400,
    );

    const first = await request(
      versions,
      upload(
        manifest('board-app', '1.0.0'),
        [
          ['index.html', '<html>'],
          ['./assets/app.js', 'console'],
        ],
        { changelog: 'First' },
      ),
    );
    expect(first.status).toBe(201);
    expect(((await first.json()) as { data: { status: string } }).data.status).toBe('published');
    expect((await request(versions, upload(manifest('board-app', '1.0.0'), [['index.html', 'x']]))).status).toBe(409);
    expect((await request(`/v1/user-apps/${app.id}`)).status).toBe(200);

    const submitted = await request(`/v1/user-apps/${app.id}/submit`, json('POST', { notes: 'Please review' }));
    expect(submitted.status).toBe(200);
    expect(((await submitted.json()) as { data: { reviewStatus: string } }).data.reviewStatus).toBe('submitted');

    // An approved public app's next version waits for review.
    const m = masterDb as unknown as import('drizzle-orm/pglite').PgliteDatabase<typeof masterSchema>;
    await m.update(masterSchema.userApps).set({ reviewStatus: 'approved' }).where(eq(masterSchema.userApps.id, app.id));
    const second = await request(versions, upload(manifest('board-app', '1.1.0'), [['index.html', '<html>v2']]));
    expect(second.status).toBe(201);
    expect(((await second.json()) as { data: { status: string } }).data.status).toBe('draft');
    const listed = (await (await request(versions)).json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(2);
    expect((await request('/v1/user-apps/uapp_missing/versions')).status).toBe(404);
  });

  it('registers and removes preview sessions', async () => {
    const { request } = dev();
    const created = await request('/v1/user-apps', json('POST', { code: 'preview-app', name: 'Preview' }));
    const { data: app } = (await created.json()) as { data: { id: string } };
    const path = `/v1/user-apps/${app.id}/dev-session`;
    expect((await request(path, json('PUT', { url: 'http://localhost:5173' }))).status).toBe(400);
    expect((await request(path, json('PUT', { url: 'https://evil.example.com', userId: 'user_dev' }))).status).toBe(400);
    expect((await request(path, json('PUT', { url: 'not a url' }))).status).toBe(400);
    const saved = await request(path, json('PUT', { url: 'http://localhost:5173', userId: 'user_dev' }));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { data: { url: string } }).data.url).toBe('http://localhost:5173');
    expect((await request(path, json('PUT', { url: 'http://127.0.0.1:5174', userId: 'user_dev' }))).status).toBe(200);
    expect((await request(path, { method: 'DELETE' })).status).toBe(400);
    expect((await request(`${path}?userId=user_dev`, { method: 'DELETE' })).status).toBe(204);
    expect((await request('/v1/user-apps/uapp_missing/dev-session?userId=u', { method: 'DELETE' })).status).toBe(404);
  });

  it('creates and rotates the OAuth client', async () => {
    const { request } = dev();
    const created = await request('/v1/user-apps', json('POST', { code: 'client-app', name: 'Client' }));
    const { data: app } = (await created.json()) as { data: { id: string } };
    const path = `/v1/user-apps/${app.id}/oauth-client`;
    expect((await request(path)).status).toBe(404);
    const first = await request(path, { method: 'POST' });
    expect(first.status).toBe(201);
    const { data: client } = (await first.json()) as { data: { clientId: string; clientSecret: string } };
    expect(client.clientSecret).toMatch(/^wacs_[0-9a-f]{40}$/);
    const read = await request(path);
    expect(((await read.json()) as { data: { clientId: string } }).data.clientId).toBe(client.clientId);
    const rotated = await request(path, { method: 'POST' });
    expect(rotated.status).toBe(200);
    expect((await request('/v1/user-apps/uapp_missing/oauth-client', { method: 'POST' })).status).toBe(404);
  });
});
