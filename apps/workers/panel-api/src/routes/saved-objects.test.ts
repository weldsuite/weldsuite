/**
 * DB-backed tests (pglite) for /api/panel/reports, /dashboards and /cohorts.
 *
 * What must not regress:
 *   1. A private report or dashboard is its owner's alone: a 404 for everyone
 *      else, admins included; shared ones are visible to all with read access.
 *   2. Only the owner (or `panel_projects:manage` on a shared object) changes
 *      or deletes.
 *   3. A dashboard tile can only show a report the caller may see, of the same
 *      project; the detail leaves out reports the caller cannot see.
 *   4. Every mutation publishes an entity event without the spec or filter.
 *   5. Deleting a report takes it off every dashboard.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type {
  PanelCohortDto,
  PanelDashboardDetailDto,
  PanelDashboardDto,
  PanelReportDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import reportsRoutes from './reports';
import dashboardsRoutes from './dashboards';
import cohortsRoutes from './cohorts';
import type { Env, Variables } from '../types';

const { panelProjects, panelReports, panelDashboards, panelDashboardTiles, panelCohorts } = schema;

const MEMBER = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const ADMIN = [...MEMBER, 'panel_projects:manage'];
const READER = ['panel_reports:read'];

let db: Database;
let events: EntityEventMessage[] = [];
const queue = {
  send: async (message: EntityEventMessage) => {
    events.push(message);
  },
} as unknown as Queue<EntityEventMessage>;

type Router = Hono<{ Bindings: Env; Variables: Variables }>;

function app(base: string, router: Router, userId: string, grants: string[] = MEMBER) {
  return createTestApp(base, router, {
    context: { permissions: permissions(...grants), tenantDb: db, userId, orgId: 'org_alpha', workspaceId: 'ws_alpha', clerkOrgId: 'org_alpha' },
    env: { ENTITY_EVENTS: queue, PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org' },
  });
}

const reports = (user: string, grants?: string[]) => app('/api/panel/reports', reportsRoutes, user, grants);
const dashboards = (user: string, grants?: string[]) => app('/api/panel/dashboards', dashboardsRoutes, user, grants);
const cohorts = (user: string, grants?: string[]) => app('/api/panel/cohorts', cohortsRoutes, user, grants);

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

const TRENDS = (projectId: string) => ({
  kind: 'trends',
  projectId,
  dateRange: { preset: '30d' },
  series: [{ event: '$pageview', math: 'unique_users' }],
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  await db.delete(panelDashboardTiles);
  await db.delete(panelDashboards);
  await db.delete(panelReports);
  await db.delete(panelCohorts);
  await db.delete(panelProjects);
  events = [];
  for (const id of ['pnp_a', 'pnp_b']) {
    await db.insert(panelProjects).values({
      id,
      name: id,
      token: `wpk_${id}`,
      settings: DEFAULT_PANEL_SETTINGS,
      createdByUserId: 'user_alice',
    });
  }
});

async function newReport(user: string, extra: Record<string, unknown> = {}, projectId = 'pnp_a') {
  const res = await reports(user).request('/api/panel/reports', json({ projectId, name: 'Weekly visitors', spec: TRENDS(projectId), ...extra }));
  expect(res.status).toBe(201);
  return data<PanelReportDto>(res);
}

describe('reports', () => {
  it('creates a private report, with the kind taken from the spec, and publishes an event without the spec', async () => {
    const report = await newReport('user_alice');
    expect(report).toMatchObject({ projectId: 'pnp_a', kind: 'trends', name: 'Weekly visitors', visibility: 'private', ownerUserId: 'user_alice' });
    expect(report.id).toMatch(/^pnr_/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityType: 'panel_report', action: 'created', entityId: report.id });
    expect(JSON.stringify(events[0])).not.toContain('series');
  });

  it('refuses an unknown project, a spec for another project and a bad spec', async () => {
    const api = reports('user_alice');
    expect((await api.request('/api/panel/reports', json({ projectId: 'pnp_x', name: 'n', spec: TRENDS('pnp_x') }))).status).toBe(404);
    expect((await api.request('/api/panel/reports', json({ projectId: 'pnp_a', name: 'n', spec: TRENDS('pnp_b') }))).status).toBe(400);
    expect((await api.request('/api/panel/reports', json({ projectId: 'pnp_a', name: 'n', spec: { ...TRENDS('pnp_a'), series: [{ event: "x' OR 1=1" }] } }))).status).toBe(400);
    expect((await api.request('/api/panel/reports', json({ projectId: 'pnp_a', name: 'n', spec: { kind: 'sessions', projectId: 'pnp_a' } }))).status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it("keeps a private report to its owner, even from an admin, and shows shared ones to everyone", async () => {
    const mine = await newReport('user_alice');
    const shared = await newReport('user_alice', { name: 'Shared', visibility: 'workspace' });

    const bobList = await data<PanelReportDto[]>(await reports('user_bob').request('/api/panel/reports'));
    expect(bobList.map((r) => r.id)).toEqual([shared.id]);
    expect((await reports('user_bob').request(`/api/panel/reports/${mine.id}`)).status).toBe(404);
    expect((await reports('user_root', ADMIN).request(`/api/panel/reports/${mine.id}`)).status).toBe(404);
    expect((await reports('user_bob').request(`/api/panel/reports/${shared.id}`)).status).toBe(200);

    const aliceList = await data<PanelReportDto[]>(await reports('user_alice').request('/api/panel/reports'));
    expect(aliceList).toHaveLength(2);
    expect(await data<PanelReportDto[]>(await reports('user_alice').request('/api/panel/reports?scope=shared'))).toHaveLength(1);
    expect(await data<PanelReportDto[]>(await reports('user_bob').request('/api/panel/reports?scope=mine'))).toHaveLength(0);
  });

  it('filters the list by project and kind', async () => {
    await newReport('user_alice');
    await newReport('user_alice', { spec: { kind: 'funnel', projectId: 'pnp_b', steps: [{ event: 'A' }, { event: 'B' }] } }, 'pnp_b');
    const api = reports('user_alice');
    expect(await data<PanelReportDto[]>(await api.request('/api/panel/reports?projectId=pnp_b'))).toHaveLength(1);
    expect(await data<PanelReportDto[]>(await api.request('/api/panel/reports?kind=funnel'))).toHaveLength(1);
    expect(await data<PanelReportDto[]>(await api.request('/api/panel/reports?kind=trends&projectId=pnp_b'))).toHaveLength(0);
  });

  it('lets the owner update, and a manager change a shared report, but nobody else', async () => {
    const shared = await newReport('user_alice', { visibility: 'workspace' });
    const priv = await newReport('user_alice');

    const renamed = await reports('user_alice').request(`/api/panel/reports/${priv.id}`, json({ name: 'Renamed', visibility: 'workspace' }, 'PATCH'));
    expect(renamed.status).toBe(200);
    expect(await data<PanelReportDto>(renamed)).toMatchObject({ name: 'Renamed', visibility: 'workspace' });

    expect((await reports('user_bob').request(`/api/panel/reports/${shared.id}`, json({ name: 'Bob was here' }, 'PATCH'))).status).toBe(403);
    expect((await reports('user_root', ADMIN).request(`/api/panel/reports/${shared.id}`, json({ name: 'Admin edit' }, 'PATCH'))).status).toBe(200);
    expect((await reports('user_bob').request(`/api/panel/reports/${shared.id}`, { method: 'DELETE' })).status).toBe(403);
    expect(events.filter((e) => e.action === 'updated')).toHaveLength(2);
  });

  it('keeps the kind in step with a new spec, and refuses a spec of another project', async () => {
    const report = await newReport('user_alice');
    const api = reports('user_alice');
    const res = await api.request(
      `/api/panel/reports/${report.id}`,
      json({ spec: { kind: 'retention', projectId: 'pnp_a', firstEvent: 'Signed up' } }, 'PATCH'),
    );
    expect(await data<PanelReportDto>(res)).toMatchObject({ kind: 'retention' });
    const other = await api.request(`/api/panel/reports/${report.id}`, json({ spec: TRENDS('pnp_b') }, 'PATCH'));
    expect(other.status).toBe(400);
    expect((await api.request(`/api/panel/reports/${report.id}`, json({}, 'PATCH'))).status).toBe(400);
  });

  it('refuses writes without the permission', async () => {
    const reader = reports('user_alice', READER);
    expect((await reader.request('/api/panel/reports', json({ projectId: 'pnp_a', name: 'n', spec: TRENDS('pnp_a') }))).status).toBe(403);
    expect((await reader.request('/api/panel/reports')).status).toBe(200);
  });

  it('deletes softly, takes the report off dashboards and publishes', async () => {
    const report = await newReport('user_alice', { visibility: 'workspace' });
    const board = await data<PanelDashboardDto>(
      await dashboards('user_alice').request('/api/panel/dashboards', json({ projectId: 'pnp_a', name: 'Board' })),
    );
    await dashboards('user_alice').request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: report.id, layout: { x: 0, y: 0, w: 6, h: 4 } }));
    events = [];

    expect((await reports('user_alice').request(`/api/panel/reports/${report.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await reports('user_alice').request(`/api/panel/reports/${report.id}`)).status).toBe(404);
    expect(await db.select().from(panelDashboardTiles)).toHaveLength(0);
    expect(events).toMatchObject([{ entityType: 'panel_report', action: 'deleted', entityId: report.id }]);
    expect((await reports('user_alice').request(`/api/panel/reports/${report.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('dashboards', () => {
  async function newBoard(user: string, extra: Record<string, unknown> = {}) {
    const res = await dashboards(user).request('/api/panel/dashboards', json({ projectId: 'pnp_a', name: 'Marketing', ...extra }));
    expect(res.status).toBe(201);
    return data<PanelDashboardDto>(res);
  }
  const layout = { x: 0, y: 0, w: 6, h: 4 };

  it('creates, lists, renames and deletes with events; private boards are the owner\'s', async () => {
    const board = await newBoard('user_alice');
    expect(board).toMatchObject({ visibility: 'private', ownerUserId: 'user_alice' });
    expect(board.id).toMatch(/^pnd_/);
    expect(await data<PanelDashboardDto[]>(await dashboards('user_bob').request('/api/panel/dashboards'))).toHaveLength(0);
    expect((await dashboards('user_bob').request(`/api/panel/dashboards/${board.id}`)).status).toBe(404);

    const patched = await dashboards('user_alice').request(`/api/panel/dashboards/${board.id}`, json({ name: 'Growth', visibility: 'workspace' }, 'PATCH'));
    expect(await data<PanelDashboardDto>(patched)).toMatchObject({ name: 'Growth', visibility: 'workspace' });
    expect((await dashboards('user_bob').request(`/api/panel/dashboards/${board.id}`)).status).toBe(200);
    expect((await dashboards('user_bob').request(`/api/panel/dashboards/${board.id}`, json({ name: 'x' }, 'PATCH'))).status).toBe(403);

    expect((await dashboards('user_alice').request(`/api/panel/dashboards/${board.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_dashboard', 'created'],
      ['panel_dashboard', 'updated'],
      ['panel_dashboard', 'deleted'],
    ]);
  });

  it('adds tiles only for reports the caller may see, of the same project', async () => {
    const board = await newBoard('user_alice', { visibility: 'workspace' });
    const alicePrivate = await newReport('user_alice');
    const bobsShared = await newReport('user_bob', { visibility: 'workspace' });
    const otherProject = await newReport('user_alice', { visibility: 'workspace' }, 'pnp_b');
    const api = dashboards('user_alice');

    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: alicePrivate.id, layout }))).status).toBe(201);
    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: bobsShared.id, layout }))).status).toBe(201);
    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: otherProject.id, layout }))).status).toBe(404);
    // Bob's private report is invisible to Alice.
    const bobPrivate = await newReport('user_bob');
    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: bobPrivate.id, layout }))).status).toBe(404);
    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: 'pnr_nope', layout }))).status).toBe(404);
  });

  it('shows the detail with only the reports the viewer may see', async () => {
    const board = await newBoard('user_alice', { visibility: 'workspace' });
    const priv = await newReport('user_alice');
    const shared = await newReport('user_alice', { visibility: 'workspace' });
    const api = dashboards('user_alice');
    await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: priv.id, layout }));
    await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: shared.id, layout }));

    const own = await data<PanelDashboardDetailDto>(await api.request(`/api/panel/dashboards/${board.id}`));
    expect(own.tiles).toHaveLength(2);
    expect(own.reports.map((r) => r.id).sort()).toEqual([priv.id, shared.id].sort());

    const bob = await data<PanelDashboardDetailDto>(await dashboards('user_bob').request(`/api/panel/dashboards/${board.id}`));
    expect(bob.tiles.map((t) => t.reportId)).toEqual([shared.id]);
    expect(bob.reports.map((r) => r.id)).toEqual([shared.id]);
  });

  it('moves, resizes, lays out and removes tiles, each an updated event', async () => {
    const board = await newBoard('user_alice');
    const a = await newReport('user_alice');
    const b = await newReport('user_alice', { name: 'B' });
    const api = dashboards('user_alice');
    const tileA = await data<{ id: string }>(await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: a.id, layout })));
    const tileB = await data<{ id: string }>(await api.request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: b.id, layout })));
    events = [];

    const moved = await api.request(`/api/panel/dashboards/${board.id}/tiles/${tileA.id}`, json({ layout: { x: 6, y: 2, w: 3, h: 3 } }, 'PATCH'));
    expect((await data<{ layout: unknown }>(moved)).layout).toEqual({ x: 6, y: 2, w: 3, h: 3 });

    const laid = await api.request(
      `/api/panel/dashboards/${board.id}/layout`,
      json({ tiles: [{ id: tileA.id, layout: { x: 0, y: 0, w: 12, h: 2 } }, { id: tileB.id, layout: { x: 0, y: 2, w: 12, h: 2 } }] }, 'PUT'),
    );
    expect(laid.status).toBe(200);
    expect((await data<PanelDashboardDetailDto>(laid)).tiles.map((t) => t.layout.y).sort()).toEqual([0, 2]);

    // One unknown tile changes nothing.
    const bad = await api.request(
      `/api/panel/dashboards/${board.id}/layout`,
      json({ tiles: [{ id: tileA.id, layout: { x: 1, y: 1, w: 1, h: 1 } }, { id: 'pnt_nope', layout: { x: 1, y: 1, w: 1, h: 1 } }] }, 'PUT'),
    );
    expect(bad.status).toBe(400);
    const after = await data<PanelDashboardDetailDto>(await api.request(`/api/panel/dashboards/${board.id}`));
    expect(after.tiles.find((t) => t.id === tileA.id)?.layout).toEqual({ x: 0, y: 0, w: 12, h: 2 });

    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles/${tileA.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api.request(`/api/panel/dashboards/${board.id}/tiles/${tileA.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_dashboard', 'updated'],
      ['panel_dashboard', 'updated'],
      ['panel_dashboard', 'updated'],
    ]);
  });

  it('refuses a layout outside the grid and another user changing tiles', async () => {
    const board = await newBoard('user_alice', { visibility: 'workspace' });
    const report = await newReport('user_alice', { visibility: 'workspace' });
    const tile = await data<{ id: string }>(
      await dashboards('user_alice').request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: report.id, layout })),
    );
    expect((await dashboards('user_alice').request(`/api/panel/dashboards/${board.id}/tiles/${tile.id}`, json({ layout: { x: 30, y: 0, w: 1, h: 1 } }, 'PATCH'))).status).toBe(400);
    expect((await dashboards('user_bob').request(`/api/panel/dashboards/${board.id}/tiles/${tile.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await dashboards('user_bob').request(`/api/panel/dashboards/${board.id}/tiles`, json({ reportId: report.id, layout }))).status).toBe(403);
  });
});

describe('cohorts', () => {
  const filter = {
    match: 'all',
    conditions: [
      { type: 'person_property', key: 'plan', operator: 'eq', value: 'pro' },
      { type: 'performed', event: 'Signed up', withinDays: 30, negate: false },
    ],
  };

  async function newCohort(user: string) {
    const res = await cohorts(user).request('/api/panel/cohorts', json({ projectId: 'pnp_a', name: 'Pro signups', filter }));
    expect(res.status).toBe(201);
    return data<PanelCohortDto>(res);
  }

  it('creates, reads, updates and deletes with events that leave the filter off the bus', async () => {
    const cohort = await newCohort('user_alice');
    expect(cohort.id).toMatch(/^pnc_/);
    expect(cohort.filter).toMatchObject({ match: 'all' });

    const api = cohorts('user_alice');
    expect(await data<PanelCohortDto[]>(await api.request('/api/panel/cohorts?projectId=pnp_a'))).toHaveLength(1);
    expect(await data<PanelCohortDto[]>(await api.request('/api/panel/cohorts?projectId=pnp_b'))).toHaveLength(0);
    const patched = await api.request(`/api/panel/cohorts/${cohort.id}`, json({ name: 'Pro', description: 'Paying' }, 'PATCH'));
    expect(await data<PanelCohortDto>(patched)).toMatchObject({ name: 'Pro', description: 'Paying' });
    expect((await api.request(`/api/panel/cohorts/${cohort.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api.request(`/api/panel/cohorts/${cohort.id}`)).status).toBe(404);

    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_cohort', 'created'],
      ['panel_cohort', 'updated'],
      ['panel_cohort', 'deleted'],
    ]);
    expect(JSON.stringify(events)).not.toContain('conditions');
  });

  it('refuses a filter that is empty, nested or has bad values', async () => {
    const api = cohorts('user_alice');
    const post = (f: unknown) => api.request('/api/panel/cohorts', json({ projectId: 'pnp_a', name: 'x', filter: f }));
    expect((await post({ match: 'all', conditions: [] })).status).toBe(400);
    expect((await post({ conditions: [{ type: 'person_property', key: "a'b", operator: 'eq', value: 'x' }] })).status).toBe(400);
    expect((await post({ conditions: [{ type: 'performed', event: 'A', withinDays: 5, filters: [{ source: 'cohort', cohortId: 'pnc_1' }] }] })).status).toBe(400);
    expect((await api.request('/api/panel/cohorts', json({ projectId: 'pnp_x', name: 'x', filter }))).status).toBe(404);
  });

  it('lets only the owner or a manager change it', async () => {
    const cohort = await newCohort('user_alice');
    expect((await cohorts('user_bob').request(`/api/panel/cohorts/${cohort.id}`, json({ name: 'Mine now' }, 'PATCH'))).status).toBe(403);
    expect((await cohorts('user_bob').request(`/api/panel/cohorts/${cohort.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await cohorts('user_root', ADMIN).request(`/api/panel/cohorts/${cohort.id}`, json({ name: 'Renamed' }, 'PATCH'))).status).toBe(200);
    expect((await cohorts('user_bob', READER).request('/api/panel/cohorts')).status).toBe(200);
    expect((await cohorts('user_bob', READER).request('/api/panel/cohorts', json({ projectId: 'pnp_a', name: 'x', filter }))).status).toBe(403);
  });
});
