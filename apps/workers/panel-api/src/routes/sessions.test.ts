/**
 * Tests for /api/panel/sessions (recordings): detail, chunk streaming from the
 * private bucket, favourites. Real tenant schema (pglite), fake Basin, object,
 * R2 and KV.
 *
 * What must not regress:
 *   1. A chunk is read only through the `r2_key` Basin returns, and only when
 *      that key belongs to the request's workspace and project; a foreign key
 *      is a 404, never a read.
 *   2. The chunk answers raw gzip without `Content-Encoding`, so the player
 *      decompresses it once.
 *   3. A favourite copies its chunks to `keep/`, an unfavourite removes them,
 *      and a favourite whose original chunk expired still plays from the copy.
 *   4. Everything needs `panel_recordings:read`; the person on the detail also
 *      needs `panel_people:read`; every Basin statement is scoped.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelFavoriteDto, PanelSessionDetail } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import {
  BASIN_ENV,
  FakeBasin,
  FakeProjectState,
  PROJECT,
  WORKSPACE,
  callLog,
  chunkKey,
  eventRow,
  gunzipText,
  gzipBytes,
  memoryKv,
  person,
  replaysBucket,
  sessionRow,
} from '../test-support/fakes';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master as never };
});

import sessionsRoutes from './sessions';

const { panelProjects, panelSessionFavorites, panelAiSummaries } = schema;

const WATCH = ['panel_recordings:read'];
const WATCH_PEOPLE = [...WATCH, 'panel_people:read'];
const BASE = '/api/panel/sessions';
const KEEP_0 = `keep/${WORKSPACE}/${PROJECT}/2026-11-10/ses_1/0.json.gz`;

let db: Database;
let master: AnyMasterDatabase;
let bucket: R2Bucket;
let kvStore: Map<string, string>;
const basin = new FakeBasin();
const object = new FakeProjectState();

function app(grants: string[] = WATCH, env: Record<string, unknown> = {}) {
  return createTestApp(BASE, sessionsRoutes, {
    context: { permissions: permissions(...grants), tenantDb: db, userId: 'user_alice', orgId: 'org_alpha', workspaceId: WORKSPACE, clerkOrgId: 'org_alpha' },
    env: {
      WORKSPACE_CACHE: memoryKv(kvStore),
      PANEL_PROJECT: object.namespace(),
      PANEL_REPLAYS: bucket,
      PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org',
      ...BASIN_ENV,
      ...env,
    } as never,
    moduleApiErrors: true,
  });
}

const json = (body: unknown, method = 'PUT'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const q = `projectId=${PROJECT}`;

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

/** What Basin knows about `ses_1`: its row, two chunks, a few events and two other sessions of the same person. */
function knowSession(): void {
  basin.on(/AS chunks/, [{ session_id: 'ses_1', chunks: 2 }]);
  basin.on(/SELECT seq, ts_start/, [
    { seq: 0, ts_start: '2026-11-10 10:00:00', ts_end: '2026-11-10 10:02:00', bytes: 900, has_full_snapshot: true, r2_key: chunkKey(0) },
    { seq: 1, ts_start: '2026-11-10 10:02:00', ts_end: '2026-11-10 10:05:00', bytes: 700, has_full_snapshot: false, r2_key: chunkKey(1) },
    // A re-sent chunk counts once.
    { seq: 1, ts_start: '2026-11-10 10:02:00', ts_end: '2026-11-10 10:05:00', bytes: 700, has_full_snapshot: false, r2_key: chunkKey(1) },
    // A row that names another workspace's object is ignored.
    { seq: 2, ts_start: '2026-11-10 10:05:00', ts_end: '2026-11-10 10:06:00', bytes: 100, has_full_snapshot: false, r2_key: chunkKey(2, 'ses_1', { ws: 'ws_other' }) },
  ]);
  basin.on(/SELECT e\.event_id AS event_id/, [
    // Newest first, like the activity feed.
    eventRow('$exception', '2026-11-10 10:04:00', { error_message: 'x is undefined' }),
    eventRow('Added to cart', '2026-11-10 10:03:00'),
    eventRow('$pageleave', '2026-11-10 10:02:30'),
    eventRow('$autocapture', '2026-11-10 10:02:00', { el_text: 'Buy now', properties: '{"$action":"click"}' }),
    eventRow('$identify', '2026-11-10 10:01:00'),
    eventRow('$pageview', '2026-11-10 10:00:00'),
  ]);
  basin.on(/GROUP BY session_id/, (sql) =>
    sql.includes("e.session_id IN ('ses_1')") ? [sessionRow('ses_1')] : [sessionRow('ses_1'), sessionRow('ses_2', { started: '2026-11-09 10:00:00' }), sessionRow('ses_3', { started: '2026-11-08 10:00:00' })],
  );
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelSessionFavorites, panelAiSummaries, panelProjects]) await db.delete(table);
  await db.insert(panelProjects).values({ id: PROJECT, name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  callLog.length = 0;
  kvStore = new Map();
  bucket = replaysBucket();
  basin.reset();
  basin.install();
  object.reset();
  object.people = [person('user_1', { email: 'ada@example.com' })];
  knowSession();
});

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/panel/sessions/:id', () => {
  it('answers the session, its chunk manifest (without storage keys), the timeline markers and the other sessions', async () => {
    const res = await app(WATCH_PEOPLE).request(`${BASE}/ses_1?${q}`);
    expect(res.status).toBe(200);
    const detail = await data<PanelSessionDetail>(res);

    expect(detail.session.sessionId).toBe('ses_1');
    expect(detail.chunks).toEqual([
      { seq: 0, tsStart: '2026-11-10T10:00:00.000Z', tsEnd: '2026-11-10T10:02:00.000Z', bytes: 900, hasFullSnapshot: true },
      { seq: 1, tsStart: '2026-11-10T10:02:00.000Z', tsEnd: '2026-11-10T10:05:00.000Z', bytes: 700, hasFullSnapshot: false },
    ]);
    expect(JSON.stringify(detail)).not.toContain('r2Key');
    expect(JSON.stringify(detail)).not.toContain('ws_other');

    // Oldest first; page leaves and identity links are not markers.
    expect(detail.events.map((e) => e.name)).toEqual(['$pageview', '$autocapture', 'Added to cart', '$exception']);
    expect(detail.events[1]?.detail).toBe('Buy now');
    expect(detail.events[3]?.detail).toBe('x is undefined');

    expect(detail.person?.email).toBe('ada@example.com');
    expect(detail.otherSessions.map((s) => s.sessionId)).toEqual(['ses_2', 'ses_3']);
    expect(detail.favorite).toBeNull();
    expect(detail.summary).toBeNull();
  });

  it('scopes every statement to the workspace and project', async () => {
    await app(WATCH_PEOPLE).request(`${BASE}/ses_1?${q}`);
    expect(basin.sent.length).toBeGreaterThan(0);
    for (const sql of basin.sent) {
      expect(sql).toContain(`workspace_id = '${WORKSPACE}'`);
      expect(sql).toContain(`project_id = '${PROJECT}'`);
    }
  });

  it('leaves the person out without panel_people:read', async () => {
    const detail = await data<PanelSessionDetail>(await app(WATCH).request(`${BASE}/ses_1?${q}`));
    expect(detail.person).toBeNull();
    expect(detail.session.sessionId).toBe('ses_1');
  });

  it('carries the favourite and the cached summary', async () => {
    await db.insert(panelSessionFavorites).values({ id: 'pnf_1', projectId: PROJECT, sessionId: 'ses_1', note: 'checkout bug', favoritedByUserId: 'user_alice' });
    await db.insert(panelAiSummaries).values({
      id: 'pna_1',
      projectId: PROJECT,
      scope: 'session',
      sessionId: 'ses_1',
      summary: { goal: 'Buy', outcome: 'abandoned', frictionPoints: [], narrative: 'Left at checkout.' },
      modelId: 'm',
      creditsCharged: 3,
      createdByUserId: 'user_alice',
    });
    const detail = await data<PanelSessionDetail>(await app(WATCH).request(`${BASE}/ses_1?${q}`));
    expect(detail.favorite?.note).toBe('checkout bug');
    expect(detail.session.favorite).toBe(true);
    expect(detail.summary?.summary.goal).toBe('Buy');
    // A favourite can be older than the recordings' retention: the session is looked up over the whole retention, not 90 days.
    const lookup = basin.sent.find((sql) => sql.includes("e.session_id IN ('ses_1')")) ?? '';
    const from = /e.ts >= TIMESTAMP '([^']+)'/.exec(lookup)?.[1] ?? '';
    expect(Date.now() - Date.parse(`${from.replace(' ', 'T')}Z`)).toBeGreaterThan(300 * 86_400_000);
  });

  it('is a 404 for an unknown session, a project of another workspace, and 403 without the permission', async () => {
    basin.reset();
    basin.install();
    expect((await app().request(`${BASE}/ses_nope?${q}`)).status).toBe(404);
    expect((await app().request(`${BASE}/ses_1?projectId=pnp_zzz`)).status).toBe(404);
    expect((await app([]).request(`${BASE}/ses_1?${q}`)).status).toBe(403);
    expect((await app(['panel_reports:read']).request(`${BASE}/ses_1?${q}`)).status).toBe(403);
    expect((await app().request(`${BASE}/ses_1`)).status).toBe(400);
    expect((await app().request(`${BASE}/${encodeURIComponent("a'b")}?${q}`)).status).toBe(400);
  });

  it('answers 503 without the project object and 502 when Basin fails', async () => {
    expect((await app(WATCH, { PANEL_PROJECT: undefined }).request(`${BASE}/ses_1?${q}`)).status).toBe(503);
    basin.status = 500;
    expect((await app().request(`${BASE}/ses_1?${q}`)).status).toBe(502);
  });
});

