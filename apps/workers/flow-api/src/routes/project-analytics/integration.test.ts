/**
 * DB-backed integration tests for /api/project-analytics report/chart routes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { projectAnalyticsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedReport(): Promise<string> {
  const id = generateId('rpt');
  const now = new Date();
  await db.insert(schema.analyticsReports).values({
    id,
    app: 'projects',
    title: 'Seeded report',
    description: '',
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
