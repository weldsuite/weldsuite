/**
 * DB-backed integration tests for /api/project-analytics report/chart routes.
 *
 * Covers chart creation, charts-data (TASK-767 / TASK-823: validated body,
 * WeldFlow-only entities, project scoping) and report ownership (TASK-823).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { projectAnalyticsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';

const analyticsMock = vi.hoisted(() => ({ queryAnalytics: vi.fn() }));
vi.mock('@weldsuite/core-domain/analytics-query', () => analyticsMock);

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedReport(createdById: string | null = null): Promise<string> {
  const id = generateId('rpt');
  const now = new Date();
  await db.insert(schema.analyticsReports).values({
    id,
    app: 'projects',
    title: 'Seeded report',
    description: '',
    createdById,
    chartCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

const chartBody = {
  title: 'Total tasks',
  chartType: 'bar',
  entity: 'tasks',
  metric: 'total_tasks',
};

function app() {
  return createTestApp('/api/project-analytics', projectAnalyticsRoutes, {
    context: {
      permissions: permissions('projects:read', 'projects:create', 'projects:scope:all'),
      tenantDb: db,
    },
  });
}

describe('/api/project-analytics charts · pglite integration', () => {
  it('POST /reports/:id/charts creates a chart for an existing report', async () => {
    const reportId = await seedReport();
    const { request } = app();

    const res = await request(`/api/project-analytics/reports/${reportId}/charts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chartBody),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^cht_/);
  });

  it('POST /reports/:id/charts answers 404 (not 500) for an unknown report', async () => {
    const { request } = app();

    const res = await request('/api/project-analytics/reports/undefined/charts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chartBody),
    });

    expect(res.status).toBe(404);
  });

  it('GET /reports/:id/charts answers 404 for an unknown report', async () => {
    const { request } = app();

    const res = await request('/api/project-analytics/reports/rpt_missing/charts');

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// charts-data
// ---------------------------------------------------------------------------

const PROJECT = 'prj_an_member';
const FOREIGN_PROJECT = 'prj_an_foreign';

async function seedProjectWithMember(id: string, userId: string | null) {
  const now = new Date();
  await db
    .insert(schema.projects)
    .values({
      id,
      name: id,
      projectManagerId: 'someone_else',
      createdAt: now,
      updatedAt: now,
    } as typeof schema.projects.$inferInsert)
    .onConflictDoNothing();
  if (userId) {
    await db
      .insert(schema.projectMembers)
      .values({
        id: `pm_${id}_${userId}`,
        projectId: id,
        userId,
        role: 'member',
        isActive: true,
        createdAt: now,
        updatedAt: now,
        joinedAt: now,
      } as typeof schema.projectMembers.$inferInsert)
      .onConflictDoNothing();
  }
}

function appAs(userId: string, ...extra: string[]) {
  return createTestApp('/api/project-analytics', projectAnalyticsRoutes, {
    context: {
      userId,
      permissions: permissions('projects:read', 'projects:create', 'projects:update', 'projects:delete', ...extra),
      tenantDb: db,
    },
  }).request;
}

type Send = ReturnType<typeof appAs>;

const postInit = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const chart = (overrides: Record<string, unknown> = {}) => ({
  chartId: 'c1',
  entity: 'tasks',
  metric: 'total_tasks',
  timeRange: 'last_30_days',
  groupBy: 'day',
  aggregation: 'sum',
  sortOrder: 'asc',
  ...overrides,
});

/**
 * What the analytics store answers. In conformance mode it is what a
 * deployment without one answers (no points): the Kubernetes editions have no
 * Cloudflare analytics store, so the Rust backend serves every chart empty.
 */
const POINTS = conformanceTarget() ? [] : [{ label: '2026-10-01', value: 3 }];

