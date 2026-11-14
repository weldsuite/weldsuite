/**
 * Tests for /api/panel/people, on a real tenant schema (pglite) with a fake
 * Basin, a fake PanelProject object, R2, KV and queues.
 *
 * What must not regress:
 *   1. Every statement sent to Basin carries the workspace and the project of
 *      the request; the profile comes from the project's object.
 *   2. `by-email` opens for `people:read` (the WeldCRM card) as well as
 *      `panel_people:read`, but recordings need `panel_recordings:read`.
 *   3. Erasure runs in order: the object forgets at once, then Basin finds the
 *      sessions and R2 loses the chunks (and `keep/` copies), then the
 *      maintenance queue hears of it; a failing lookup still queues the rewrite
 *      and answers 502 so the request can be repeated.
 *   4. R2 keys read from Basin that belong to another workspace or project are
 *      never deleted.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelPeopleByEmailDto, PanelErasureResult, PanelPersonDto, PanelPersonProfile } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelMaintenanceMessage } from '../types';
import {
  BASIN_ENV,
  FakeBasin,
  FakeProjectState,
  PROJECT,
  WORKSPACE,
  callLog,
  chunkKey,
  entityQueue,
  eventRow,
  maintenanceQueue,
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

import peopleRoutes from './people';

const { panelProjects, panelCohorts, panelSessionFavorites } = schema;

const READ = ['panel_people:read'];
const WITH_RECORDINGS = [...READ, 'panel_recordings:read'];
const ERASE = [...READ, 'panel_people:delete'];

let db: Database;
let master: AnyMasterDatabase;
let events: EntityEventMessage[] = [];
let maintenance: PanelMaintenanceMessage[] = [];
let bucket: R2Bucket;
const basin = new FakeBasin();
const object = new FakeProjectState();

const BASE = '/api/panel/people';

function app(grants: string[] = READ, env: Record<string, unknown> = {}) {
  return createTestApp(BASE, peopleRoutes, {
    context: { permissions: permissions(...grants), tenantDb: db, userId: 'user_alice', orgId: 'org_alpha', workspaceId: WORKSPACE, clerkOrgId: 'org_alpha' },
    env: {
      WORKSPACE_CACHE: memoryKv(),
      ENTITY_EVENTS: entityQueue(events),
      PANEL_PROJECT: object.namespace(),
      PANEL_REPLAYS: bucket,
      PANEL_MAINTENANCE: maintenanceQueue(maintenance),
      PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org',
      ...BASIN_ENV,
      ...env,
    } as never,
    moduleApiErrors: true,
  });
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelSessionFavorites, panelCohorts, panelProjects]) await db.delete(table);
  await db.insert(panelProjects).values([
    { id: PROJECT, name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' },
    { id: 'pnp_b', name: 'Docs', token: 'wpk_b', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' },
  ]);
  events = [];
  maintenance = [];
  callLog.length = 0;
  bucket = replaysBucket();
  basin.reset();
  basin.install();
  object.reset();
});

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/panel/people', () => {
  beforeEach(() => {
    object.people = [
      person('user_1', { email: 'ada@example.com', name: 'Ada' }),
      person('user_2', { email: 'bob@example.com', name: 'Bob' }),
      person('user_3', { name: 'Cleo' }),
    ];
  });

  it('needs panel_people:read and a project of this workspace', async () => {
    expect((await app([]).request(`${BASE}?projectId=${PROJECT}`)).status).toBe(403);
    expect((await app().request(`${BASE}?projectId=pnp_zzz`)).status).toBe(404);
    expect((await app().request(BASE)).status).toBe(400);
  });

  it('lists people from the project object, with a cursor and a search', async () => {
    const first = await app().request(`${BASE}?projectId=${PROJECT}&limit=2`);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { data: PanelPersonDto[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(body.data.map((p) => p.userId)).toEqual(['user_1', 'user_2']);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: '2' });

    const next = (await (await app().request(`${BASE}?projectId=${PROJECT}&limit=2&cursor=2`)).json()) as typeof body;
    expect(next.data.map((p) => p.userId)).toEqual(['user_3']);
    expect(next.pagination.hasMore).toBe(false);

    const found = (await (await app().request(`${BASE}?projectId=${PROJECT}&search=bob`)).json()) as typeof body;
    expect(found.data.map((p) => p.userId)).toEqual(['user_2']);
    expect(basin.sent).toHaveLength(0);
  });

  it('answers 503 without the project object', async () => {
    expect((await app(READ, { PANEL_PROJECT: undefined }).request(`${BASE}?projectId=${PROJECT}`)).status).toBe(503);
  });

  it('narrows to a cohort through Basin, scoped to the workspace and project', async () => {
    await db.insert(panelCohorts).values({
      id: 'pnc_1',
      projectId: PROJECT,
      name: 'Pro',
      filter: { match: 'all', conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }] },
      ownerUserId: 'user_alice',
    });
    basin.on(/AS last_seen/, [{ person: 'user_2', last_seen: '2026-11-14 10:00:00' }, { person: 'user_unknown', last_seen: '2026-11-13 10:00:00' }]);

    const res = await app().request(`${BASE}?projectId=${PROJECT}&cohortId=pnc_1`);
    const body = (await res.json()) as { data: PanelPersonDto[]; pagination: { totalCount: number } };
    expect(res.status).toBe(200);
    // Ids the object does not know (anonymous visitors) are left out.
    expect(body.data.map((p) => p.userId)).toEqual(['user_2']);
    expect(basin.sent).toHaveLength(1);
    expect(basin.sent[0]).toContain(`workspace_id = '${WORKSPACE}'`);
    expect(basin.sent[0]).toContain(`project_id = '${PROJECT}'`);
    expect(basin.sent[0]).toContain("json_get_str(pl2.properties, 'plan') = 'pro'");

    expect((await app().request(`${BASE}?projectId=${PROJECT}&cohortId=pnc_missing`)).status).toBe(400);
  });
});

describe('GET /api/panel/people/:distinctId', () => {
  beforeEach(() => {
    object.people = [person('user_1', { email: 'ada@example.com', anonIds: ['anon_1'] })];
    basin.on(/SELECT COUNT\(\*\) AS n/, [{ n: 42 }]);
    basin.on(/SELECT e\.event_id AS event_id/, [
      eventRow('Signed up', '2026-11-14 09:00:00'),
      eventRow('$pageview', '2026-11-14 08:59:00', { path: '/signup' }),
    ]);
    basin.on(/GROUP BY session_id/, [sessionRow('ses_1')]);
  });

  it('answers the profile, recent events, the event count and the recordings', async () => {
    const res = await app(WITH_RECORDINGS).request(`${BASE}/anon_1?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const profile = await data<PanelPersonProfile>(res);
    expect(profile.person.userId).toBe('user_1');
    expect(profile.recentEvents.map((e) => e.name)).toEqual(['Signed up', '$pageview']);
    expect(profile.eventCount90d).toBe(42);
    expect(profile.sessions.map((s) => s.sessionId)).toEqual(['ses_1']);
    for (const sql of basin.sent) {
      expect(sql).toContain(`workspace_id = '${WORKSPACE}'`);
      expect(sql).toContain(`project_id = '${PROJECT}'`);
    }
  });

  it('leaves the recordings out without panel_recordings:read, and never reads them', async () => {
    const profile = await data<PanelPersonProfile>(await app().request(`${BASE}/user_1?projectId=${PROJECT}`));
    expect(profile.sessions).toEqual([]);
    expect(basin.sent.some((sql) => sql.includes('GROUP BY session_id'))).toBe(false);
  });

  it('is a 404 for someone the object does not know, or erased, and for another workspace', async () => {
    expect((await app().request(`${BASE}/nobody?projectId=${PROJECT}`)).status).toBe(404);
    expect((await app().request(`${BASE}/user_1?projectId=pnp_zzz`)).status).toBe(404);
    expect((await app([]).request(`${BASE}/user_1?projectId=${PROJECT}`)).status).toBe(403);
  });

  it('answers 502 when Basin fails', async () => {
    basin.status = 500;
    expect((await app().request(`${BASE}/user_1?projectId=${PROJECT}`)).status).toBe(502);
  });
});

describe('GET /api/panel/people/by-email', () => {
  beforeEach(() => {
    object.people = [person('user_1', { email: 'ada@example.com' })];
    basin.on(/SELECT e\.event_id AS event_id/, [eventRow('$pageview', '2026-11-14 08:59:00')]);
    basin.on(/GROUP BY session_id/, [sessionRow('ses_1')]);
  });

  it('opens for panel_people:read and for the CRM people:read, not for neither', async () => {
    expect((await app([]).request(`${BASE}/by-email?email=ada@example.com`)).status).toBe(403);
    expect((await app(['people:read']).request(`${BASE}/by-email?email=ada@example.com`)).status).toBe(200);
    expect((await app(READ).request(`${BASE}/by-email?email=ada@example.com`)).status).toBe(200);
    expect((await app(READ).request(`${BASE}/by-email`)).status).toBe(400);
  });

  it('finds the profile case-insensitively across projects, with events, and recordings only when allowed', async () => {
    const without = await data<PanelPeopleByEmailDto>(await app(['people:read']).request(`${BASE}/by-email?email=ADA@Example.com`));
    expect(without.people).toHaveLength(2); // the fake object is shared by both projects
    expect(without.people.map((p) => p.projectName).sort()).toEqual(['Docs', 'Shop']);
    expect(without.people[0]?.recentEvents).toHaveLength(1);
    expect(without.people[0]?.sessions).toEqual([]);

    const withRecordings = await data<PanelPeopleByEmailDto>(await app(WITH_RECORDINGS).request(`${BASE}/by-email?email=ada@example.com`));
    expect(withRecordings.people[0]?.sessions.map((s) => s.sessionId)).toEqual(['ses_1']);
  });

  it('answers an empty list when nobody matches', async () => {
    const none = await data<PanelPeopleByEmailDto>(await app().request(`${BASE}/by-email?email=nobody@example.com`));
    expect(none.people).toEqual([]);
  });

  it('still answers the profile when Basin does not', async () => {
    basin.status = 500;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = await data<PanelPeopleByEmailDto>(await app().request(`${BASE}/by-email?email=ada@example.com`));
    expect(body.people[0]?.person.userId).toBe('user_1');
    expect(body.people[0]?.recentEvents).toEqual([]);
    warn.mockRestore();
  });
});

describe('DELETE /api/panel/people/:distinctId (erasure)', () => {
  const url = `${BASE}/anon_1?projectId=${PROJECT}`;

  beforeEach(async () => {
    object.people = [person('user_1', { anonIds: ['anon_1', 'anon_2'] })];
    object.eraseResult = () => ({ userId: 'user_1', erasedIds: ['anon_1', 'user_1', 'anon_2'] });
    basin.on(/SELECT DISTINCT e\.session_id/, [{ session_id: 'ses_1' }, { session_id: 'ses_2' }]);
    basin.on(/FROM panel\.replay_chunks_v1/, [
      { r2_key: chunkKey(0, 'ses_1') },
      { r2_key: chunkKey(1, 'ses_1') },
      { r2_key: chunkKey(0, 'ses_2', { tier: '90d' }) },
      // Rows that name someone else's objects must never be deleted.
      { r2_key: chunkKey(0, 'ses_x', { ws: 'ws_other' }) },
      { r2_key: chunkKey(0, 'ses_y', { project: 'pnp_other' }) },
      { r2_key: '30d/ws_alpha/pnp_a/../../ws_other/pnp_z/2026-11-10/ses_z/0.json.gz' },
    ]);
    for (const key of [
      chunkKey(0, 'ses_1'),
      chunkKey(1, 'ses_1'),
      chunkKey(0, 'ses_2', { tier: '90d' }),
      `keep/${WORKSPACE}/${PROJECT}/2026-11-10/ses_1/0.json.gz`,
      chunkKey(0, 'ses_x', { ws: 'ws_other' }),
      chunkKey(0, 'ses_y', { project: 'pnp_other' }),
      chunkKey(0, 'ses_other'),
    ]) {
      await bucket.put(key, new Uint8Array([1, 2, 3]));
    }
    await db.insert(panelSessionFavorites).values([
      { id: 'pnf_1', projectId: PROJECT, sessionId: 'ses_1', favoritedByUserId: 'user_alice' },
      { id: 'pnf_2', projectId: PROJECT, sessionId: 'ses_other', favoritedByUserId: 'user_alice' },
    ]);
  });

  const keys = async () => (await bucket.list()).objects.map((o) => o.key).sort();

  it('needs panel_people:delete', async () => {
    expect((await app(READ).request(url, { method: 'DELETE' })).status).toBe(403);
    expect(object.eraseCalls).toEqual([]);
  });

  it('erases the object first, then deletes recordings, then queues the rewrite, in that order', async () => {
    const res = await app(ERASE).request(url, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const result = await data<PanelErasureResult>(res);
    expect(result).toEqual({ userId: 'user_1', erasedIdCount: 3, recordingChunksDeleted: 3 });

    expect(callLog).toEqual(['object.erase', 'basin', 'basin', 'r2.delete', 'maintenance']);
    expect(object.eraseCalls).toEqual([{ userIdOrAnonId: 'anon_1' }]);
    expect(maintenance).toEqual([{ type: 'erase', workspaceId: WORKSPACE, projectId: PROJECT, ids: expect.arrayContaining(['anon_1', 'anon_2', 'user_1']) }]);
    expect(maintenance[0]?.ids).toHaveLength(3);
  });

  it('deletes only this workspace and project’s chunks, with the keep/ copy, and the sessions’ favourites', async () => {
    await app(ERASE).request(url, { method: 'DELETE' });
    expect(await keys()).toEqual(
      [chunkKey(0, 'ses_x', { ws: 'ws_other' }), chunkKey(0, 'ses_y', { project: 'pnp_other' }), chunkKey(0, 'ses_other')].sort(),
    );
    const left = await db.select().from(panelSessionFavorites);
    expect(left.map((f) => f.sessionId)).toEqual(['ses_other']);
  });

  it('looks the sessions up without the erased-id exclusion, scoped to the workspace and project', async () => {
    object.erased = ['someone_else'];
    await app(ERASE).request(url, { method: 'DELETE' });
    const lookup = basin.sent.find((sql) => sql.includes('SELECT DISTINCT e.session_id')) ?? '';
    expect(lookup).toContain(`workspace_id = '${WORKSPACE}'`);
    expect(lookup).toContain(`project_id = '${PROJECT}'`);
    // The person is erased by now: the exclusion would hide the very sessions to delete.
    expect(lookup).not.toContain('NOT IN');
    expect(lookup).toContain("e.anon_id IN ('anon_1', 'user_1', 'anon_2')");
    const chunks = basin.sent.find((sql) => sql.includes('replay_chunks_v1')) ?? '';
    expect(chunks).toContain(`workspace_id = '${WORKSPACE}'`);
    expect(chunks).toContain("session_id IN ('ses_1', 'ses_2')");
  });

  it('succeeds without the bucket or the maintenance queue (features off), after erasing the object', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await app(ERASE, { PANEL_REPLAYS: undefined, PANEL_MAINTENANCE: undefined }).request(url, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await data<PanelErasureResult>(res)).recordingChunksDeleted).toBe(0);
    expect(object.eraseCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PANEL_MAINTENANCE is not bound'));
    warn.mockRestore();
  });

  it('queues the rewrite and answers 502 when the recordings could not be looked up, and can be repeated', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    basin.status = 500;
    const res = await app(ERASE).request(url, { method: 'DELETE' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; details: PanelErasureResult } };
    expect(body.error.code).toBe('ERASURE_INCOMPLETE');
    expect(body.error.details.erasedIdCount).toBe(3);
    // The profile is gone and the rewrite is queued; only the R2 cleanup is left to repeat.
    expect(object.eraseCalls).toHaveLength(1);
    expect(maintenance).toHaveLength(1);
    expect(await keys()).toHaveLength(7);

    basin.status = 200;
    const again = await app(ERASE).request(url, { method: 'DELETE' });
    expect(again.status).toBe(200);
    expect((await data<PanelErasureResult>(again)).recordingChunksDeleted).toBe(3);
    error.mockRestore();
  });

  it('erases an id the object has never seen (an anonymous visitor) and still queues it', async () => {
    object.eraseResult = null;
    // Basin knows no session of this id.
    basin.reset();
    basin.install();
    const res = await app(ERASE).request(`${BASE}/anon_ghost?projectId=${PROJECT}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await data<PanelErasureResult>(res)).toEqual({ userId: null, erasedIdCount: 1, recordingChunksDeleted: 0 });
    expect(maintenance[0]?.ids).toEqual(['anon_ghost']);
  });

  it('is a 404 for a project of another workspace and touches nothing', async () => {
    expect((await app(ERASE).request(`${BASE}/anon_1?projectId=pnp_zzz`, { method: 'DELETE' })).status).toBe(404);
    expect(object.eraseCalls).toEqual([]);
    expect(maintenance).toEqual([]);
  });

  it('does not put anything on the entity bus (visitor data, EVT-005)', async () => {
    await app(ERASE).request(url, { method: 'DELETE' });
    expect(events).toEqual([]);
  });
});
