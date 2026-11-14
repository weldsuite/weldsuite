/**
 * Tests for /api/panel/heatmaps (page groups and the snapshot) and
 * /api/panel/live. Real tenant schema (pglite), fake Basin, object, R2 and KV.
 *
 * What must not regress:
 *   1. Page group changes publish `panel_heatmap_page` events; deleting one
 *      removes its stored snapshots and a pending request for it.
 *   2. The snapshot needs `panel_recordings:read` (it is what a visitor saw).
 *   3. Order of resolution: the stored snapshot, else a recent recording's full
 *      snapshot (cut out of its chunk, in the shape `/snap` stores), else a KV
 *      request for the next visitor with a TTL and a 404 `SNAPSHOT_REQUESTED`.
 *   4. A recording is only used through keys of this workspace and project, and
 *      the visit statement is scoped.
 *   5. The live view names visitors only for `panel_people:read`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import { heatmapSnapshotKey } from '@weldsuite/panel-domain/replays';
import { parseSnapshotRequest, snapshotRequestKvKey } from '@weldsuite/panel-domain/registry';
import type { PanelHeatmapPageDto, PanelLiveDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { pickSnapshotChunks } from '../services/heatmaps';
import {
  BASIN_ENV,
  FakeBasin,
  FakeProjectState,
  PROJECT,
  WORKSPACE,
  chunkKey,
  entityQueue,
  gunzipText,
  gzipBytes,
  replaysBucket,
} from '../test-support/fakes';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master as never };
});

import heatmapRoutes from './heatmaps';
import liveRoutes from './live';

const { panelProjects, panelHeatmapPages } = schema;

const MANAGE = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const WATCH = ['panel_recordings:read'];
const BASE = '/api/panel/heatmaps';

let db: Database;
let master: AnyMasterDatabase;
let events: EntityEventMessage[] = [];
let bucket: R2Bucket;
let kvStore: Map<string, string>;
let kvPuts: { key: string; options: unknown }[] = [];
const basin = new FakeBasin();
const object = new FakeProjectState();

function kv(): KVNamespace {
  return {
    get: async (key: string, type?: unknown) => {
      const value = kvStore.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string, options?: unknown) => {
      kvPuts.push({ key, options });
      kvStore.set(key, value);
    },
    delete: async (key: string) => void kvStore.delete(key),
  } as unknown as KVNamespace;
}

function app(mount: string, router: typeof heatmapRoutes, grants: string[], env: Record<string, unknown> = {}) {
  return createTestApp(mount, router, {
    context: { permissions: permissions(...grants), tenantDb: db, userId: 'user_alice', orgId: 'org_alpha', workspaceId: WORKSPACE, clerkOrgId: 'org_alpha' },
    env: {
      WORKSPACE_CACHE: kv(),
      ENTITY_EVENTS: entityQueue(events),
      PANEL_PROJECT: object.namespace(),
      PANEL_REPLAYS: bucket,
      PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org',
      ...BASIN_ENV,
      ...env,
    } as never,
    moduleApiErrors: true,
  });
}

const heatmaps = (grants: string[] = MANAGE, env?: Record<string, unknown>) => app(BASE, heatmapRoutes, grants, env);
const live = (grants: string[], env?: Record<string, unknown>) => app('/api/panel/live', liveRoutes, grants, env);

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function addPage(id = 'pnh_1', pattern = '/products/*') {
  await db.insert(panelHeatmapPages).values({ id, projectId: PROJECT, name: 'Products', urlPattern: pattern, createdByUserId: 'user_alice' });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelHeatmapPages, panelProjects]) await db.delete(table);
  await db.insert(panelProjects).values({ id: PROJECT, name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  events = [];
  kvStore = new Map();
  kvPuts = [];
  bucket = replaysBucket();
  basin.reset();
  basin.install();
  object.reset();
});

afterEach(() => vi.unstubAllGlobals());

describe('heatmap page groups', () => {
  it('creates, lists, renames and deletes, publishing an event each time', async () => {
    const created = await heatmaps().request(`${BASE}/pages`, json({ projectId: PROJECT, name: 'Products', urlPattern: '/products/*' }));
    expect(created.status).toBe(201);
    const page = await data<PanelHeatmapPageDto>(created);
    expect(page).toMatchObject({ projectId: PROJECT, name: 'Products', urlPattern: '/products/*', createdByUserId: 'user_alice' });

    const list = (await (await heatmaps().request(`${BASE}/pages?projectId=${PROJECT}`)).json()) as { data: PanelHeatmapPageDto[]; pagination: { totalCount: number } };
    expect(list.data.map((p) => p.id)).toEqual([page.id]);

    const renamed = await heatmaps().request(`${BASE}/pages/${page.id}`, json({ urlPattern: '/shop/*' }, 'PATCH'));
    expect((await data<PanelHeatmapPageDto>(renamed)).urlPattern).toBe('/shop/*');

    expect((await heatmaps().request(`${BASE}/pages/${page.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await db.select().from(panelHeatmapPages)).toHaveLength(0);

    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_heatmap_page', 'created'],
      ['panel_heatmap_page', 'updated'],
      ['panel_heatmap_page', 'deleted'],
    ]);
    expect(events[0]?.data).toMatchObject({ id: page.id, projectId: PROJECT, urlPattern: '/products/*' });
  });

  it('checks the permissions and the input', async () => {
    const body = json({ projectId: PROJECT, name: 'Products', urlPattern: '/products/*' });
    expect((await heatmaps(['panel_reports:read']).request(`${BASE}/pages`, body)).status).toBe(403);
    expect((await heatmaps([]).request(`${BASE}/pages?projectId=${PROJECT}`)).status).toBe(403);
    expect((await heatmaps(['panel_reports:read']).request(`${BASE}/pages/pnh_1`, json({ name: 'x' }, 'PATCH'))).status).toBe(403);
    expect((await heatmaps(['panel_reports:read']).request(`${BASE}/pages/pnh_1`, { method: 'DELETE' })).status).toBe(403);
    expect((await heatmaps().request(`${BASE}/pages`, json({ projectId: PROJECT, name: 'x', urlPattern: 'no-slash' }))).status).toBe(400);
    expect((await heatmaps().request(`${BASE}/pages`, json({ projectId: 'pnp_zzz', name: 'x', urlPattern: '/a' }))).status).toBe(404);
    expect((await heatmaps().request(`${BASE}/pages/pnh_nope`, json({ name: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await heatmaps().request(`${BASE}/pages/pnh_nope`, { method: 'DELETE' })).status).toBe(404);
    expect(events).toEqual([]);
  });

  it('deleting a page group removes its stored snapshots and its pending request, not another group’s', async () => {
    await addPage('pnh_1');
    await addPage('pnh_2', '/blog/*');
    const key = (id: string, deviceClass: 'desktop' | 'mobile') => heatmapSnapshotKey({ workspaceId: WORKSPACE, projectId: PROJECT, pageGroupId: id, deviceClass });
    await bucket.put(key('pnh_1', 'desktop'), new Uint8Array([1]));
    await bucket.put(key('pnh_1', 'mobile'), new Uint8Array([1]));
    await bucket.put(key('pnh_2', 'desktop'), new Uint8Array([1]));
    kvStore.set(snapshotRequestKvKey(PROJECT), JSON.stringify({ pageGroupId: 'pnh_1', urlPattern: '/products/*', deviceClass: 'desktop' }));

    await heatmaps().request(`${BASE}/pages/pnh_1`, { method: 'DELETE' });
    expect((await bucket.list()).objects.map((o) => o.key)).toEqual([key('pnh_2', 'desktop')]);
    expect(kvStore.has(snapshotRequestKvKey(PROJECT))).toBe(false);

    kvStore.set(snapshotRequestKvKey(PROJECT), JSON.stringify({ pageGroupId: 'pnh_2', urlPattern: '/blog/*', deviceClass: 'desktop' }));
    await addPage('pnh_3');
    await heatmaps().request(`${BASE}/pages/pnh_3`, { method: 'DELETE' });
    expect(kvStore.has(snapshotRequestKvKey(PROJECT))).toBe(true);
  });
});

describe('GET /heatmaps/pages/:id/snapshot', () => {
  const snapshotKey = heatmapSnapshotKey({ workspaceId: WORKSPACE, projectId: PROJECT, pageGroupId: 'pnh_1', deviceClass: 'desktop' });
  const url = `${BASE}/pages/pnh_1/snapshot?deviceClass=desktop`;
  const FULL = { type: 2, data: { node: { id: 1 } }, timestamp: 1 };

  beforeEach(async () => {
    await addPage('pnh_1');
  });

  /** Basin knows one visit to the page group at 10:00 and its full-snapshot chunk, which also holds a meta and an incremental event. */
  async function knowRecording() {
    basin.on(/AS visited_at/, [{ session_id: 'ses_1', visited_at: '2026-11-10 10:00:05' }]);
    basin.on(/has_full_snapshot = true/, [
      { session_id: 'ses_1', ts_start: '2026-11-10 10:00:00', r2_key: chunkKey(0) },
      // Taken after the visit began: not the page the heatmap is about.
      { session_id: 'ses_1', ts_start: '2026-11-10 10:30:00', r2_key: chunkKey(3) },
    ]);
    await bucket.put(chunkKey(0), await gzipBytes(JSON.stringify([{ type: 4, data: { width: 1200, height: 800 } }, FULL, { type: 3, data: {} }])));
    await bucket.put(chunkKey(3), await gzipBytes(JSON.stringify([{ type: 2, data: 'later' }])));
  }

  it('needs panel_recordings:read', async () => {
    expect((await heatmaps(['panel_reports:read']).request(url)).status).toBe(403);
    expect((await heatmaps(WATCH).request(`${BASE}/pages/pnh_1/snapshot`)).status).toBe(400);
    expect((await heatmaps(WATCH).request(`${BASE}/pages/pnh_1/snapshot?deviceClass=watch`)).status).toBe(400);
    expect((await heatmaps(WATCH).request(`${BASE}/pages/pnh_nope/snapshot?deviceClass=desktop`)).status).toBe(404);
  });

  it('serves the stored snapshot as gzip without looking anywhere else', async () => {
    await bucket.put(snapshotKey, await gzipBytes(JSON.stringify(FULL)));
    const res = await heatmaps(WATCH).request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('x-snapshot-source')).toBe('stored');
    expect(JSON.parse(await gunzipText(await res.arrayBuffer()))).toEqual(FULL);
    expect(basin.sent).toHaveLength(0);
  });

  it('is per device class', async () => {
    await bucket.put(snapshotKey, await gzipBytes(JSON.stringify(FULL)));
    const mobile = await heatmaps(WATCH).request(`${BASE}/pages/pnh_1/snapshot?deviceClass=mobile`);
    expect(mobile.status).toBe(404);
  });

  it('falls back to the full snapshot of a recent recording of the page group, cut out of its chunk', async () => {
    await knowRecording();
    const res = await heatmaps(WATCH).request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-snapshot-source')).toBe('recording');
    // Just the FullSnapshot event, the shape POST /snap stores; the chunk taken after the visit began is not used.
    expect(JSON.parse(await gunzipText(await res.arrayBuffer()))).toEqual(FULL);
    // Nothing is stored or requested by a look.
    expect((await bucket.list()).objects.map((o) => o.key)).not.toContain(snapshotKey);
    expect(kvStore.has(snapshotRequestKvKey(PROJECT))).toBe(false);
  });

  it('scopes the search to the workspace and project, and to the page group and device class', async () => {
    await knowRecording();
    await heatmaps(WATCH).request(`${BASE}/pages/pnh_1/snapshot?deviceClass=mobile`);
    expect(basin.sent).toHaveLength(2);
    for (const sql of basin.sent) {
      expect(sql).toContain(`workspace_id = '${WORKSPACE}'`);
      expect(sql).toContain(`project_id = '${PROJECT}'`);
    }
    expect(basin.sent[0]).toContain("LIKE '/products/%' ESCAPE '!'");
    expect(basin.sent[0]).toContain('e.viewport_w < 768');
  });

  it('never opens a recording whose key belongs to another workspace', async () => {
    basin.on(/AS visited_at/, [{ session_id: 'ses_1', visited_at: '2026-11-10 10:00:05' }]);
    basin.on(/has_full_snapshot = true/, [{ session_id: 'ses_1', ts_start: '2026-11-10 10:00:00', r2_key: chunkKey(0, 'ses_1', { ws: 'ws_other' }) }]);
    await bucket.put(chunkKey(0, 'ses_1', { ws: 'ws_other' }), await gzipBytes(JSON.stringify([FULL])));
    const res = await heatmaps(WATCH).request(url);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'SNAPSHOT_REQUESTED' } });
  });

  it('asks the next visitor when there is no recording: a KV request with a TTL and a 404', async () => {
    const res = await heatmaps(WATCH).request(url);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SNAPSHOT_REQUESTED');
    expect(parseSnapshotRequest(kvStore.get(snapshotRequestKvKey(PROJECT)) ?? null)).toEqual({
      pageGroupId: 'pnh_1',
      urlPattern: '/products/*',
      deviceClass: 'desktop',
    });
    const put = kvPuts.find((p) => p.key === snapshotRequestKvKey(PROJECT));
    expect(put?.options).toEqual({ expirationTtl: 3 * 24 * 60 * 60 });
  });

  it('asks the next visitor when Basin cannot answer, and when the recording has no full snapshot', async () => {
    basin.status = 500;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await heatmaps(WATCH).request(url)).status).toBe(404);
    expect(kvStore.has(snapshotRequestKvKey(PROJECT))).toBe(true);
    kvStore.clear();

    basin.status = 200;
    basin.on(/AS visited_at/, [{ session_id: 'ses_1', visited_at: '2026-11-10 10:00:05' }]);
    basin.on(/has_full_snapshot = true/, [{ session_id: 'ses_1', ts_start: '2026-11-10 10:00:00', r2_key: chunkKey(0) }]);
    await bucket.put(chunkKey(0), await gzipBytes(JSON.stringify([{ type: 3 }])));
    expect((await heatmaps(WATCH).request(url)).status).toBe(404);
    expect(kvStore.has(snapshotRequestKvKey(PROJECT))).toBe(true);
    vi.restoreAllMocks();
  });

  it('answers 404 SNAPSHOT_UNAVAILABLE when the bucket is not bound', async () => {
    const res = await heatmaps(WATCH, { PANEL_REPLAYS: undefined }).request(url);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SNAPSHOT_UNAVAILABLE');
    expect(kvStore.size).toBe(0);
  });
});