describe('POST /reports/:id/charts-data', () => {
  beforeEach(() => {
    analyticsMock.queryAnalytics.mockReset();
    analyticsMock.queryAnalytics.mockResolvedValue(POINTS);
  });

  beforeAll(async () => {
    await seedProjectWithMember(PROJECT, 'user_an_member');
    await seedProjectWithMember(FOREIGN_PROJECT, null);
  });

  async function chartsData(request: Send, charts: unknown[], reportId?: string) {
    const id = reportId ?? (await seedReport());
    return request(`/api/project-analytics/reports/${id}/charts-data`, postInit({ charts }));
  }

  it('answers { data: { [chartId]: points } }', async () => {
    const res = await chartsData(appAs('user_an_member'), [chart()]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { c1: POINTS } });
  });

  it('rejects another module’s entities, a non-integer limit and a malformed metric', async () => {
    const request = appAs('user_an_member');

    expect((await chartsData(request, [chart({ entity: 'tickets' })])).status).toBe(400);
    expect((await chartsData(request, [chart({ entity: 'leads' })])).status).toBe(400);
    expect((await chartsData(request, [chart({ limit: '10; DROP TABLE x' })])).status).toBe(400);
    expect((await chartsData(request, [chart({ limit: 2.5 })])).status).toBe(400);
    expect((await chartsData(request, [chart({ metric: "x'; --" })])).status).toBe(400);
    expect(analyticsMock.queryAnalytics).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown report', async () => {
    const res = await chartsData(appAs('user_an_member'), [chart()], 'rpt_nope');
    expect(res.status).toBe(404);
  });

  it('limits a member to the projects they belong to', async () => {
    await chartsData(appAs('user_an_member'), [chart()]);

    expect(analyticsMock.queryAnalytics).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ projectIds: [PROJECT] }),
    );
  });

  it('lets a projects:scope:all holder see the whole workspace', async () => {
    await chartsData(appAs('user_an_admin', 'projects:scope:all'), [chart()]);

    const params = analyticsMock.queryAnalytics.mock.calls[0]?.[2];
    expect(params.projectIds).toBeNull();
  });

  it('narrows a chart to one project the caller can access, and refuses one they cannot', async () => {
    const member = appAs('user_an_member');

    expect((await chartsData(member, [chart({ projectId: PROJECT })])).status).toBe(200);
    expect(analyticsMock.queryAnalytics).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ projectId: PROJECT }),
    );

    analyticsMock.queryAnalytics.mockClear();
    expect((await chartsData(member, [chart({ projectId: FOREIGN_PROJECT })])).status).toBe(403);
    expect(analyticsMock.queryAnalytics).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// report ownership
// ---------------------------------------------------------------------------

