/**
 * Tests for the secret keys under /api/panel/projects/:id/keys, on a real
 * tenant and master schema (pglite) with an in-memory KV.
 *
 * What must not regress:
 *   1. The key is shown once (`wps_` + 32 hex); only its SHA-256 reaches the
 *      master registry, and the collector's KV record carries ids and the
 *      project's status, never the key.
 *   2. Revoking deletes the KV record at once, and is safe to repeat.
 *   3. A paused project's keys carry `status: 'paused'` in KV (the collector
 *      drops them), resuming restores it, deleting the project removes the
 *      records, and a revoked key is never brought back by any of it.
 *   4. `panel_projects:manage` for everything; keys of another project or
 *      workspace are a 404 and untouched.
 *   5. Created and revoked keys publish `panel_key` events without the key.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { keyKvKey, parseKeyRecord } from '@weldsuite/panel-domain/registry';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelCreatedKeyDto, PanelKeyDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { MAX_ACTIVE_KEYS, sha256Hex } from '../services/keys';
import { entityQueue, memoryKv } from '../test-support/fakes';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master as never };
});

import keysRoutes from './keys';
import projectsRoutes from './projects';

const { panelProjects } = schema;
const { panelKeyRegistry, panelProjectRegistry } = masterSchema;

const MANAGE = ['panel_projects:read', 'panel_projects:create', 'panel_projects:update', 'panel_projects:delete', 'panel_projects:manage'];
const NO_MANAGE = ['panel_projects:read', 'panel_projects:update'];

const KEYS = '/api/panel/projects/:id/keys';
const url = (projectId: string, rest = '') => `/api/panel/projects/${projectId}/keys${rest}`;

let db: Database;
let master: AnyMasterDatabase;
let events: EntityEventMessage[] = [];
let store: Map<string, string>;
let failKvPut = false;

function context(workspaceId = 'ws_alpha') {
  return { tenantDb: db, masterDb: master as unknown as Database, userId: 'user_alice', orgId: 'org_x', workspaceId, clerkOrgId: 'org_x' };
}

function env() {
  const kv = memoryKv(store);
  const put = kv.put.bind(kv);
  kv.put = (async (key: string, value: string) => {
    if (failKvPut) throw new Error('kv unavailable');
    return put(key, value);
  }) as KVNamespace['put'];
  return { WORKSPACE_CACHE: kv, ENTITY_EVENTS: entityQueue(events), PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org' };
}

const keys = (grants: string[] = MANAGE, workspaceId?: string) =>
  createTestApp(KEYS, keysRoutes, { context: { permissions: permissions(...grants), ...context(workspaceId) }, env: env() as never, moduleApiErrors: true });
const projects = (grants: string[] = MANAGE) =>
  createTestApp('/api/panel/projects', projectsRoutes, { context: { permissions: permissions(...grants), ...context() }, env: env() as never, moduleApiErrors: true });

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function newKey(name = 'Backend', projectId = 'pnp_a') {
  const res = await keys().request(url(projectId), json({ name }));
  expect(res.status).toBe(201);
  return data<PanelCreatedKeyDto>(res);
}

const record = async (key: string) => parseKeyRecord(store.get(keyKvKey(await sha256Hex(key))) ?? null);

async function project(id = 'pnp_a') {
  const res = await projects().request(`/api/panel/projects/${id}`);
  return data<PanelProjectDto>(res);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  await db.delete(panelProjects);
  await master.delete(panelKeyRegistry);
  await master.delete(panelProjectRegistry);
  await db.insert(panelProjects).values([
    { id: 'pnp_a', name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' },
    { id: 'pnp_b', name: 'Docs', token: 'wpk_b', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' },
  ]);
  store = new Map();
  events = [];
  failKvPut = false;
});

describe('create', () => {
  it('returns the whole key once, stores only its hash, and registers it with the collector', async () => {
    const res = await keys().request(url('pnp_a'), json({ name: ' Backend ' }));
    expect(res.status).toBe(201);
    const created = await data<PanelCreatedKeyDto>(res);

    expect(created.key).toMatch(/^wps_[0-9a-f]{32}$/);
    expect(created).toMatchObject({ projectId: 'pnp_a', name: 'Backend', createdByUserId: 'user_alice', revokedAt: null, lastUsedAt: null });
    expect(created.prefix).toBe(`${created.key.slice(0, 8)}…`);

    const [row] = await master.select().from(panelKeyRegistry);
    expect(row).toMatchObject({ id: created.id, workspaceId: 'ws_alpha', projectId: 'pnp_a', keyHash: await sha256Hex(created.key), keyPrefix: created.key.slice(0, 8) });
    expect(JSON.stringify(row)).not.toContain(created.key);

    expect(await record(created.key)).toEqual({ v: 1, keyId: created.id, workspaceId: 'ws_alpha', projectId: 'pnp_a', status: 'active' });
    expect([...store.values()].join()).not.toContain(created.key);
  });

  it('never lists the key again', async () => {
    const created = await newKey();
    const res = await keys().request(url('pnp_a'));
    const body = (await res.json()) as { data: PanelKeyDto[] };
    expect(body.data.map((k) => k.id)).toEqual([created.id]);
    expect(JSON.stringify(body)).not.toContain(created.key);
    expect('key' in (body.data[0] ?? {})).toBe(false);
  });

  it('publishes a panel_key event without the key', async () => {
    const created = await newKey();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityType: 'panel_key', action: 'created', entityId: created.id });
    expect(events[0]?.data).toEqual({ id: created.id, projectId: 'pnp_a', name: 'Backend', prefix: created.prefix });
    expect(JSON.stringify(events)).not.toContain(created.key);
  });

  it('writes a key record that says paused when the project already is', async () => {
    await projects().request('/api/panel/projects/pnp_a/settings', json({ status: 'paused' }, 'PATCH'));
    const created = await newKey();
    expect((await record(created.key))?.status).toBe('paused');
  });

  it('needs panel_projects:manage, a name, and a project of this workspace', async () => {
    expect((await keys(NO_MANAGE).request(url('pnp_a'), json({ name: 'x' }))).status).toBe(403);
    expect((await keys(NO_MANAGE).request(url('pnp_a'))).status).toBe(403);
    expect((await keys().request(url('pnp_a'), json({ name: ' ' }))).status).toBe(400);
    expect((await keys().request(url('pnp_zzz'), json({ name: 'x' }))).status).toBe(404);
    expect((await keys().request(url('pnp_zzz'))).status).toBe(404);
    expect(await master.select().from(panelKeyRegistry)).toHaveLength(0);
  });

  it('holds at most 20 active keys; a revoked one frees a place', async () => {
    const first = await newKey('k0');
    for (let i = 1; i < MAX_ACTIVE_KEYS; i += 1) await newKey(`k${i}`);
    expect((await keys().request(url('pnp_a'), json({ name: 'one too many' }))).status).toBe(409);
    expect((await keys().request(url('pnp_b'), json({ name: 'other project' }))).status).toBe(201);

    await keys().request(url('pnp_a', `/${first.id}`), { method: 'DELETE' });
    expect((await keys().request(url('pnp_a'), json({ name: 'again' }))).status).toBe(201);
  });

  it('leaves no key behind when the collector could not be told', async () => {
    failKvPut = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await keys().request(url('pnp_a'), json({ name: 'Backend' }));
    expect(res.status).toBe(500);
    expect(await master.select().from(panelKeyRegistry)).toHaveLength(0);
    expect(events).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe('revoke', () => {
  it('stamps revokedAt and takes the key out of KV at once, keeping the row listed', async () => {
    const created = await newKey();
    const res = await keys().request(url('pnp_a', `/${created.id}`), { method: 'DELETE' });
    expect(res.status).toBe(204);

    expect(await record(created.key)).toBeNull();
    const [row] = await master.select().from(panelKeyRegistry);
    expect(row?.revokedAt).toBeInstanceOf(Date);

    const list = (await (await keys().request(url('pnp_a'))).json()) as { data: PanelKeyDto[] };
    expect(list.data[0]?.revokedAt).not.toBeNull();
    expect(events.map((e) => [e.entityType, e.action])).toEqual([['panel_key', 'created'], ['panel_key', 'deleted']]);
  });

  it('is safe to repeat and repeats the KV delete', async () => {
    const created = await newKey();
    await keys().request(url('pnp_a', `/${created.id}`), { method: 'DELETE' });
    store.set(keyKvKey(await sha256Hex(created.key)), JSON.stringify({ v: 1, keyId: created.id, workspaceId: 'ws_alpha', projectId: 'pnp_a' }));
    expect((await keys().request(url('pnp_a', `/${created.id}`), { method: 'DELETE' })).status).toBe(204);
    expect(await record(created.key)).toBeNull();
    const [row] = await master.select().from(panelKeyRegistry);
    expect(row?.revokedAt).toBeInstanceOf(Date);
  });

  it('is a 404 for a key of another project or workspace, and leaves it working', async () => {
    const created = await newKey();
    expect((await keys().request(url('pnp_b', `/${created.id}`), { method: 'DELETE' })).status).toBe(404);
    expect((await keys(MANAGE, 'ws_beta').request(url('pnp_a', `/${created.id}`), { method: 'DELETE' })).status).toBe(404);
    expect((await keys().request(url('pnp_a', '/pnk_nope'), { method: 'DELETE' })).status).toBe(404);
    expect(await record(created.key)).not.toBeNull();
    expect((await keys(NO_MANAGE).request(url('pnp_a', `/${created.id}`), { method: 'DELETE' })).status).toBe(403);
  });

  it('does not list another workspace’s keys', async () => {
    await newKey();
    const other = (await (await keys(MANAGE, 'ws_beta').request(url('pnp_a'))).json()) as { data: PanelKeyDto[] };
    expect(other.data).toEqual([]);
  });
});

describe('the project’s status reaches its keys', () => {
  const pause = (status: 'paused' | 'active', id = 'pnp_a') =>
    projects().request(`/api/panel/projects/${id}/settings`, json({ status }, 'PATCH'));

  it('pausing rewrites every active key record with status paused, resuming restores it', async () => {
    const one = await newKey('one');
    const two = await newKey('two');
    expect((await record(one.key))?.status).toBe('active');

    expect((await pause('paused')).status).toBe(200);
    expect((await record(one.key))?.status).toBe('paused');
    expect((await record(two.key))?.status).toBe('paused');
    // Same ids, same project: only the status moved.
    expect(await record(one.key)).toMatchObject({ keyId: one.id, workspaceId: 'ws_alpha', projectId: 'pnp_a' });

    expect((await pause('active')).status).toBe(200);
    expect((await record(one.key))?.status).toBe('active');
    expect((await record(two.key))?.status).toBe('active');
  });

  it('leaves other projects’ keys and revoked keys alone', async () => {
    const mine = await newKey('mine');
    const revoked = await newKey('revoked');
    const other = await newKey('other', 'pnp_b');
    await keys().request(url('pnp_a', `/${revoked.id}`), { method: 'DELETE' });

    await pause('paused');
    expect((await record(mine.key))?.status).toBe('paused');
    expect((await record(other.key))?.status).toBe('active');
    // Pausing and resuming never brings a revoked key back.
    expect(await record(revoked.key)).toBeNull();
    await pause('active');
    expect(await record(revoked.key)).toBeNull();
  });

  it('a settings change that does not touch the status does not rewrite the records', async () => {
    const created = await newKey();
    store.delete(keyKvKey(await sha256Hex(created.key)));
    await projects().request('/api/panel/projects/pnp_a/settings', json({ settings: { autocapture: false } }, 'PATCH'));
    expect(await record(created.key)).toBeNull();
  });

  it('deleting the project removes its keys’ records, and deleting again repeats that', async () => {
    const created = await newKey();
    const other = await newKey('other', 'pnp_b');
    expect((await projects().request('/api/panel/projects/pnp_a', { method: 'DELETE' })).status).toBe(204);
    expect(await record(created.key)).toBeNull();
    expect(await record(other.key)).not.toBeNull();
    expect((await project('pnp_b')).id).toBe('pnp_b');

    // A repeated delete re-clears what a failed first attempt left.
    store.set(keyKvKey(await sha256Hex(created.key)), JSON.stringify({ v: 1, keyId: created.id, workspaceId: 'ws_alpha', projectId: 'pnp_a' }));
    expect((await projects().request('/api/panel/projects/pnp_a', { method: 'DELETE' })).status).toBe(404);
    expect(await record(created.key)).toBeNull();
    const [row] = await master.select().from(panelKeyRegistry).where(eq(panelKeyRegistry.id, created.id));
    expect(row?.revokedAt).toBeNull();
  });
});