describe('GET /api/panel/sessions/:id/chunks/:seq', () => {
  beforeEach(async () => {
    await bucket.put(chunkKey(0), await gzipBytes('[{"type":2}]'));
    await bucket.put(chunkKey(1), await gzipBytes('[{"type":3}]'));
    await bucket.put(chunkKey(2, 'ses_1', { ws: 'ws_other' }), await gzipBytes('SECRET'));
  });

  it('streams the chunk as raw gzip, without Content-Encoding', async () => {
    const res = await app().request(`${BASE}/ses_1/chunks/0?${q}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('cache-control')).toContain('private');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await gunzipText(await res.arrayBuffer())).toBe('[{"type":2}]');
  });

  it('finds the key through Basin once, then from the cached manifest', async () => {
    await app().request(`${BASE}/ses_1/chunks/0?${q}`);
    const lookups = basin.sent.filter((sql) => sql.includes('replay_chunks_v1')).length;
    expect(lookups).toBe(1);
    const second = await app().request(`${BASE}/ses_1/chunks/1?${q}`);
    expect(await gunzipText(await second.arrayBuffer())).toBe('[{"type":3}]');
    expect(basin.sent.filter((sql) => sql.includes('replay_chunks_v1')).length).toBe(1);
  });

  it('never reads an object whose key belongs to another workspace, and 404s a chunk the session does not have', async () => {
    const foreign = await app().request(`${BASE}/ses_1/chunks/2?${q}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).not.toContain('SECRET');
    expect((await app().request(`${BASE}/ses_1/chunks/9?${q}`)).status).toBe(404);
  });

  it('does not trust a poisoned cached manifest', async () => {
    kvStore.set(`panel:replay-manifest:${PROJECT}:ses_1`, JSON.stringify({ '0': chunkKey(2, 'ses_1', { ws: 'ws_other' }) }));
    const res = await app().request(`${BASE}/ses_1/chunks/0?${q}`);
    // The poisoned key is ignored and the real one is looked up.
    expect(await gunzipText(await res.arrayBuffer())).toBe('[{"type":2}]');
  });

  it('validates the chunk number, the session id and the project', async () => {
    expect((await app().request(`${BASE}/ses_1/chunks/-1?${q}`)).status).toBe(400);
    expect((await app().request(`${BASE}/ses_1/chunks/abc?${q}`)).status).toBe(400);
    expect((await app().request(`${BASE}/ses_1/chunks/0?projectId=pnp_zzz`)).status).toBe(404);
    expect((await app([]).request(`${BASE}/ses_1/chunks/0?${q}`)).status).toBe(403);
  });

  it('is a 404 when the bucket is not bound', async () => {
    expect((await app(WATCH, { PANEL_REPLAYS: undefined }).request(`${BASE}/ses_1/chunks/0?${q}`)).status).toBe(404);
  });

  it('plays a favourite from its keep/ copy once the original has expired, and a plain session does not', async () => {
    await bucket.put(KEEP_0, await gzipBytes('[{"type":"kept"}]'));
    await bucket.delete(chunkKey(0));
    expect((await app().request(`${BASE}/ses_1/chunks/0?${q}`)).status).toBe(404);

    await db.insert(panelSessionFavorites).values({ id: 'pnf_1', projectId: PROJECT, sessionId: 'ses_1', favoritedByUserId: 'user_alice' });
    const res = await app().request(`${BASE}/ses_1/chunks/0?${q}`);
    expect(res.status).toBe(200);
    expect(await gunzipText(await res.arrayBuffer())).toBe('[{"type":"kept"}]');
  });
});

