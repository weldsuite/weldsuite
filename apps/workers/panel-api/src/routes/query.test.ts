/**
 * Tests for POST /api/panel/query and /api/panel/lexicon, with a real tenant
 * schema (pglite), a fake Basin (the REST call is a stubbed `fetch`), a fake
 * PanelProject Durable Object and an in-memory KV.
 *
 * What must not regress:
 *   1. Every statement sent to Basin carries the workspace of the request and
 *      the project the caller may read, whatever the spec says.
 *   2. The recordings list needs `panel_recordings:read` on top of reports.
 *   3. The Durable Object's erased ids and identity flag reach the SQL; with no
 *      object the query is refused (503), never run without them.
 *   4. Results are cached per workspace and spec for two minutes, with
 *      `dataAsOf`, and a broken cache never breaks a query.
 *   5. Favourites are annotated per request, not cached.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelLexiconDto, PanelLexiconEntry } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelQueryResponse } from '@weldsuite/app-api-client/schemas/weldpanel-query';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master as never };
});

import queryRoutes from './query';
import lexiconRoutes from './lexicon';

const { panelProjects, panelCohorts, panelHeatmapPages, panelSessionFavorites, panelEventDefinitions } = schema;

const READ = ['panel_reports:read'];
const WITH_RECORDINGS = [...READ, 'panel_recordings:read'];
const UPDATE = [...READ, 'panel_reports:update'];

let db: Database;
let master: AnyMasterDatabase;
let events: EntityEventMessage[] = [];
const kvStore = new Map<string, string>();
const sent: string[] = [];
let basinRows: Record<string, unknown>[] = [];
let basinStatus = 200;

const kv = {
  get: async (key: string) => {
    const value = kvStore.get(key);
    return value === undefined ? null : JSON.parse(value);
  },
  put: async (key: string, value: string) => {
    kvStore.set(key, value);
  },
  delete: async (key: string) => {
    kvStore.delete(key);
  },
} as unknown as KVNamespace;

const queue = {
  send: async (message: EntityEventMessage) => {
    events.push(message);
  },
} as unknown as Queue<EntityEventMessage>;

interface FakeObject {
  erased: string[];
  identified: boolean;
}
const fakeObject: FakeObject = { erased: [], identified: false };
const objectNamespace = {
  idFromName: (name: string) => name as unknown as DurableObjectId,
  get: () => ({
    erasedIds: async () => fakeObject.erased,
    hasIdentifiedUsers: async () => fakeObject.identified,
  }),
};

const BASIN_ENV = { R2_SQL_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acc', PANEL_BASIN_BUCKET: 'bucket' };

function app(base: string, router: typeof queryRoutes, grants: string[] = READ, env: Record<string, unknown> = {}) {
  return createTestApp(base, router, {
    context: { permissions: permissions(...grants), tenantDb: db, userId: 'user_alice', orgId: 'org_alpha', workspaceId: 'ws_alpha', clerkOrgId: 'org_alpha' },
    env: { WORKSPACE_CACHE: kv, ENTITY_EVENTS: queue, PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org', PANEL_PROJECT: objectNamespace, ...BASIN_ENV, ...env } as never,
    moduleApiErrors: true,
  });
}

const query = (grants?: string[], env?: Record<string, unknown>) => app('/api/panel/query', queryRoutes, grants, env);
const lexicon = (grants?: string[], env?: Record<string, unknown>) => app('/api/panel/lexicon', lexiconRoutes, grants, env);

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const WEB = { kind: 'web', projectId: 'pnp_a', dateRange: { preset: '7d' } };

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelSessionFavorites, panelHeatmapPages, panelCohorts, panelEventDefinitions, panelProjects]) await db.delete(table);
  await db.insert(panelProjects).values({ id: 'pnp_a', name: 'Site', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  kvStore.clear();
  events = [];
  sent.length = 0;
  basinRows = [];
  basinStatus = 200;
  fakeObject.erased = [];
  fakeObject.identified = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { query: string };
      sent.push(body.query);
      if (basinStatus !== 200) return new Response('boom', { status: basinStatus });
      return Response.json({ result: { rows: basinRows, metrics: { bytes_scanned: 2048 } } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/panel/query', () => {
  it('runs the spec and answers kind, result, dataAsOf and cached', async () => {
    const res = await query().request('/api/panel/query', json(WEB));
    expect(res.status).toBe(200);
    const body = await data<PanelQueryResponse>(res);
    expect(body.kind).toBe('web');
    expect(body.cached).toBe(false);
    expect(new Date(body.dataAsOf).getTime()).toBeGreaterThan(Date.now() - 60_000);
    if (body.kind !== 'web') throw new Error('kind');
    expect(body.result.totals.visitors).toBe(0);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('scopes every statement to the workspace of the request and the project, whatever the spec says', async () => {
    await query().request('/api/panel/query', json({ ...WEB, workspaceId: 'ws_other', filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }] }));
    expect(sent.length).toBeGreaterThan(0);
    for (const sql of sent) {
      expect(sql).toContain("workspace_id = 'ws_alpha'");
      expect(sql).toContain("project_id = 'pnp_a'");
      expect(sql).not.toContain('ws_other');
    }
  });

  it('answers 404 for a project of another workspace and 400 for a bad spec, without touching Basin', async () => {
    expect((await query().request('/api/panel/query', json({ ...WEB, projectId: 'pnp_zzz' }))).status).toBe(404);
    expect((await query().request('/api/panel/query', json({ kind: 'nope', projectId: 'pnp_a' }))).status).toBe(400);
    expect((await query().request('/api/panel/query', json({ ...WEB, filters: [{ source: 'event', key: "a'b", operator: 'eq', value: 1 }] }))).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('needs panel_reports:read, and panel_recordings:read for the recordings list', async () => {
    expect((await query([]).request('/api/panel/query', json(WEB))).status).toBe(403);
    const sessions = { kind: 'sessions', projectId: 'pnp_a' };
    expect((await query(READ).request('/api/panel/query', json(sessions))).status).toBe(403);
    expect((await query(WITH_RECORDINGS).request('/api/panel/query', json(sessions))).status).toBe(200);
    expect((await query(READ).request('/api/panel/query', json({ kind: 'heatmap', projectId: 'pnp_a', type: 'scroll', deviceClass: 'desktop', urlPattern: '/' }))).status).toBe(200);
  });

  it('caches per workspace and spec for two minutes, whatever the key order', async () => {
    const first = await data<PanelQueryResponse>(await query().request('/api/panel/query', json(WEB)));
    const calls = sent.length;
    const second = await data<PanelQueryResponse>(await query().request('/api/panel/query', json({ dateRange: { preset: '7d' }, projectId: 'pnp_a', kind: 'web' })));
    expect(second.cached).toBe(true);
    expect(second.dataAsOf).toBe(first.dataAsOf);
    expect(sent).toHaveLength(calls);
    expect([...kvStore.keys()].every((k) => k.startsWith('panel:q:ws_alpha:pnp_a:'))).toBe(true);

    // A different spec is a different entry.
    await query().request('/api/panel/query', json({ ...WEB, dateRange: { preset: '30d' } }));
    expect(sent.length).toBeGreaterThan(calls);
  });

  it('still answers when the cache is broken', async () => {
    const broken = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } };
    const res = await query(READ, { WORKSPACE_CACHE: broken }).request('/api/panel/query', json(WEB));
    expect(res.status).toBe(200);
  });

  it('puts the erased ids and the identity join from the project object into the SQL', async () => {
    fakeObject.erased = ['user_gone'];
    fakeObject.identified = true;
    await query().request('/api/panel/query', json(WEB));
    for (const sql of sent) {
      expect(sql).toContain("e.anon_id NOT IN ('user_gone')");
      expect(sql).toContain('panel.identities_v1');
    }
  });

  it('refuses to run without the project object, or without Basin configured', async () => {
    const noObject = await query(READ, { PANEL_PROJECT: undefined }).request('/api/panel/query', json(WEB));
    expect(noObject.status).toBe(503);
    const noToken = await query(READ, { R2_SQL_API_TOKEN: undefined }).request('/api/panel/query', json(WEB));
    expect(noToken.status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('answers 502 when Basin fails, and does not cache the failure', async () => {
    basinStatus = 500;
    expect((await query().request('/api/panel/query', json(WEB))).status).toBe(502);
    expect(kvStore.size).toBe(0);
  });

  it('refuses a cohort or page group that does not exist (400) and uses saved ones', async () => {
    const missing = await query().request('/api/panel/query', json({ ...WEB, filters: [{ source: 'cohort', cohortId: 'pnc_nope' }] }));
    expect(missing.status).toBe(400);

    await db.insert(panelCohorts).values({
      id: 'pnc_1',
      projectId: 'pnp_a',
      name: 'Pro',
      filter: { match: 'all', conditions: [{ type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' }] },
      ownerUserId: 'user_alice',
    });
    sent.length = 0;
    expect((await query().request('/api/panel/query', json({ ...WEB, filters: [{ source: 'cohort', cohortId: 'pnc_1' }] }))).status).toBe(200);
    expect(sent[0]).toContain("json_get_str(pl2.properties, 'plan') = 'pro'");

    await db.insert(panelHeatmapPages).values({ id: 'pnh_1', projectId: 'pnp_a', name: 'Products', urlPattern: '/products/*', createdByUserId: 'user_alice' });
    sent.length = 0;
    const heat = await query().request('/api/panel/query', json({ kind: 'heatmap', projectId: 'pnp_a', type: 'area', deviceClass: 'mobile', pageGroupId: 'pnh_1' }));
    expect(heat.status).toBe(200);
    expect(sent.some((sql) => sql.includes("LIKE '/products/%'"))).toBe(true);
  });

  it('marks favourites per request, outside the cache', async () => {
    basinRows = [{ session_id: 's_1', started: '2026-11-14 10:00:00', ended: '2026-11-14 10:01:00', duration_seconds: 60, pageviews: 1, events: 2 }];
    const sessions = { kind: 'sessions', projectId: 'pnp_a' };
    const rows = async () => {
      const body = await data<PanelQueryResponse>(await query(WITH_RECORDINGS).request('/api/panel/query', json(sessions)));
      if (body.kind !== 'sessions') throw new Error('kind');
      return body;
    };
    expect((await rows()).result.sessions[0]?.favorite).toBe(false);
    await db.insert(panelSessionFavorites).values({ id: 'pnf_1', projectId: 'pnp_a', sessionId: 's_1', favoritedByUserId: 'user_alice' });
    const again = await rows();
    expect(again.cached).toBe(true);
    expect(again.result.sessions[0]?.favorite).toBe(true);
  });

  it('applies the retention of a workspace with no plan (12 months)', async () => {
    await query().request('/api/panel/query', json({ ...WEB, dateRange: { from: '2000-01-01', to: '2030-01-01' } }));
    const floor = new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10);
    expect(sent[0]).toContain(`e.ts >= TIMESTAMP '${floor}`);
  });
});

describe('/api/panel/lexicon', () => {
  const seen = (sql: string) => sent.some((s) => s === sql);

  it('merges the names seen in the data with the definitions, newest scan cached', async () => {
    await db.insert(panelEventDefinitions).values([
      { id: 'pne_1', projectId: 'pnp_a', kind: 'event', name: 'Signed up', description: 'Account created', verified: true },
      { id: 'pne_2', projectId: 'pnp_a', kind: 'event', name: 'Old event', hidden: true },
    ]);
    basinRows = [{ name: 'Signed up', n: 12, properties: '{"plan":"pro"}' }];
    const res = await lexicon().request('/api/panel/lexicon?projectId=pnp_a');
    expect(res.status).toBe(200);
    const body = await data<PanelLexiconDto>(res);
    expect(body.events.find((e) => e.name === 'Signed up')).toMatchObject({ seen: true, count30d: 12, description: 'Account created', verified: true, definitionId: 'pne_1' });
    expect(body.events.find((e) => e.name === 'Old event')).toMatchObject({ seen: false, hidden: true });
    expect(body.properties.map((p) => p.name)).toContain('plan');
    for (const sql of sent) {
      expect(sql).toContain("workspace_id = 'ws_alpha'");
      expect(sql).toContain("project_id = 'pnp_a'");
    }

    const calls = sent.length;
    await lexicon().request('/api/panel/lexicon?projectId=pnp_a');
    expect(sent).toHaveLength(calls);
    expect(seen('')).toBe(false);
  });

  it('shows the definitions alone when the analytics store is not configured', async () => {
    await db.insert(panelEventDefinitions).values({ id: 'pne_1', projectId: 'pnp_a', kind: 'event', name: 'Signed up' });
    const res = await lexicon(READ, { R2_SQL_API_TOKEN: undefined }).request('/api/panel/lexicon?projectId=pnp_a');
    expect(res.status).toBe(200);
    expect((await data<PanelLexiconDto>(res)).events).toMatchObject([{ name: 'Signed up', seen: false }]);
  });

  it('needs a known project and the read permission', async () => {
    expect((await lexicon().request('/api/panel/lexicon?projectId=pnp_zzz')).status).toBe(404);
    expect((await lexicon().request('/api/panel/lexicon')).status).toBe(400);
    expect((await lexicon([]).request('/api/panel/lexicon?projectId=pnp_a')).status).toBe(403);
  });

  it('creates a definition, then updates it, each with an event', async () => {
    const api = lexicon(UPDATE);
    const created = await api.request('/api/panel/lexicon', json({ projectId: 'pnp_a', kind: 'event', name: 'Signed up', description: 'Account created' }, 'PATCH'));
    expect(created.status).toBe(200);
    expect(await data<PanelLexiconEntry>(created)).toMatchObject({ name: 'Signed up', description: 'Account created', hidden: false, verified: false });

    const updated = await api.request('/api/panel/lexicon', json({ projectId: 'pnp_a', kind: 'event', name: 'Signed up', verified: true, hidden: true }, 'PATCH'));
    expect(await data<PanelLexiconEntry>(updated)).toMatchObject({ description: 'Account created', verified: true, hidden: true });
    expect(await db.select().from(panelEventDefinitions)).toHaveLength(1);
    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_event_definition', 'created'],
      ['panel_event_definition', 'updated'],
    ]);
  });

  it('refuses an empty change, a bad name, an unknown project and a reader', async () => {
    const api = lexicon(UPDATE);
    const patch = (body: unknown) => api.request('/api/panel/lexicon', json(body, 'PATCH'));
    expect((await patch({ projectId: 'pnp_a', kind: 'event', name: 'x' })).status).toBe(400);
    expect((await patch({ projectId: 'pnp_zzz', kind: 'event', name: 'x', hidden: true })).status).toBe(404);
    expect((await lexicon(READ).request('/api/panel/lexicon', json({ projectId: 'pnp_a', kind: 'event', name: 'x', hidden: true }, 'PATCH'))).status).toBe(403);
    expect(events).toHaveLength(0);
  });
});
