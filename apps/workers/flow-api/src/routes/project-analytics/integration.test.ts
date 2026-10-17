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

describe('POST /reports/:id/charts-data', () => {
  beforeEach(() => {
    analyticsMock.queryAnalytics.mockReset();
    analyticsMock.queryAnalytics.mockResolvedValue([{ label: '2026-10-01', value: 3 }]);
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
    expect(await res.json()).toEqual({ data: { c1: [{ label: '2026-10-01', value: 3 }] } });
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