describe('favourites', () => {
  beforeEach(async () => {
    await bucket.put(chunkKey(0), await gzipBytes('[{"type":2}]'));
    await bucket.put(chunkKey(1), await gzipBytes('[{"type":3}]'));
  });

  const keys = async () => (await bucket.list()).objects.map((o) => o.key).sort();

  it('PUT favourites with a note and copies the chunks to keep/', async () => {
    const res = await app().request(`${BASE}/ses_1/favorite`, json({ projectId: PROJECT, note: 'checkout bug' }));
    expect(res.status).toBe(200);
    const favourite = await data<PanelFavoriteDto>(res);
    expect(favourite).toMatchObject({ projectId: PROJECT, sessionId: 'ses_1', note: 'checkout bug', favoritedByUserId: 'user_alice' });

    expect(await keys()).toEqual([
      chunkKey(0),
      chunkKey(1),
      KEEP_0,
      `keep/${WORKSPACE}/${PROJECT}/2026-11-10/ses_1/1.json.gz`,
    ].sort());
    expect(await gunzipText(await (await bucket.get(KEEP_0))!.arrayBuffer())).toBe('[{"type":2}]');
    // The foreign row in the manifest is not copied.
    expect((await keys()).some((k) => k.includes('ws_other'))).toBe(false);
  });

  it('PUT again changes the note only', async () => {
    await app().request(`${BASE}/ses_1/favorite`, json({ projectId: PROJECT, note: 'one' }));
    const again = await data<PanelFavoriteDto>(await app().request(`${BASE}/ses_1/favorite`, json({ projectId: PROJECT, note: 'two' })));
    expect(again.note).toBe('two');
    expect(await db.select().from(panelSessionFavorites)).toHaveLength(1);
  });

  it('PUT is a 404 for a session that does not exist, and creates nothing', async () => {
    basin.reset();
    basin.install();
    expect((await app().request(`${BASE}/ses_nope/favorite`, json({ projectId: PROJECT }))).status).toBe(404);
    expect(await db.select().from(panelSessionFavorites)).toHaveLength(0);
    expect((await app().request(`${BASE}/ses_1/favorite`, json({ projectId: 'pnp_zzz' }))).status).toBe(404);
    expect((await app([]).request(`${BASE}/ses_1/favorite`, json({ projectId: PROJECT }))).status).toBe(403);
  });

  it('PUT still saves the favourite when the bucket is not bound', async () => {
    const res = await app(WATCH, { PANEL_REPLAYS: undefined }).request(`${BASE}/ses_1/favorite`, json({ projectId: PROJECT }));
    expect(res.status).toBe(200);
    expect(await db.select().from(panelSessionFavorites)).toHaveLength(1);
  });

  it('DELETE removes the copies and the favourite, and leaves the originals', async () => {
    await app().request(`${BASE}/ses_1/favorite`, json({ projectId: PROJECT }));
    const res = await app().request(`${BASE}/ses_1/favorite?${q}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await keys()).toEqual([chunkKey(0), chunkKey(1)].sort());
    expect(await db.select().from(panelSessionFavorites)).toHaveLength(0);
  });

  it('DELETE is a 404 when there is no favourite, and keeps the row when the copies could not be removed', async () => {
    expect((await app().request(`${BASE}/ses_1/favorite?${q}`, { method: 'DELETE' })).status).toBe(404);

    await app().request(`${BASE}/ses_1/favorite`, json({ projectId: PROJECT }));
    basin.status = 500;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await app().request(`${BASE}/ses_1/favorite?${q}`, { method: 'DELETE' })).status).toBe(502);
    expect(await db.select().from(panelSessionFavorites)).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('puts nothing on the entity bus', async () => {
    const events: unknown[] = [];
    const queue = { send: async (m: unknown) => void events.push(m) } as unknown as Queue;
    await app(WATCH, { ENTITY_EVENTS: queue }).request(`${BASE}/ses_1/favorite`, json({ projectId: PROJECT }));
    expect(events).toEqual([]);
  });
});
