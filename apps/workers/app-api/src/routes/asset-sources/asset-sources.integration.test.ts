/**
 * /api/asset-sources against a real tenant schema (pglite): validation, the
 * write-only client secret, the one source per app registration, the test
 * endpoints against a stubbed Microsoft, starting an import (202 / 409), the
 * due index, delete cleaning up the mappings, entity events without the
 * secret, and the permission gate.
 *
 * The Microsoft stub answers by URL and method, never by call order.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { decryptField } from '@weldsuite/db/lib/crypto';
import { assetSourcesRoutes } from './index';

const KEY = 'ab'.repeat(32);
const SECRET = 'client-secret-very-secret';
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'cccccccc-2222-3333-4444-555555555555';
const MOUNT = '/api/asset-sources';
const ORG = 'org_test_default';
const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

let db: Database;
let d1: ReturnType<typeof createSqliteD1>;
const sent: Array<{ entityType: string; action: string; entityId: string; data: Record<string, unknown> }> = [];

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  sent.length = 0;
  d1 = createSqliteD1(MIGRATION);
  for (const table of [schema.integrationEntityMappings, schema.assetSources, schema.customObjects]) await db.delete(table);
  await db.insert(schema.customObjects).values({
    id: 'cobj_asset',
    slug: 'asset',
    entityKey: 'co_asset',
    labelSingular: 'Asset',
    labelPlural: 'Assets',
    status: 'active',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Result {
  status: number;
  body: { data?: any; error?: { code: string; message: string; details?: any } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
}

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp(MOUNT, assetSourcesRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['weldobjects:manage'])), tenantDb: db, userId: 'user_admin' },
    env: {
      DATABASE_ENCRYPTION_KEY: KEY,
      SCHEDULE_INDEX: d1,
      ENTITY_EVENTS: { send: async (m: (typeof sent)[number]) => void sent.push(m) },
    } as never,
  });
  const res = await request(`${MOUNT}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, text };
}

const valid = { name: 'Contoso Intune', config: { tenantId: TENANT, clientId: CLIENT }, secret: SECRET };

async function create(overrides: Record<string, unknown> = {}) {
  const res = await call('', { method: 'POST', body: { ...valid, ...overrides } });
  expect(res.status, res.text).toBe(201);
  return res.body.data as { id: string };
}

async function dueAt(): Promise<number | null> {
  const { results } = await (d1 as never as {
    prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
  })
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind('asset_import', ORG)
    .all<{ next_due_at: number }>();
  return results[0] ? Number(results[0].next_due_at) : null;
}

const flush = () => new Promise((r) => setTimeout(r, 5));

/** A Microsoft that accepts one secret and lists `devices`, answering by URL and method. */
function microsoft(options: { secret?: string; devices?: unknown[]; graphStatus?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'POST' && url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('client_secret') !== (options.secret ?? SECRET)) {
        return new Response(JSON.stringify({ error: 'invalid_client', error_codes: [7000215] }), { status: 401 });
      }
      return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'tok' }), { status: 200 });
    }
    if (method === 'GET' && url === 'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices') {
      if (options.graphStatus) return new Response('{}', { status: options.graphStatus });
      return new Response(JSON.stringify({ value: options.devices ?? [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  return calls;
}

describe('POST /', () => {
  it('creates a source due now, stores the secret encrypted and never returns it', async () => {
    const res = await call('', { method: 'POST', body: valid });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'intune',
      name: 'Contoso Intune',
      objectSlug: 'asset',
      config: { tenantId: TENANT, clientId: CLIENT },
      hasSecret: true,
      enabled: true,
      intervalHours: 24,
      lastStatus: null,
      lastSyncAt: null,
      lastError: null,
      lastErrorCode: null,
      lastStats: null,
      progress: null,
      createdById: 'user_admin',
    });
    expect(res.body.data.nextSyncAt).toBe(res.body.data.createdAt);
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain('secretEncrypted');
    expect(res.text).not.toContain('secret_encrypted');

    const [row] = await db.select().from(schema.assetSources).where(eq(schema.assetSources.id, res.body.data.id));
    expect(row!.secretEncrypted).not.toBe(SECRET);
    expect(await decryptField(row!.secretEncrypted!, { v1: KEY })).toBe(SECRET);

    // The workspace is marked due at the first import.
    await flush();
    expect(await dueAt()).toBe(Date.parse(res.body.data.nextSyncAt));
  });

  it('creates a paused source without marking the workspace due', async () => {
    const res = await call('', { method: 'POST', body: { ...valid, enabled: false, intervalHours: 6 } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ enabled: false, intervalHours: 6, nextSyncAt: null });
    await flush();
    expect(await dueAt()).toBeNull();
  });

  it('validates the body, including the tenant id and the interval', async () => {
    for (const body of [
      {},
      { ...valid, name: '' },
      { ...valid, secret: '' },
      { ...valid, type: 'jamf' },
      { ...valid, config: { tenantId: 'a/../b', clientId: CLIENT } },
      { ...valid, config: { tenantId: TENANT, clientId: '' } },
      { ...valid, intervalHours: 0 },
      { ...valid, intervalHours: 169 },
      { ...valid, intervalHours: 1.5 },
    ]) {
      expect((await call('', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(await db.select().from(schema.assetSources)).toHaveLength(0);
  });

  it('answers 409 asset_register_missing when the asset object is not installed', async () => {
    await db.delete(schema.customObjects);
    const res = await call('', { method: 'POST', body: valid });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('asset_register_missing');
    expect(await db.select().from(schema.assetSources)).toHaveLength(0);
  });

  it('allows one source per tenant and client id, whatever the case', async () => {
    await create();
    const again = await call('', { method: 'POST', body: { ...valid, name: 'Again', config: { tenantId: TENANT.toUpperCase(), clientId: CLIENT } } });
    expect(again.status).toBe(409);
    expect(again.body.error?.details).toEqual({ code: 'duplicate_source' });
    expect((await call('', { method: 'POST', body: { ...valid, name: 'Other app', config: { tenantId: TENANT, clientId: 'dddddddd-2222-3333-4444-555555555555' } } })).status).toBe(201);
  });

  it('publishes an asset_source created event without the secret', async () => {
    const { id } = await create();
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ entityType: 'asset_source', action: 'created', entityId: id });
    expect(sent[0]!.data).toMatchObject({ hasSecret: true, name: 'Contoso Intune' });
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(JSON.stringify(sent)).not.toContain('ecretEncrypted');
  });
});

describe('GET', () => {
  it('lists the sources oldest first and gets one, with no secret', async () => {
    const a = await create({ name: 'A' });
    const b = await create({ name: 'B', config: { tenantId: TENANT, clientId: 'dddddddd-2222-3333-4444-555555555555' } });
    const res = await call('');
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([a.id, b.id]);
    expect(res.text).not.toContain(SECRET);
    expect((await call(`/${a.id}`)).body.data).toMatchObject({ id: a.id, name: 'A', hasSecret: true });
    expect((await call('/asrc_nope')).status).toBe(404);
  });

  it('shows the progress of a running import and the last failure with its code', async () => {
    const { id } = await create();
    await db
      .update(schema.assetSources)
      .set({
        lastStatus: 'running',
        syncState: { startedAt: '2026-11-10T08:00:00.000Z', nextLink: null, offset: 3, stats: { total: 3, created: 2, updated: 1, unchanged: 0, failed: 0 }, startedById: 'user_admin' },
      })
      .where(eq(schema.assetSources.id, id));
    expect((await call(`/${id}`)).body.data).toMatchObject({
      lastStatus: 'running',
      progress: { startedAt: '2026-11-10T08:00:00.000Z', stats: { total: 3, created: 2, updated: 1 }, startedById: 'user_admin' },
    });

    await db
      .update(schema.assetSources)
      .set({ lastStatus: 'failed', syncState: null, lastError: 'permission_missing: Microsoft refused access.' })
      .where(eq(schema.assetSources.id, id));
    expect((await call(`/${id}`)).body.data).toMatchObject({
      lastStatus: 'failed',
      lastError: 'Microsoft refused access.',
      lastErrorCode: 'permission_missing',
      progress: null,
    });
  });
});

describe('PATCH /:id', () => {
  it('renames, changes the schedule and replaces the secret', async () => {
    const { id } = await create();
    const res = await call(`/${id}`, { method: 'PATCH', body: { name: 'Renamed', intervalHours: 6, secret: 'new-secret' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', intervalHours: 6, hasSecret: true });
    expect(res.text).not.toContain('new-secret');
    const [row] = await db.select().from(schema.assetSources).where(eq(schema.assetSources.id, id));
    expect(await decryptField(row!.secretEncrypted!, { v1: KEY })).toBe('new-secret');
  });

  it('keeps the secret when none is sent', async () => {
    const { id } = await create();
    await call(`/${id}`, { method: 'PATCH', body: { name: 'x' } });
    const [row] = await db.select().from(schema.assetSources).where(eq(schema.assetSources.id, id));
    expect(await decryptField(row!.secretEncrypted!, { v1: KEY })).toBe(SECRET);
  });

  it('turns the schedule off and on: no next import, then one interval after the last', async () => {
    const { id } = await create();
    const off = await call(`/${id}`, { method: 'PATCH', body: { enabled: false } });
    expect(off.body.data).toMatchObject({ enabled: false, nextSyncAt: null });

    await db.update(schema.assetSources).set({ lastSyncAt: new Date('2026-11-10T08:00:00.000Z') }).where(eq(schema.assetSources.id, id));
    const on = await call(`/${id}`, { method: 'PATCH', body: { enabled: true, intervalHours: 12 } });
    expect(on.body.data.nextSyncAt).toBe('2026-11-10T20:00:00.000Z');
    await flush();
    expect(await dueAt()).toBe(Date.parse('2026-11-10T20:00:00.000Z'));
  });

  it('needs a new secret when the tenant or application changes, and refuses a duplicate', async () => {
    const { id } = await create();
    const other = { tenantId: TENANT, clientId: 'dddddddd-2222-3333-4444-555555555555' };
    const withoutSecret = await call(`/${id}`, { method: 'PATCH', body: { config: other } });
    expect(withoutSecret.status).toBe(400);
    expect(withoutSecret.body.error?.details).toEqual({ field: 'secret' });

    const moved = await call(`/${id}`, { method: 'PATCH', body: { config: other, secret: 'for-the-other-app' } });
    expect(moved.status).toBe(200);
    expect(moved.body.data.config).toEqual(other);

    const second = await create({ name: 'Second' });
    const clash = await call(`/${second.id}`, { method: 'PATCH', body: { config: other, secret: 's' } });
    expect(clash.status).toBe(409);
  });

  it('answers 404 for an unknown source and 400 for a bad body', async () => {
    expect((await call('/asrc_nope', { method: 'PATCH', body: { name: 'x' } })).status).toBe(404);
    const { id } = await create();
    expect((await call(`/${id}`, { method: 'PATCH', body: { intervalHours: 500 } })).status).toBe(400);
    expect((await call(`/${id}`, { method: 'PATCH', body: { name: '' } })).status).toBe(400);
  });

  it('publishes an updated event without the secret', async () => {
    const { id } = await create();
    sent.length = 0;
    await call(`/${id}`, { method: 'PATCH', body: { secret: 'new-secret' } });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ entityType: 'asset_source', action: 'updated', entityId: id });
    expect(JSON.stringify(sent)).not.toContain('new-secret');
  });
});

describe('POST /test and POST /:id/test', () => {
  it('tries an unsaved connection and reports the device count of the first page', async () => {
    const calls = microsoft();
    const res = await call('/test', { method: 'POST', body: { config: valid.config, secret: SECRET } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, deviceCount: 3 });
    expect(calls).toEqual([
      `POST https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      'GET https://graph.microsoft.com/v1.0/deviceManagement/managedDevices',
    ]);
    expect(await db.select().from(schema.assetSources)).toHaveLength(0);
  });

  it('answers 200 with the code and message when Microsoft refuses', async () => {
    microsoft({ secret: 'something-else' });
    const res = await call('/test', { method: 'POST', body: { config: valid.config, secret: SECRET } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: false, code: 'invalid_secret' });
    expect(res.body.data.message).toContain('secret');
    expect(res.text).not.toContain(SECRET);

    microsoft({ graphStatus: 403 });
    const denied = await call('/test', { method: 'POST', body: { config: valid.config, secret: SECRET } });
    expect(denied.body.data).toMatchObject({ ok: false, code: 'permission_missing' });
  });

  it('validates the unsaved connection', async () => {
    microsoft();
    expect((await call('/test', { method: 'POST', body: { config: { tenantId: 'x/y', clientId: 'c' }, secret: 's' } })).status).toBe(400);
    expect((await call('/test', { method: 'POST', body: {} })).status).toBe(400);
  });

  it('tries the saved connection with the stored secret, or a replacement, and saves nothing', async () => {
    const { id } = await create();
    microsoft();
    expect((await call(`/${id}/test`, { method: 'POST', body: {} })).body.data).toEqual({ ok: true, deviceCount: 3 });
    // No body at all works too.
    expect((await call(`/${id}/test`, { method: 'POST' })).body.data).toMatchObject({ ok: true });

    microsoft({ secret: 'replacement' });
    expect((await call(`/${id}/test`, { method: 'POST', body: { secret: 'replacement' } })).body.data).toMatchObject({ ok: true });
    expect((await call(`/${id}/test`, { method: 'POST', body: {} })).body.data).toMatchObject({ ok: false, code: 'invalid_secret' });

    const [row] = await db.select().from(schema.assetSources).where(eq(schema.assetSources.id, id));
    expect(await decryptField(row!.secretEncrypted!, { v1: KEY })).toBe(SECRET);
  });

  it('answers 404 for an unknown source', async () => {
    expect((await call('/asrc_nope/test', { method: 'POST', body: {} })).status).toBe(404);
  });
});

describe('POST /:id/sync', () => {
  it('starts an import, answers 202 with the progress and marks the workspace due now', async () => {
    const { id } = await create({ enabled: false });
    const before = Date.now();
    const res = await call(`/${id}/sync`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      id,
      lastStatus: 'running',
      progress: { stats: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 }, startedById: 'user_admin' },
    });
    await flush();
    expect(await dueAt()).toBeGreaterThanOrEqual(before - 1000);
    expect(sent.at(-1)).toMatchObject({ entityType: 'asset_source', action: 'updated', entityId: id });
  });

  it('answers 409 already_running while one is under way', async () => {
    const { id } = await create();
    expect((await call(`/${id}/sync`, { method: 'POST' })).status).toBe(202);
    const again = await call(`/${id}/sync`, { method: 'POST' });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('already_running');
  });

  it('answers 404 for an unknown source', async () => {
    expect((await call('/asrc_nope/sync', { method: 'POST' })).status).toBe(404);
  });
});

describe('DELETE /:id', () => {
  it('removes the source and its mappings, and leaves the asset records', async () => {
    const { id } = await create();
    const other = await create({ name: 'Other', config: { tenantId: TENANT, clientId: 'dddddddd-2222-3333-4444-555555555555' } });
    await db.insert(schema.customObjectRecords).values({ id: 'cor_keep', objectId: 'cobj_asset', entityKey: 'co_asset', title: 'Laptop', ownerId: 'u', createdBy: 'u', updatedBy: 'u' });
    await db.insert(schema.integrationEntityMappings).values([
      { id: 'iem_1', connectionId: id, externalEntityType: 'intune_device', externalEntityId: 'dev-1', internalEntityType: 'co_asset', internalEntityId: 'cor_keep' },
      { id: 'iem_2', connectionId: other.id, externalEntityType: 'intune_device', externalEntityId: 'dev-1', internalEntityType: 'co_asset', internalEntityId: 'cor_keep' },
    ]);
    sent.length = 0;

    const res = await call(`/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await call(`/${id}`)).status).toBe(404);
    expect((await db.select().from(schema.integrationEntityMappings)).map((m) => m.id)).toEqual(['iem_2']);
    expect(await db.select().from(schema.customObjectRecords).where(eq(schema.customObjectRecords.id, 'cor_keep'))).toHaveLength(1);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ entityType: 'asset_source', action: 'deleted', entityId: id });
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it('answers 404 for an unknown source', async () => {
    expect((await call('/asrc_nope', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('permissions', () => {
  it('refuses every route without weldobjects:manage, the reads included', async () => {
    const { id } = await create();
    const perms = ['weldobjects:read', 'general:update', 'weldcrm:read'];
    const calls: [string, string, unknown?][] = [
      ['GET', ''],
      ['GET', `/${id}`],
      ['POST', '', valid],
      ['PATCH', `/${id}`, { name: 'x' }],
      ['DELETE', `/${id}`],
      ['POST', '/test', { config: valid.config, secret: SECRET }],
      ['POST', `/${id}/test`, {}],
      ['POST', `/${id}/sync`, {}],
    ];
    for (const [method, path, body] of calls) {
      expect((await call(path, { method, body, perms })).status, `${method} ${path}`).toBe(403);
    }
    expect(await db.select().from(schema.assetSources)).toHaveLength(1);
  });
});
