/**
 * Every /api/helpdesk-analytics route on pglite, refusals included: reports
 * (list, read, create, update, delete with their charts, duplicate), charts
 * (list per report, create with its defaults and position, read, update,
 * layouts, delete with the report's chart count) and chart data.
 *
 * Chart data comes from Cloudflare's R2 SQL API, which `queryAnalytics` only
 * calls with R2_SQL_API_TOKEN, CF_ACCOUNT_ID and R2_ANALYTICS_BUCKET set.
 * The test env has none of them, so both data routes answer empty series
 * here; a real query is not reached.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { helpdeskAnalyticsRoutes } from './index';

const BASE = '/api/helpdesk-analytics';
const USER = 'user_test_default';
const { helpdeskAnalyticsCharts: charts, helpdeskAnalyticsReports: reports } = schema;

let db: Database;

const at = (second: number) => new Date(Date.UTC(2026, 4, 1, 6, 0, second));

function app(...keys: string[]) {
  return createTestApp(BASE, helpdeskAnalyticsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
}

const READ = () => app('settings:read');
const CREATE = () => app('settings:create', 'settings:read');
const UPDATE = () => app('settings:update', 'settings:read');
const DELETE = () => app('settings:delete', 'settings:read');

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function reportOf(id: string) {
  const [row] = await db.select().from(reports).where(eq(reports.id, id));
  return row;
}

async function chartOf(id: string) {
  const [row] = await db.select().from(charts).where(eq(charts.id, id));
  return row;
}

const chartSeed = (id: string, reportId: string, sortIndex: number, n: number, overrides: Partial<typeof charts.$inferInsert> = {}) => ({
  id,
  reportId,
  title: `Chart ${id}`,
  chartType: 'area-chart',
  entity: 'tickets',
  metric: 'count',
  layout: { x: 0, y: sortIndex * 4, w: 6, h: 4 },
  sortIndex,
  createdAt: at(n),
  updatedAt: at(n),
  ...overrides,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(reports).values([
    { id: 'rpt_a', title: 'Tickets overview', description: 'Weekly', createdById: 'user_x', chartCount: 2, createdAt: at(1), updatedAt: at(1) },
    { id: 'rpt_b', title: 'Empty', chartCount: 0, createdAt: at(2), updatedAt: at(3) },
    { id: 'rpt_zero', title: 'Miscounted', chartCount: 0, createdAt: at(4), updatedAt: at(4) },
    { id: 'rpt_gone', title: 'Gone', chartCount: 0, deletedAt: at(5), createdAt: at(5), updatedAt: at(5) },
  ]);
  await db.insert(charts).values([
    chartSeed('cht_a1', 'rpt_a', 1, 6, { color: '#ff0000', limit: 10, compareWith: 'previous_period', description: 'Second' }),
    chartSeed('cht_a0', 'rpt_a', 0, 7, { chartType: 'bar-stacked', groupBy: 'week' }),
    chartSeed('cht_a_gone', 'rpt_a', 2, 8, { deletedAt: at(9) }),
    chartSeed('cht_z', 'rpt_zero', 0, 10),
  ]);
}, 60_000);

describe('reports', () => {
  it('list needs settings:read and answers the live reports, last updated first', async () => {
    expect((await app('settings:create').request(BASE)).status).toBe(403);
    const res = await READ().request(BASE);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((r) => r.id)).toEqual(['rpt_zero', 'rpt_b', 'rpt_a']);
  });

  it('reads one report, and not a deleted or unknown one', async () => {
    expect((await app('settings:create').request(`${BASE}/reports/rpt_a`)).status).toBe(403);
    const res = await READ().request(`${BASE}/reports/rpt_a`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: 'rpt_a',
        createdAt: at(1).toISOString(),
        updatedAt: at(1).toISOString(),
        deletedAt: null,
        title: 'Tickets overview',
        description: 'Weekly',
        createdById: 'user_x',
        chartCount: 2,
      },
    });
    for (const id of ['rpt_gone', 'rpt_missing']) {
      const missing = await READ().request(`${BASE}/reports/${id}`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Report with ID '${id}' not found` } });
    }
  });

  it('create needs settings:create and a title of 1 to 255 characters', async () => {
    expect((await UPDATE().request(BASE, send('POST', { title: 'X' }))).status).toBe(403);
    for (const body of [{}, { title: '' }, { title: 'x'.repeat(256) }, { title: 'X', description: 5 }]) {
      expect((await CREATE().request(BASE, send('POST', body))).status).toBe(400);
    }
  });

  it('creates a report owned by the caller', async () => {
    const res = await CREATE().request(BASE, send('POST', { title: 'New report' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(Object.keys(data)).toEqual(['id']);
    expect(await reportOf(data.id)).toMatchObject({ title: 'New report', description: null, chartCount: 0, createdById: USER, deletedAt: null });

    const described = await CREATE().request(BASE, send('POST', { title: 'Described', description: 'With words' }));
    const created = (await described.json()) as { data: { id: string } };
    expect(await reportOf(created.data.id)).toMatchObject({ description: 'With words' });
  });

  it('update needs settings:update, a live report and a valid body', async () => {
    expect((await CREATE().request(`${BASE}/rpt_b`, send('PATCH', { title: 'X' }))).status).toBe(403);
    for (const id of ['rpt_gone', 'rpt_missing']) {
      const res = await UPDATE().request(`${BASE}/${id}`, send('PATCH', { title: 'X' }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Report with ID '${id}' not found` } });
    }
    for (const body of [{ title: '' }, { title: 'x'.repeat(256) }, { description: false }]) {
      expect((await UPDATE().request(`${BASE}/rpt_b`, send('PATCH', body))).status).toBe(400);
    }
  });

  it('updates only the fields sent', async () => {
    const res = await UPDATE().request(`${BASE}/rpt_b`, send('PATCH', { description: 'Now described' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'rpt_b' } });
    expect(await reportOf('rpt_b')).toMatchObject({ title: 'Empty', description: 'Now described' });

    await UPDATE().request(`${BASE}/rpt_b`, send('PATCH', { title: 'Renamed' }));
    expect(await reportOf('rpt_b')).toMatchObject({ title: 'Renamed', description: 'Now described' });

    const empty = await UPDATE().request(`${BASE}/rpt_b`, send('PATCH', {}));
    expect(empty.status).toBe(200);
    expect(await reportOf('rpt_b')).toMatchObject({ title: 'Renamed', description: 'Now described' });
  });
});

describe('charts', () => {
  it('lists a report’s live charts by position (settings:read)', async () => {
    expect((await app('settings:create').request(`${BASE}/reports/rpt_a/charts`)).status).toBe(403);
    const res = await READ().request(`${BASE}/reports/rpt_a/charts`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((c) => c.id)).toEqual(['cht_a0', 'cht_a1']);
    expect(await (await READ().request(`${BASE}/reports/rpt_missing/charts`)).json()).toEqual({ data: [] });
  });

  it('reads one chart, and not a deleted or unknown one', async () => {
    expect((await app('settings:create').request(`${BASE}/charts/cht_a1`)).status).toBe(403);
    const res = await READ().request(`${BASE}/charts/cht_a1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: 'cht_a1',
        createdAt: at(6).toISOString(),
        updatedAt: at(6).toISOString(),
        deletedAt: null,
        reportId: 'rpt_a',
        title: 'Chart cht_a1',
        description: 'Second',
        chartType: 'area-chart',
        entity: 'tickets',
        metric: 'count',
        color: '#ff0000',
        smoothCurve: true,
        fillArea: true,
        showDataLabels: false,
        showLegend: true,
        timeRange: 'last_30_days',
        groupBy: 'day',
        aggregation: 'sum',
        sortOrder: 'asc',
        limit: 10,
        compareWith: 'previous_period',
        layout: { x: 0, y: 4, w: 6, h: 4 },
        sortIndex: 1,
      },
    });
    for (const id of ['cht_a_gone', 'cht_missing']) {
      const missing = await READ().request(`${BASE}/charts/${id}`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Chart with ID '${id}' not found` } });
    }
  });

  it('create needs settings:create and a valid body', async () => {
    const base = { reportId: 'rpt_a', title: 'T', chartType: 'area-chart', entity: 'tickets', metric: 'count' };
    expect((await UPDATE().request(`${BASE}/charts`, send('POST', base))).status).toBe(403);
    for (const body of [
      { ...base, reportId: '' },
      { ...base, title: '' },
      { ...base, title: 'x'.repeat(256) },
      { ...base, chartType: '' },
      { ...base, metric: undefined },
      { ...base, smoothCurve: 'yes' },
      { ...base, limit: '10' },
      { ...base, layout: { x: 0, y: 0, w: 6 } },
    ]) {
      expect((await CREATE().request(`${BASE}/charts`, send('POST', body))).status).toBe(400);
    }
  });

  it('adds a chart after the last live one, with the defaults, and counts it on the report', async () => {
    const res = await CREATE().request(
      `${BASE}/charts`,
      send('POST', { reportId: 'rpt_a', title: 'Volume', chartType: 'bar-multiple', entity: 'tickets', metric: 'count' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(Object.keys(data)).toEqual(['id']);
    expect(await chartOf(data.id)).toMatchObject({
      reportId: 'rpt_a',
      title: 'Volume',
      description: null,
      color: '#3b82f6',
      smoothCurve: true,
      fillArea: true,
      showDataLabels: false,
      showLegend: true,
      timeRange: 'last_30_days',
      groupBy: 'day',
      aggregation: 'sum',
      sortOrder: 'asc',
      limit: null,
      compareWith: null,
      // The deleted chart at index 2 doesn't count: max live index is 1.
      sortIndex: 2,
      layout: { x: 0, y: 8, w: 6, h: 4 },
    });
    expect((await reportOf('rpt_a'))?.chartCount).toBe(3);
  });

  it('adds the first chart of a report with every option set', async () => {
    const res = await CREATE().request(
      `${BASE}/charts`,
      send('POST', {
        reportId: 'rpt_b',
        title: 'Resolution',
        description: 'Avg resolution time',
        chartType: 'pie-donut',
        entity: 'conversations',
        metric: 'avg_resolution_time',
        color: '#00aa00',
        smoothCurve: false,
        fillArea: false,
        showDataLabels: true,
        showLegend: false,
        timeRange: 'last_7_days',
        groupBy: 'week',
        aggregation: 'average',
        sortOrder: 'desc',
        limit: 5,
        compareWith: 'previous_year',
        layout: { x: 6, y: 0, w: 3, h: 2, minW: 2, minH: 1 },
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(await chartOf(data.id)).toMatchObject({
      reportId: 'rpt_b',
      description: 'Avg resolution time',
      color: '#00aa00',
      smoothCurve: false,
      fillArea: false,
      showDataLabels: true,
      showLegend: false,
      timeRange: 'last_7_days',
      groupBy: 'week',
      aggregation: 'average',
      sortOrder: 'desc',
      limit: 5,
      compareWith: 'previous_year',
      sortIndex: 0,
      layout: { x: 6, y: 0, w: 3, h: 2, minW: 2, minH: 1 },
    });
    expect((await reportOf('rpt_b'))?.chartCount).toBe(1);
  });

  it('fails for a report that does not exist', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await CREATE().request(
      `${BASE}/charts`,
      send('POST', { reportId: 'rpt_missing', title: 'T', chartType: 'area-chart', entity: 'tickets', metric: 'count' }),
    );
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create chart' } });
  });

  it('update needs settings:update and a valid body', async () => {
    expect((await CREATE().request(`${BASE}/charts/cht_a0`, send('PUT', { title: 'X' }))).status).toBe(403);
    for (const body of [{ title: '' }, { showLegend: 'no' }, { layout: { x: 1 } }, { limit: 'all' }]) {
      expect((await UPDATE().request(`${BASE}/charts/cht_a0`, send('PUT', body))).status).toBe(400);
    }
  });

  it('updates only the fields sent; the report cannot be changed', async () => {
    const res = await UPDATE().request(
      `${BASE}/charts/cht_a0`,
      send('PUT', { title: 'Weekly volume', reportId: 'rpt_b', limit: 3, layout: { x: 1, y: 2, w: 3, h: 4 } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'cht_a0' } });
    expect(await chartOf('cht_a0')).toMatchObject({
      title: 'Weekly volume',
      reportId: 'rpt_a',
      limit: 3,
      layout: { x: 1, y: 2, w: 3, h: 4 },
      chartType: 'bar-stacked',
      groupBy: 'week',
      color: '#3b82f6',
    });
  });

  it('answers 200 for a chart that does not exist or was deleted, changing nothing', async () => {
    for (const id of ['cht_missing', 'cht_a_gone']) {
      const res = await UPDATE().request(`${BASE}/charts/${id}`, send('PUT', { title: 'Ghost' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { id } });
    }
    expect((await chartOf('cht_a_gone'))?.title).toBe('Chart cht_a_gone');
  });

  it('layouts need settings:update and move only the report’s own charts', async () => {
    expect((await CREATE().request(`${BASE}/reports/rpt_a/layouts`, send('PATCH', { layouts: [] }))).status).toBe(403);
    const res = await UPDATE().request(
      `${BASE}/reports/rpt_a/layouts`,
      send('PATCH', {
        layouts: [
          { chartId: 'cht_a1', layout: { x: 6, y: 0, w: 6, h: 3 } },
          { chartId: 'cht_z', layout: { x: 9, y: 9, w: 1, h: 1 } },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { updated: 2 } });
    expect((await chartOf('cht_a1'))?.layout).toEqual({ x: 6, y: 0, w: 6, h: 3 });
    expect((await chartOf('cht_z'))?.layout).toEqual({ x: 0, y: 0, w: 6, h: 4 });
  });

  it('layouts: a body that is not JSON updates nothing, a body without layouts fails', async () => {
    const notJson = await UPDATE().request(`${BASE}/reports/rpt_a/layouts`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(notJson.status).toBe(200);
    expect(await notJson.json()).toEqual({ data: { updated: 0 } });

    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noLayouts = await UPDATE().request(`${BASE}/reports/rpt_a/layouts`, send('PATCH', {}));
    quiet.mockRestore();
    expect(noLayouts.status).toBe(500);
    expect(await noLayouts.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update chart layouts' } });
  });
});

describe('duplicating a report', () => {
  it('needs settings:create and a live report', async () => {
    expect((await UPDATE().request(`${BASE}/reports/rpt_a/duplicate`, send('POST'))).status).toBe(403);
    for (const id of ['rpt_gone', 'rpt_missing']) {
      const res = await CREATE().request(`${BASE}/reports/${id}/duplicate`, send('POST'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Report with ID '${id}' not found` } });
    }
  });

  it('copies the report and its live charts, owned by the caller', async () => {
    const res = await CREATE().request(`${BASE}/reports/rpt_a/duplicate`, send('POST'));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(data.id).not.toBe('rpt_a');
    expect(await reportOf(data.id)).toMatchObject({ title: 'Tickets overview (Copy)', description: 'Weekly', createdById: USER, chartCount: 3 });

    const copies = await READ().request(`${BASE}/reports/${data.id}/charts`);
    const { data: copied } = (await copies.json()) as { data: Array<Record<string, unknown>> };
    expect(copied.map((c) => [c.title, c.sortIndex])).toEqual([
      ['Weekly volume', 0],
      ['Chart cht_a1', 1],
      ['Volume', 2],
    ]);
    expect(copied[1]).toMatchObject({ color: '#ff0000', limit: 10, compareWith: 'previous_period', layout: { x: 6, y: 0, w: 6, h: 3 } });
  });

  it('copies a report without charts as an empty one', async () => {
    const created = await CREATE().request(BASE, send('POST', { title: 'Lonely' }));
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await CREATE().request(`${BASE}/reports/${data.id}/duplicate`, send('POST'));
    expect(res.status).toBe(201);
    const copy = (await res.json()) as { data: { id: string } };
    expect(await reportOf(copy.data.id)).toMatchObject({ title: 'Lonely (Copy)', description: null, chartCount: 0 });
  });
});

describe('deleting', () => {
  it('a chart needs settings:delete and a live chart', async () => {
    expect((await UPDATE().request(`${BASE}/charts/cht_a1`, send('DELETE'))).status).toBe(403);
    for (const id of ['cht_a_gone', 'cht_missing']) {
      const res = await DELETE().request(`${BASE}/charts/${id}`, send('DELETE'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Chart with ID '${id}' not found` } });
    }
  });

  it('deletes a chart and uncounts it, never below zero', async () => {
    const res = await DELETE().request(`${BASE}/charts/cht_a1`, send('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'cht_a1' } });
    expect((await chartOf('cht_a1'))?.deletedAt).toBeInstanceOf(Date);
    expect((await reportOf('rpt_a'))?.chartCount).toBe(2);

    const zero = await DELETE().request(`${BASE}/charts/cht_z`, send('DELETE'));
    expect(zero.status).toBe(200);
    expect((await reportOf('rpt_zero'))?.chartCount).toBe(0);
  });

  it('a report needs settings:delete and a live report', async () => {
    expect((await UPDATE().request(`${BASE}/rpt_a`, send('DELETE'))).status).toBe(403);
    for (const id of ['rpt_gone', 'rpt_missing']) {
      const res = await DELETE().request(`${BASE}/${id}`, send('DELETE'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Report with ID '${id}' not found` } });
    }
  });

  it('deletes a report and every one of its charts', async () => {
    const res = await DELETE().request(`${BASE}/rpt_a`, send('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'rpt_a' } });
    expect((await reportOf('rpt_a'))?.deletedAt).toBeInstanceOf(Date);
    const left = await db.select().from(charts).where(eq(charts.reportId, 'rpt_a'));
    expect(left.every((c) => c.deletedAt instanceof Date)).toBe(true);
    // Charts deleted earlier are stamped again.
    expect((await chartOf('cht_a_gone'))?.deletedAt?.toISOString()).not.toBe(at(9).toISOString());
    expect((await READ().request(`${BASE}/reports/rpt_a`)).status).toBe(404);
  });
});

describe('chart data', () => {
  const query = { entity: 'tickets', metric: 'count', timeRange: 'last_30_days', groupBy: 'day', aggregation: 'sum' };

  it('needs settings:read and a complete query', async () => {
    expect((await app('settings:create').request(`${BASE}/charts/data`, send('POST', query))).status).toBe(403);
    for (const body of [
      { ...query, entity: '' },
      { ...query, metric: undefined },
      { ...query, timeRange: '' },
      { ...query, groupBy: undefined },
      { ...query, aggregation: '' },
      { ...query, limit: 'ten' },
      { ...query, sortOrder: 1 },
    ]) {
      expect((await READ().request(`${BASE}/charts/data`, send('POST', body))).status).toBe(400);
    }
  });

  it('answers an empty series without the R2 SQL bindings', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const body of [query, { ...query, entity: 'unknown_entity', sortOrder: 'desc', limit: 5 }]) {
      const res = await READ().request(`${BASE}/charts/data`, send('POST', body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [] });
    }
    quiet.mockRestore();
  });

  it('batch needs settings:read and answers each chart’s series by id', async () => {
    expect((await app('settings:create').request(`${BASE}/charts/batch-data`, send('POST', { charts: [] }))).status).toBe(403);
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await READ().request(
      `${BASE}/charts/batch-data`,
      send('POST', { charts: [{ chartId: 'cht_1', ...query }, { chartId: 'cht_2', ...query, metric: 'avg_response_time' }] }),
    );
    quiet.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { cht_1: [], cht_2: [] } });

    const none = await READ().request(`${BASE}/charts/batch-data`, send('POST', { charts: [] }));
    expect(await none.json()).toEqual({ data: {} });
  });

  it('batch: a body that is not JSON is no charts, a body without charts fails', async () => {
    const notJson = await READ().request(`${BASE}/charts/batch-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'nope',
    });
    expect(notJson.status).toBe(200);
    expect(await notJson.json()).toEqual({ data: {} });

    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noCharts = await READ().request(`${BASE}/charts/batch-data`, send('POST', {}));
    quiet.mockRestore();
    expect(noCharts.status).toBe(500);
    expect(await noCharts.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch batch chart data' } });
  });
});