describe('report ownership', () => {
  const put = (request: Send, id: string) =>
    request(`/api/project-analytics/reports/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed' }),
    });

  it('only the owner or an admin can rename, delete or add charts', async () => {
    const id = await seedReport('user_an_owner');
    const other = appAs('user_an_other');

    expect((await put(other, id)).status).toBe(403);
    expect((await other(`/api/project-analytics/reports/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await other(`/api/project-analytics/reports/${id}/charts`, postInit(chartBody))).status).toBe(403);

    expect((await put(appAs('user_an_owner'), id)).status).toBe(200);
    expect((await put(appAs('user_an_admin', 'projects:scope:all'), id)).status).toBe(200);
    expect((await appAs('user_an_owner')(`/api/project-analytics/reports/${id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('keeps reports without an owner editable and answers 404 for a missing report', async () => {
    const legacy = await seedReport(null);
    expect((await put(appAs('user_an_other'), legacy)).status).toBe(200);
    expect((await put(appAs('user_an_other'), 'rpt_missing')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// reports and charts
// ---------------------------------------------------------------------------

describe('reports and charts', () => {
  const owner = () => appAs('user_rc_owner');
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('creates, lists, reads and duplicates a report with its charts', async () => {
    const request = owner();
    expect((await request('/api/project-analytics/reports', json('POST', { title: '' }))).status).toBe(400);
    const created = await request('/api/project-analytics/reports', json('POST', { title: 'Delivery', description: 'Weekly' }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const first = await request(
      `/api/project-analytics/reports/${data.id}/charts`,
      postInit({ ...chartBody, layout: { x: 0, y: 0, w: 4, h: 3, extra: 1 }, limit: 0 }),
    );
    expect(first.status).toBe(201);
    const second = await request(
      `/api/project-analytics/reports/${data.id}/charts`,
      postInit({ ...chartBody, title: 'Hours', entity: 'time_entries', color: '', smoothCurve: false, limit: 5 }),
    );
    expect(second.status).toBe(201);

    const list = await request('/api/project-analytics/reports');
    expect(list.status).toBe(200);
    const reports = (await list.json()) as { data: { id: string; chartCount: number }[] };
    expect(reports.data.find((report) => report.id === data.id)?.chartCount).toBe(2);

    const detail = await request(`/api/project-analytics/reports/${data.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      data: { report: { title: string }; charts: { title: string; sortIndex: number }[] };
    };
    expect(body.data.report.title).toBe('Delivery');
    expect(body.data.charts.map((chart) => chart.sortIndex)).toEqual([0, 1]);
    expect((await request('/api/project-analytics/reports/rpt_missing')).status).toBe(404);

    const copy = await request(`/api/project-analytics/reports/${data.id}/duplicate`, { method: 'POST' });
    expect(copy.status).toBe(201);
    const { data: copied } = (await copy.json()) as { data: { id: string } };
    const copiedCharts = await request(`/api/project-analytics/reports/${copied.id}/charts`);
    expect(((await copiedCharts.json()) as { data: unknown[] }).data).toHaveLength(2);
    expect((await request('/api/project-analytics/reports/rpt_missing/duplicate', { method: 'POST' })).status).toBe(404);
  });

  it('moves, duplicates and deletes charts', async () => {
    const request = owner();
    const created = await request('/api/project-analytics/reports', json('POST', { title: 'Board' }));
    const { data: report } = (await created.json()) as { data: { id: string } };
    const chart = await request(`/api/project-analytics/reports/${report.id}/charts`, postInit(chartBody));
    const { data } = (await chart.json()) as { data: { id: string } };

    const moved = await request(
      `/api/project-analytics/reports/${report.id}/charts/layouts`,
      json('PATCH', { layouts: [{ chartId: data.id, layout: { x: 6, y: 2, w: 6, h: 5 } }] }),
    );
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ data: { updated: 1 } });
    const invalid = await request(
      `/api/project-analytics/reports/${report.id}/charts/layouts`,
      json('PATCH', { layouts: [{ chartId: data.id }] }),
    );
    expect(invalid.status).toBe(400);

    const copy = await request(`/api/project-analytics/reports/${report.id}/charts/${data.id}/duplicate`, {
      method: 'POST',
    });
    expect(copy.status).toBe(201);
    const missing = await request(`/api/project-analytics/reports/${report.id}/charts/cht_missing/duplicate`, {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
    const charts = (await (await request(`/api/project-analytics/reports/${report.id}/charts`)).json()) as {
      data: { title: string; layout: { y: number } }[];
    };
    expect(charts.data.map((c) => c.title)).toEqual(['Total tasks', 'Total tasks (Copy)']);
    expect(charts.data[1]?.layout.y).toBe(7);

    const removed = await request(`/api/project-analytics/reports/${report.id}/charts/${data.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true });
    const after = (await (await request(`/api/project-analytics/reports/${report.id}`)).json()) as {
      data: { report: { chartCount: number } };
    };
    expect(after.data.report.chartCount).toBe(1);

    // A colleague cannot change the owner's report.
    const other = appAs('user_rc_other');
    expect((await other(`/api/project-analytics/reports/${report.id}/charts/${data.id}`, { method: 'DELETE' })).status).toBe(
      403,
    );
    expect(
      (await other(`/api/project-analytics/reports/${report.id}/charts/layouts`, json('PATCH', { layouts: [] }))).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// KPI summaries
// ---------------------------------------------------------------------------

describe('KPI summaries', () => {
  const SUMMARY_PROJECT = 'prj_kpi_member';
  const OTHER_PROJECT = 'prj_kpi_other';

  beforeAll(async () => {
    await seedProjectWithMember(SUMMARY_PROJECT, 'user_kpi');
    await seedProjectWithMember(OTHER_PROJECT, null);
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
    const yesterday = new Date(today.getTime() - 86_400_000);
    await db.insert(schema.tasks).values([
      {
        id: 'task_kpi_done',
        title: 'Done',
        projectId: SUMMARY_PROJECT,
        status: 'done',
        priority: 'high',
        completedDate: yesterday,
      },
      { id: 'task_kpi_today', title: 'Today', projectId: SUMMARY_PROJECT, status: 'todo', priority: 'medium', dueDate: today },
      { id: 'task_kpi_late', title: 'Late', projectId: SUMMARY_PROJECT, status: 'in_progress', dueDate: yesterday },
      { id: 'task_kpi_other', title: 'Other', projectId: OTHER_PROJECT, status: 'todo', priority: 'low' },
    ] as (typeof schema.tasks.$inferInsert)[]);
    const date = today.toISOString().slice(0, 10);
    await db.insert(schema.timeEntries).values([
      { id: 'time_kpi_1', projectId: SUMMARY_PROJECT, userId: 'user_kpi', date, duration: '90', billable: true, status: 'draft' },
      { id: 'time_kpi_2', projectId: SUMMARY_PROJECT, userId: 'user_kpi', date, duration: '30.5', billable: false, status: 'draft' },
      { id: 'time_kpi_3', projectId: OTHER_PROJECT, userId: 'user_x', date, duration: '45', billable: true, status: 'draft' },
    ] as (typeof schema.timeEntries.$inferInsert)[]);
  });

  type Summary = {
    totalTasks: number;
    tasksDueToday: number;
    overdueTasks: number;
    hoursLoggedMinutes: number;
    throughputByDay: unknown[];
  };

  it('counts what the caller can see, for the workspace and for one project', async () => {
    const member = appAs('user_kpi');
    const mine = await member('/api/project-analytics/summary?period=7d');
    expect(mine.status).toBe(200);
    const { data } = (await mine.json()) as { data: Summary };
    expect(data.totalTasks).toBe(3);
    expect(data.tasksDueToday).toBe(1);
    expect(data.overdueTasks).toBe(1);
    expect(data.hoursLoggedMinutes).toBe(121);
    expect(data.throughputByDay).toHaveLength(7);

    const all = await appAs('user_kpi_admin', 'projects:scope:all')('/api/project-analytics/summary');
    expect(((await all.json()) as { data: Summary }).data.totalTasks).toBeGreaterThanOrEqual(4);

    const one = await member(`/api/project-analytics/projects/${SUMMARY_PROJECT}/summary?period=90d`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { data: Summary }).data.throughputByDay).toHaveLength(90);
    const narrowed = await member(`/api/project-analytics/summary?projectId=${SUMMARY_PROJECT}`);
    expect(((await narrowed.json()) as { data: Summary }).data.totalTasks).toBe(3);
  });

  it('refuses projects the caller is not in, and a bad period', async () => {
    const member = appAs('user_kpi');
    expect((await member(`/api/project-analytics/summary?projectId=${OTHER_PROJECT}`)).status).toBe(403);
    expect((await member(`/api/project-analytics/projects/${OTHER_PROJECT}/summary`)).status).toBe(403);
    expect((await member('/api/project-analytics/summary?period=1y')).status).toBe(400);
    // A member of no project sees an empty summary.
    const none = await appAs('user_kpi_nobody')('/api/project-analytics/summary');
    expect(((await none.json()) as { data: Summary }).data.throughputByDay).toEqual([]);
  });
});
