/**
 * /api/crm-analytics against pglite: reports and their charts (create,
 * read, update, duplicate, layouts, delete), chart data without an
 * analytics store, the `app = 'crm'` boundary and the refusals. Runs
 * against the Rust backend in conformance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { crmAnalyticsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
  await db.insert(schema.analyticsReports).values([
    { id: 'rpt_crm', app: 'crm', title: 'Pipeline', description: 'Deals', createdById: 'user_test_default', chartCount: 2, createdAt: at(1), updatedAt: at(5) },
    { id: 'rpt_old', app: 'crm', title: 'Old', chartCount: 0, createdAt: at(2), updatedAt: at(6) },
    { id: 'rpt_flow', app: 'projects', title: 'Flow report', chartCount: 0, createdAt: at(3), updatedAt: at(7) },
    { id: 'rpt_gone', app: 'crm', title: 'Gone', chartCount: 0, deletedAt: at(4), createdAt: at(4), updatedAt: at(8) },
  ]);
  await db.insert(schema.analyticsCharts).values([
    { id: 'cht_a', app: 'crm', reportId: 'rpt_crm', title: 'Leads', chartType: 'line', entity: 'leads', metric: 'count', layout: { x: 0, y: 0, w: 6, h: 4 }, sortIndex: 0, createdAt: at(1), updatedAt: at(1) },
    { id: 'cht_b', app: 'crm', reportId: 'rpt_crm', title: 'Deals', chartType: 'bar', entity: 'opportunities', metric: 'amount', limit: 5, compareWith: 'previous_period', layout: { x: 6, y: 0, w: 6, h: 3, minW: 2 }, sortIndex: 1, createdAt: at(2), updatedAt: at(2) },
    { id: 'cht_gone', app: 'crm', reportId: 'rpt_crm', title: 'Gone', chartType: 'bar', entity: 'leads', metric: 'count', layout: { x: 0, y: 4, w: 6, h: 4 }, sortIndex: 2, deletedAt: at(3), createdAt: at(3), updatedAt: at(3) },
  ]);
}, 60_000);

function app(...keys: string[]) {
  return createTestApp('/api/crm-analytics', crmAnalyticsRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ['contacts:read'])), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/crm-analytics · pglite integration', () => {
  it('lists and reads CRM reports only', async () => {
    const list = await app().request('/api/crm-analytics');
    expect(((await list.json()) as { data: { id: string }[] }).data.map((r) => r.id)).toEqual(['rpt_old', 'rpt_crm']);
    expect((await app().request('/api/crm-analytics/rpt_crm')).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_flow')).status).toBe(404);
    expect((await app().request('/api/crm-analytics/rpt_gone')).status).toBe(404);
    const charts = await app().request('/api/crm-analytics/rpt_crm/charts');
    expect(((await charts.json()) as { data: { id: string }[] }).data.map((c) => c.id)).toEqual(['cht_a', 'cht_b']);
    expect(await (await app().request('/api/crm-analytics/rpt_missing/charts')).json()).toEqual({ data: [] });
  });

  it('creates, updates and refuses bad reports', async () => {
    const created = await app().request('/api/crm-analytics', json('POST', { title: 'Sales' }));
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await app().request(`/api/crm-analytics/${id}`)).status).toBe(200);
    expect((await app().request('/api/crm-analytics', json('POST', { title: 'Described', description: 'Text', extra: 1 }))).status).toBe(201);
    expect((await app().request('/api/crm-analytics', json('POST', { title: '' }))).status).toBe(400);
    expect((await app().request('/api/crm-analytics', json('POST', { description: 5 }))).status).toBe(400);
    expect((await app().request('/api/crm-analytics/rpt_old', json('PATCH', { title: 'Older' }))).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_old', json('PATCH', { description: 'Now described' }))).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_old', json('PATCH', {}))).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_flow', json('PATCH', { title: 'x' }))).status).toBe(404);
    expect((await app().request('/api/crm-analytics/rpt_old', json('PATCH', { title: '' }))).status).toBe(400);
  });

  it('adds, edits, lays out and duplicates charts', async () => {
    const created = await app().request('/api/crm-analytics/rpt_crm/charts', json('POST', {
      title: 'Won', chartType: 'area', entity: 'opportunities', metric: 'amount', limit: 10, layout: { x: 0, y: 4, w: 12, h: 4, extra: 1 },
    }));
    expect(created.status).toBe(201);
    const chartId = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await app().request('/api/crm-analytics/rpt_crm/charts', json('POST', {
      title: 'Defaults', description: 'All defaults', chartType: 'line', entity: 'leads', metric: 'count',
      color: '#000', smoothCurve: false, fillArea: false, showDataLabels: true, showLegend: false, timeRange: 'last_7_days',
      groupBy: 'week', aggregation: 'count', sortOrder: 'desc', compareWith: 'previous_year',
    }))).status).toBe(201);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts', json('POST', { title: 'x', chartType: '', entity: 'leads' }))).status).toBe(400);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts', json('POST', { title: 'x', chartType: 'line', entity: 'e', metric: 'm', color: null, layout: { x: 'a' } }))).status).toBe(400);
    expect((await app().request(`/api/crm-analytics/rpt_crm/charts/${chartId}`, json('PUT', { title: 'Won deals', layout: { x: 1, y: 2, w: 3, h: 4 }, limit: 3 }))).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts/cht_a', json('PUT', {}))).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts/cht_missing', json('PUT', { title: 'x' }))).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts/cht_a', json('PUT', { smoothCurve: 'yes' }))).status).toBe(400);
    const layouts = await app().request('/api/crm-analytics/rpt_crm/charts/layouts', json('PATCH', {
      layouts: [{ chartId: 'cht_a', layout: { x: 0, y: 8, w: 6, h: 4, minH: 2 } }, { chartId: 'cht_missing', layout: { x: 0, y: 0, w: 1, h: 1 } }],
    }));
    expect(await layouts.json()).toEqual({ data: { updated: 2 } });
    expect((await app().request('/api/crm-analytics/rpt_crm/charts/layouts', json('PATCH', { layouts: [{ chartId: 'cht_a' }] }))).status).toBe(400);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts/cht_b/duplicate', { method: 'POST' })).status).toBe(201);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts/cht_gone/duplicate', { method: 'POST' })).status).toBe(404);
    expect((await app().request('/api/crm-analytics/rpt_old/charts/cht_a/duplicate', { method: 'POST' })).status).toBe(404);
    const charts = await app().request('/api/crm-analytics/rpt_crm/charts');
    expect(((await charts.json()) as { data: unknown[] }).data).toHaveLength(5);
    expect((await app().request('/api/crm-analytics/rpt_crm')).status).toBe(200);
  });

  it('duplicates a report with its charts', async () => {
    const copy = await app().request('/api/crm-analytics/rpt_crm/duplicate', { method: 'POST' });
    expect(copy.status).toBe(201);
    const id = ((await copy.json()) as { data: { id: string } }).data.id;
    const charts = await app().request(`/api/crm-analytics/${id}/charts`);
    expect(((await charts.json()) as { data: unknown[] }).data).toHaveLength(5);
    expect((await app().request('/api/crm-analytics/rpt_old/duplicate', { method: 'POST' })).status).toBe(201);
    expect((await app().request('/api/crm-analytics/rpt_flow/duplicate', { method: 'POST' })).status).toBe(404);
  });

  it('deletes charts and reports', async () => {
    expect((await app().request('/api/crm-analytics/rpt_crm/charts/cht_b', { method: 'DELETE' })).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts/cht_missing', { method: 'DELETE' })).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_crm', { method: 'DELETE' })).status).toBe(200);
    expect((await app().request('/api/crm-analytics/rpt_crm', { method: 'DELETE' })).status).toBe(404);
    expect((await app().request('/api/crm-analytics/rpt_crm/charts')).status).toBe(200);
  });

  it('answers chart data as empty series without an analytics store', async () => {
    const res = await app().request('/api/crm-analytics/chart-data', json('POST', {
      charts: [
        { chartId: 'cht_a', entity: 'leads', metric: 'count', timeRange: 'last_30_days', groupBy: 'day', aggregation: 'count' },
        { chartId: 'cht_b', entity: 'opportunities', metric: 'amount', timeRange: 'last_7_days', groupBy: 'week', aggregation: 'sum' },
      ],
    }));
    expect(await res.json()).toEqual({ data: { cht_a: [], cht_b: [] } });
    expect(await (await app().request('/api/crm-analytics/chart-data', json('POST', {}))).json()).toEqual({ data: {} });
    expect((await app().request('/api/crm-analytics/chart-data', { method: 'POST', body: 'not json' })).status).toBe(200);
    expect((await app().request('/api/crm-analytics/chart-data', json('POST', { charts: 'all' }))).status).toBe(500);
  });

  it('refuses without contacts:read', async () => {
    expect((await app('companies:read').request('/api/crm-analytics')).status).toBe(403);
    expect((await app('companies:read').request('/api/crm-analytics', json('POST', { title: 'x' }))).status).toBe(403);
    expect((await app('companies:read').request('/api/crm-analytics/chart-data', json('POST', {}))).status).toBe(403);
  });
});
