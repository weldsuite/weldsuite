/**
 * Tests for share links (/api/panel/share-links) and the public routes
 * (/public/panel/share/*), on a real tenant and master schema (pglite), a fake
 * Basin (stubbed `fetch`), a fake PanelProject object and an in-memory KV.
 *
 * What must not regress:
 *   1. The token is shown once (`wpsh_` + 32); only its SHA-256 is stored, in
 *      the tenant row and the master registry, and never on the entity bus.
 *   2. People data never leaves: a report (or a dashboard with one) with a
 *      person, URL or element-text breakdown, or a kind that is not an
 *      aggregate, is refused (422), and refused again at view time.
 *   3. Only a target the caller may change can be shared.
 *   4. The public routes answer the same 404 for anything wrong: malformed,
 *      unknown, revoked or expired tokens, a suspended workspace, a deleted
 *      or no-longer-visible target, a tile the link does not show.
 *   5. Public metadata carries no filter values, cohort ids or project id;
 *      results run through the query cache, scoped to the link's workspace
 *      and project, with the dashboard's filters, and a date preset only when
 *      the link allows it.
 *   6. Revoking stamps the tenant row and the registry; views are counted at
 *      most once a minute; the public routes are rate limited per address.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelDashboardDto, PanelDashboardTileDto, PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelQueryResponse } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type {
  PanelCreatedShareLinkDto,
  PanelNotShareableDetails,
  PanelPublicShareDto,
  PanelShareLinkDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { Env, Variables } from '../types';
import { memoryKv } from '../test-support/fakes';

const state = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown, suspended: false }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => state.master as never,
    getWorkspaceContextForOrg: async (_env: unknown, ref: string) => {
      if (ref !== 'ws_alpha') throw new Error(`Workspace not found: ${ref}`);
      return { id: 'ws_alpha', clerkOrgId: 'org_alpha', db: state.tenant, suspended: state.suspended, licensedApps: null, readOnly: false, readOnlyReason: null };
    },
  };
});

import reportsRoutes from './reports';
import dashboardsRoutes from './dashboards';
import shareLinksRoutes from './share-links';
import publicRoutes from './public';
import { publicSpec, shareRefusals } from '../services/share-links';
import { sha256Hex } from '../services/keys';

const { panelProjects, panelReports, panelDashboards, panelDashboardTiles, panelShareLinks } = schema;
const { panelShareRegistry } = masterSchema;

const MEMBER = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const ADMIN = [...MEMBER, 'panel_projects:manage'];
const READER = ['panel_reports:read'];

let db: Database;
let master: AnyMasterDatabase;
let events: EntityEventMessage[] = [];
let kvStore: Map<string, string>;
const sent: string[] = [];
let limited = false;

const queue = {
  send: async (message: EntityEventMessage) => {
    events.push(message);
  },
} as unknown as Queue<EntityEventMessage>;

const objectNamespace = {
  idFromName: (name: string) => name as unknown as DurableObjectId,
  get: () => ({ erasedIds: async () => [], hasIdentifiedUsers: async () => false }),
};

const limiter = { limit: async () => ({ success: !limited }) };

function env() {
  return {
    ENTITY_EVENTS: queue,
    WORKSPACE_CACHE: memoryKv(kvStore),
    PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org',
    PLATFORM_URL: 'https://app-test.weldsuite.org',
    PANEL_PROJECT: objectNamespace,
    PANEL_SHARE_RATE_LIMIT: limiter,
    R2_SQL_API_TOKEN: 'tok',
    CF_ACCOUNT_ID: 'acc',
    PANEL_BASIN_BUCKET: 'bucket',
  };
}

type Router = Hono<{ Bindings: Env; Variables: Variables }>;

function app(base: string, router: Router, userId = 'user_alice', grants: string[] = MEMBER) {
  return createTestApp(base, router, {
    context: { permissions: permissions(...grants), tenantDb: db, userId, orgId: 'org_alpha', workspaceId: 'ws_alpha', clerkOrgId: 'org_alpha' },
    env: env() as never,
    moduleApiErrors: true,
  });
}

const reports = (user?: string, grants?: string[]) => app('/api/panel/reports', reportsRoutes, user, grants);
const dashboards = (user?: string, grants?: string[]) => app('/api/panel/dashboards', dashboardsRoutes, user, grants);
const links = (user?: string, grants?: string[]) => app('/api/panel/share-links', shareLinksRoutes, user, grants);
const publicApi = () => app('/public/panel', publicRoutes, 'anonymous', []);

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

const TRENDS = (extra: Record<string, unknown> = {}) => ({
  kind: 'trends',
  projectId: 'pnp_a',
  dateRange: { preset: '30d' },
  series: [{ event: 'Signed up', filters: [{ source: 'event', key: 'plan', operator: 'eq', value: 'secret-plan' }] }],
  filters: [{ source: 'column', field: 'utm_campaign', operator: 'eq', value: 'black-friday' }],
  ...extra,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  state.tenant = db;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelShareLinks, panelDashboardTiles, panelDashboards, panelReports, panelProjects]) await db.delete(table);
  await master.delete(panelShareRegistry);
  await db.insert(panelProjects).values({ id: 'pnp_a', name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  events = [];
  kvStore = new Map();
  sent.length = 0;
  limited = false;
  state.suspended = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push((JSON.parse(init.body as string) as { query: string }).query);
      return Response.json({ result: { rows: [], metrics: { bytes_scanned: 1 } } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

async function newReport(extra: Record<string, unknown> = {}, user = 'user_alice') {
  const res = await reports(user).request('/api/panel/reports', json({ projectId: 'pnp_a', name: 'Signups', spec: TRENDS(), visibility: 'workspace', ...extra }));
  expect(res.status).toBe(201);
  return data<PanelReportDto>(res);
}

async function share(targetType: 'report' | 'dashboard', targetId: string, extra: Record<string, unknown> = {}, user = 'user_alice', grants = MEMBER) {
  return links(user, grants).request('/api/panel/share-links', json({ targetType, targetId, ...extra }));
}

async function shared(targetType: 'report' | 'dashboard', targetId: string, extra: Record<string, unknown> = {}) {
  const res = await share(targetType, targetId, extra);
  expect(res.status).toBe(201);
  return data<PanelCreatedShareLinkDto>(res);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

describe('creating, listing and revoking', () => {
  it('shows the token once and stores only its hash, here and in the master registry', async () => {
    const report = await newReport();
    events = [];
    const link = await shared('report', report.id, { allowDateChange: true });
    expect(link.token).toMatch(/^wpsh_[A-Za-z0-9]{32}$/);
    expect(link.url).toBe(`https://app-test.weldsuite.org/share/panel/${link.token}`);
    expect(link.prefix).toBe(`${link.token.slice(0, 9)}…`);
    expect(link).toMatchObject({ targetType: 'report', targetId: report.id, projectId: 'pnp_a', allowEmbed: false, allowDateChange: true, viewCount: 0 });

    const hash = await sha256Hex(link.token);
    const [row] = await db.select().from(panelShareLinks).where(eq(panelShareLinks.id, link.id));
    expect(row?.tokenHash).toBe(hash);
    expect(JSON.stringify(row)).not.toContain(link.token);
    const [registry] = await master.select().from(panelShareRegistry);
    expect(registry).toMatchObject({ tokenHash: hash, workspaceId: 'ws_alpha', projectId: 'pnp_a', linkId: link.id, revokedAt: null });

    expect(events).toMatchObject([{ entityType: 'panel_share_link', action: 'created', entityId: link.id }]);
    expect(JSON.stringify(events)).not.toContain(link.token);

    const listed = await data<PanelShareLinkDto[]>(await links().request(`/api/panel/share-links?targetType=report&targetId=${report.id}`));
    expect(listed.map((l) => l.id)).toEqual([link.id]);
    expect(JSON.stringify(listed)).not.toContain(link.token);
  });

  it('revokes in the tenant row and the registry, safely twice, and only for the creator or who may change the target', async () => {
    const report = await newReport();
    const link = await shared('report', report.id);
    events = [];
    expect((await links('user_bob').request(`/api/panel/share-links/${link.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await links('user_alice').request(`/api/panel/share-links/${link.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await links('user_alice').request(`/api/panel/share-links/${link.id}`, { method: 'DELETE' })).status).toBe(204);
    const [row] = await db.select().from(panelShareLinks);
    const [registry] = await master.select().from(panelShareRegistry);
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(registry?.revokedAt?.getTime()).toBe(row?.revokedAt?.getTime());
    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_share_link', 'deleted'],
      ['panel_share_link', 'deleted'],
    ]);
    expect((await publicApi().request(`/public/panel/share/${link.token}`)).status).toBe(404);
    expect((await links().request('/api/panel/share-links/pnsl_nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('shares only what the caller may change, with the permission', async () => {
    const bobsPrivate = await newReport({ visibility: 'private' }, 'user_bob');
    const bobsShared = await newReport({}, 'user_bob');
    expect((await share('report', bobsPrivate.id)).status).toBe(404);
    expect((await share('report', bobsShared.id)).status).toBe(403);
    expect((await share('report', bobsShared.id, {}, 'user_root', ADMIN)).status).toBe(201);
    expect((await share('report', bobsShared.id, {}, 'user_bob', READER)).status).toBe(403);
    expect((await share('report', 'pnr_nope')).status).toBe(404);
    expect((await links('user_bob', []).request(`/api/panel/share-links?targetType=report&targetId=${bobsShared.id}`)).status).toBe(403);
    expect((await share('report', bobsShared.id, { expiresAt: '2020-01-01T00:00:00Z' }, 'user_bob')).status).toBe(400);
  });
});

describe('people data never leaves', () => {
  async function refused(res: Response) {
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: PanelNotShareableDetails } };
    expect(body.error.code).toBe('NOT_SHAREABLE');
    return body.error.details.reasons.map((r) => r.reason);
  }

  it('refuses person, URL and element-text breakdowns', async () => {
    const person = await newReport({ spec: TRENDS({ breakdown: { source: 'person', key: '$email' } }) });
    expect(await refused(await share('report', person.id))).toEqual(['person_breakdown']);
    const url = await newReport({ spec: TRENDS({ breakdown: { source: 'column', field: 'url' } }) });
    expect(await refused(await share('report', url.id))).toEqual(['column_breakdown']);
    const elText = await newReport({ spec: { kind: 'funnel', projectId: 'pnp_a', steps: [{ event: 'A' }, { event: 'B' }], breakdown: { source: 'column', field: 'el_text' } } });
    expect(await refused(await share('report', elText.id))).toEqual(['column_breakdown']);
    const country = await newReport({ spec: TRENDS({ breakdown: { source: 'column', field: 'country' } }) });
    expect((await share('report', country.id)).status).toBe(201);
  });

  it('refuses kinds that are not aggregates and dashboards holding a refused report', async () => {
    expect(shareRefusals({ kind: 'signal' as never, spec: { kind: 'signal' } })).toEqual(['kind']);
    expect(shareRefusals({ kind: 'trends', spec: { kind: 'trends', breakdowns: [{ source: 'column', field: 'os' }, { source: 'person', key: 'plan' }] } })).toEqual(['person_breakdown']);
    expect(shareRefusals({ kind: 'funnel', spec: { kind: 'funnel', holdConstant: { source: 'person', key: 'plan' } } })).toEqual(['person_breakdown']);

    const person = await newReport({ spec: TRENDS({ breakdown: { source: 'person', key: 'plan' } }) });
    const board = await data<PanelDashboardDto>(await dashboards().request('/api/panel/dashboards', json({ projectId: 'pnp_a', name: 'Board', visibility: 'workspace' })));
    await dashboards().request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: person.id, layout: { x: 0, y: 0, w: 6, h: 4 } }));
    const reasons = await refused(await share('dashboard', board.id));
    expect(reasons).toEqual(['person_breakdown']);
  });

  it('stops showing a report that gained a person breakdown after it was shared', async () => {
    const report = await newReport();
    const link = await shared('report', report.id);
    expect((await publicApi().request(`/public/panel/share/${link.token}`)).status).toBe(200);
    await reports().request(`/api/panel/reports/${report.id}`, json({ spec: TRENDS({ breakdown: { source: 'person', key: '$email' } }) }, 'PATCH'));
    expect((await publicApi().request(`/public/panel/share/${link.token}`)).status).toBe(404);
    expect((await publicApi().request(`/public/panel/share/${link.token}/results`, json({}))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

describe('public share', () => {
  it('describes a shared report without filter values, cohort ids or the project id, and counts a view once a minute', async () => {
    const spec = TRENDS({ filters: [{ source: 'column', field: 'utm_campaign', operator: 'eq', value: 'black-friday' }, { source: 'cohort', cohortId: 'pnc_vip' }] });
    const report = await newReport({ spec, description: 'Weekly' });
    const link = await shared('report', report.id, { allowEmbed: true });
    const api = publicApi();

    const res = await api.request(`/public/panel/share/${link.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    await api.settled();
    const body = await data<PanelPublicShareDto>(res);
    expect(body).toMatchObject({ targetType: 'report', name: 'Signups', description: 'Weekly', projectName: 'Shop', allowEmbed: true, allowDateChange: false, datePresets: [], tiles: [] });
    const text = JSON.stringify(body);
    for (const secret of ['black-friday', 'secret-plan', 'pnc_vip', 'pnp_a']) expect(text).not.toContain(secret);
    expect(text).toContain('utm_campaign');
    expect(body.report?.kind).toBe('trends');

    await api.request(`/public/panel/share/${link.token}`);
    await api.settled();
    const [row] = await db.select().from(panelShareLinks);
    expect(row?.viewCount).toBe(1);
    expect(row?.lastViewedAt).toBeInstanceOf(Date);
  });

  it('answers 404 for malformed, unknown, revoked and expired tokens, suspended workspaces and deleted targets', async () => {
    const api = publicApi();
    expect((await api.request('/public/panel/share/not-a-token')).status).toBe(404);
    expect((await api.request(`/public/panel/share/wpsh_${'A'.repeat(32)}`)).status).toBe(404);

    const report = await newReport();
    const expiring = await shared('report', report.id, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await api.request(`/public/panel/share/${expiring.token}`)).status).toBe(200);
    await db.update(panelShareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(panelShareLinks.id, expiring.id));
    expect((await api.request(`/public/panel/share/${expiring.token}`)).status).toBe(404);
    await master.update(panelShareRegistry).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(panelShareRegistry.linkId, expiring.id));
    expect((await api.request(`/public/panel/share/${expiring.token}/results`, json({}))).status).toBe(404);

    const live = await shared('report', report.id);
    state.suspended = true;
    expect((await api.request(`/public/panel/share/${live.token}`)).status).toBe(404);
    state.suspended = false;
    await master.update(panelShareRegistry).set({ workspaceId: 'ws_gone' }).where(eq(panelShareRegistry.linkId, live.id));
    expect((await api.request(`/public/panel/share/${live.token}`)).status).toBe(404);
    await master.update(panelShareRegistry).set({ workspaceId: 'ws_alpha' }).where(eq(panelShareRegistry.linkId, live.id));
    expect((await api.request(`/public/panel/share/${live.token}`)).status).toBe(200);

    await reports().request(`/api/panel/reports/${report.id}`, { method: 'DELETE' });
    expect((await api.request(`/public/panel/share/${live.token}`)).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('stops working when the link creator can no longer see the target', async () => {
    const report = await newReport();
    const res = await share('report', report.id, {}, 'user_root', ADMIN);
    const link = await data<PanelCreatedShareLinkDto>(res);
    expect((await publicApi().request(`/public/panel/share/${link.token}`)).status).toBe(200);
    await reports().request(`/api/panel/reports/${report.id}`, json({ visibility: 'private' }, 'PATCH'));
    expect((await publicApi().request(`/public/panel/share/${link.token}`)).status).toBe(404);
  });

  it('runs a shared report through the query cache, scoped to its workspace and project, with a preset only when allowed', async () => {
    const report = await newReport();
    const fixed = await shared('report', report.id);
    const api = publicApi();
    const first = await api.request(`/public/panel/share/${fixed.token}/results`, json({ dateRange: { preset: '7d' } }));
    expect(first.status).toBe(200);
    const result = await data<PanelQueryResponse>(first);
    expect(result.kind).toBe('trends');
    expect(sent.length).toBeGreaterThan(0);
    for (const sql of sent) {
      expect(sql).toContain("workspace_id = 'ws_alpha'");
      expect(sql).toContain("project_id = 'pnp_a'");
    }
    if (result.kind !== 'trends') throw new Error('kind');
    const fixedFrom = result.result.range.from;

    const movable = await shared('report', report.id, { allowDateChange: true });
    const moved = await data<PanelQueryResponse>(await api.request(`/public/panel/share/${movable.token}/results`, json({ dateRange: { preset: '7d' } })));
    if (moved.kind !== 'trends') throw new Error('kind');
    expect(new Date(moved.result.range.from).getTime()).toBeGreaterThan(new Date(fixedFrom).getTime());
    const again = await data<PanelQueryResponse>(await api.request(`/public/panel/share/${movable.token}/results`, json({ dateRange: { preset: '7d' } })));
    expect(again.cached).toBe(true);

    expect((await api.request(`/public/panel/share/${movable.token}/results`, json({ dateRange: { from: '2026-01-01', to: '2026-01-31' } }))).status).toBe(400);
    expect((await api.request(`/public/panel/share/${movable.token}/results`, json({ tileId: 'pnt_x' }))).status).toBe(404);
  });

  it('shows a dashboard\'s text tiles and shareable report tiles, with its filters applied and their values hidden', async () => {
    const visible = await newReport();
    const bobsPrivate = await newReport({ visibility: 'private', name: 'Bob only' }, 'user_bob');
    const board = await data<PanelDashboardDto>(
      await dashboards().request(
        '/api/panel/dashboards',
        json({ projectId: 'pnp_a', name: 'Growth', visibility: 'workspace', filters: { filters: [{ source: 'column', field: 'country', operator: 'eq', value: 'NL' }] } }),
      ),
    );
    const layout = { x: 0, y: 0, w: 6, h: 4 };
    const text = await data<PanelDashboardTileDto>(await dashboards().request(`/api/panel/dashboards/${board.id}/tiles`, json({ kind: 'text', text: '## Growth', layout })));
    const tile = await data<PanelDashboardTileDto>(await dashboards().request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: visible.id, layout })));
    // A tile of a report the link's creator cannot see (put there directly).
    await db.insert(panelDashboardTiles).values({ id: 'pnt_hidden', dashboardId: board.id, kind: 'report', reportId: bobsPrivate.id, layout });
    const link = await shared('dashboard', board.id);

    const api = publicApi();
    const body = await data<PanelPublicShareDto>(await api.request(`/public/panel/share/${link.token}`));
    expect(body.targetType).toBe('dashboard');
    expect(body.report).toBeNull();
    expect(body.tiles.map((t) => [t.id, t.kind])).toEqual([
      [text.id, 'text'],
      [tile.id, 'report'],
    ]);
    expect(body.tiles[0]?.text).toBe('## Growth');
    expect(JSON.stringify(body)).not.toContain('"NL"');
    expect(JSON.stringify(body)).not.toContain('Bob only');

    const res = await api.request(`/public/panel/share/${link.token}/results`, json({ tileId: tile.id }));
    expect(res.status).toBe(200);
    expect(sent.some((sql) => sql.includes("'NL'"))).toBe(true);
    expect((await api.request(`/public/panel/share/${link.token}/results`, json({ tileId: text.id }))).status).toBe(404);
    expect((await api.request(`/public/panel/share/${link.token}/results`, json({ tileId: 'pnt_hidden' }))).status).toBe(404);
    expect((await api.request(`/public/panel/share/${link.token}/results`, json({}))).status).toBe(404);
  });

  it('limits requests per address', async () => {
    const report = await newReport();
    const link = await shared('report', report.id);
    limited = true;
    const res = await publicApi().request(`/public/panel/share/${link.token}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(res.status).toBe(429);
    // No address (local dev): not limited.
    expect((await publicApi().request(`/public/panel/share/${link.token}`)).status).toBe(200);
  });

  it('strips values wherever a spec keeps filters', () => {
    const stripped = publicSpec({
      kind: 'funnel',
      projectId: 'pnp_a',
      steps: [{ event: 'A', filters: [{ source: 'person', key: '$email', operator: 'eq', value: 'a@b.c' }] }],
      exclusions: [{ event: 'X', filters: [{ source: 'group', groupType: 'company', key: 'name', operator: 'in', value: ['Acme'] }] }],
    });
    expect(JSON.stringify(stripped)).not.toMatch(/a@b\.c|Acme|pnp_a/);
    expect(stripped).toMatchObject({ kind: 'funnel', steps: [{ event: 'A', filters: [{ source: 'person', key: '$email', operator: 'eq' }] }] });
  });
});