describe('pickSnapshotChunks', () => {
  const chunk = (sessionId: string, tsStart: string) => ({ sessionId, tsStart, r2Key: `${sessionId}@${tsStart}` });

  it('takes, per visit, the latest full snapshot that started no later than the visit', () => {
    const picked = pickSnapshotChunks(
      [
        { sessionId: 'a', visitedAt: '2026-11-10T10:00:10.000Z' },
        { sessionId: 'b', visitedAt: '2026-11-09T10:00:00.000Z' },
        { sessionId: 'c', visitedAt: '2026-11-08T10:00:00.000Z' },
      ],
      [
        chunk('a', '2026-11-10T09:00:00.000Z'),
        chunk('a', '2026-11-10T10:00:00.000Z'),
        chunk('a', '2026-11-10T10:05:00.000Z'),
        chunk('b', '2026-11-09T11:00:00.000Z'),
      ],
    );
    expect(picked.map((c) => c.r2Key)).toEqual(['a@2026-11-10T10:00:00.000Z']);
  });
});

describe('GET /api/panel/live', () => {
  const session = (id: string, distinctId: string) => ({
    sessionId: id,
    distinctId,
    path: '/pricing',
    title: 'Pricing',
    country: 'NL',
    deviceType: 'desktop' as const,
    ts: '2026-11-14T10:00:00.000Z',
    startedAt: '2026-11-14T09:58:00.000Z',
    pageviews: 2,
  });

  beforeEach(() => {
    object.liveSessions = [session('s1', 'ada@example.com'), session('s2', 'anon_9')];
  });

  it('answers the visitors and sessions from the project object, naming them for panel_people:read', async () => {
    const res = await live(['panel_reports:read', 'panel_people:read']).request(`/api/panel/live?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const body = await data<PanelLiveDto>(res);
    expect(body.projectId).toBe(PROJECT);
    expect(body.visitors).toBe(2);
    expect(body.sessions.map((s) => s.distinctId)).toEqual(['ada@example.com', 'anon_9']);
  });

  it('replaces the visitor ids with stable pseudonyms without panel_people:read', async () => {
    const first = await data<PanelLiveDto>(await live(['panel_reports:read']).request(`/api/panel/live?projectId=${PROJECT}`));
    const second = await data<PanelLiveDto>(await live(['panel_reports:read']).request(`/api/panel/live?projectId=${PROJECT}`));
    expect(first.sessions.map((s) => s.distinctId)).toEqual(second.sessions.map((s) => s.distinctId));
    for (const s of first.sessions) expect(s.distinctId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(first)).not.toContain('ada@example.com');
    expect(first.sessions[0]?.path).toBe('/pricing');
  });

  it('checks the permission, the project, the binding', async () => {
    expect((await live([]).request(`/api/panel/live?projectId=${PROJECT}`)).status).toBe(403);
    expect((await live(['panel_reports:read']).request(`/api/panel/live?projectId=pnp_zzz`)).status).toBe(404);
    expect((await live(['panel_reports:read']).request(`/api/panel/live`)).status).toBe(400);
    expect((await live(['panel_reports:read'], { PANEL_PROJECT: undefined }).request(`/api/panel/live?projectId=${PROJECT}`)).status).toBe(503);
  });
});
