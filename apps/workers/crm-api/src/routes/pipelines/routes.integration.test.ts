/**
 * Every /api/pipelines, /api/pipeline-stages and
 * /api/pipeline-field-visibility route on pglite, refusals included
 * (permission, validation, not found, paging). The conformance suite runs
 * these against the Rust backend too.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { pipelinesRoutes } from './index';
import { pipelineStagesRoutes } from '../pipeline-stages';
import { pipelineFieldVisibilityRoutes } from '../pipeline-field-visibility';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute));
  await db.insert(schema.crmPipelines).values([
    { id: 'pl_sales', name: 'Sales', createdAt: at(1), updatedAt: at(1), settings: { showProbability: true } },
    { id: 'pl_renewals', name: 'Renewals', createdAt: at(2), updatedAt: at(2) },
    { id: 'pl_archived', name: 'Old', isArchived: true, createdAt: at(3), updatedAt: at(3) },
    { id: 'pl_gone', name: 'Gone', deletedAt: at(4), createdAt: at(4), updatedAt: at(4) },
  ]);
  await db.insert(schema.crmPipelineStages).values([
    { id: 'pls_a', name: 'Lead', position: 0, pipeline: 'pl_sales', createdAt: at(1), updatedAt: at(1) },
    { id: 'pls_b', name: 'Demo', position: 1, pipeline: 'pl_sales', createdAt: at(2), updatedAt: at(2) },
    { id: 'pls_won', name: 'Won', position: 2, isWon: true, pipeline: 'pl_sales', createdAt: at(3), updatedAt: at(3) },
    { id: 'pls_other', name: 'Other', position: 0, pipeline: 'pl_renewals', createdAt: at(4), updatedAt: at(4) },
  ]);
}, 60_000);

const ALL = ['pipelines:read', 'pipelines:create', 'pipelines:update', 'pipelines:delete', 'pipelines:manage'];

function pipelines(...keys: string[]) {
  return createTestApp('/api/pipelines', pipelinesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
function stages(...keys: string[]) {
  return createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
function visibility(...keys: string[]) {
  return createTestApp('/api/pipeline-field-visibility', pipelineFieldVisibilityRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/pipelines · every route', () => {
  it('lists with filters, search and a cursor', async () => {
    const app = pipelines();
    const first = await app.request('/api/pipelines?limit=1');
    expect(first.status).toBe(200);
    const page = (await first.json()) as { data: { id: string }[]; pagination: { cursor: string | null; totalCount: number } };
    expect(page.data.map((p) => p.id)).toEqual(['pl_sales']);
    expect(page.pagination.totalCount).toBe(2);
    const next = await app.request(`/api/pipelines?limit=1&cursor=${page.pagination.cursor}`);
    expect(((await next.json()) as { data: { id: string }[] }).data.map((p) => p.id)).toEqual(['pl_renewals']);
    expect((await app.request('/api/pipelines?archived=archived')).status).toBe(200);
    expect((await app.request('/api/pipelines?archived=all&search=Re')).status).toBe(200);
    expect((await app.request('/api/pipelines?cursor=pl_missing&search=Sa')).status).toBe(200);
    expect((await app.request('/api/pipelines?limit=0')).status).toBe(200);
  });

  it('reads one pipeline, and 404s a deleted or missing one', async () => {
    const app = pipelines();
    const res = await app.request('/api/pipelines/pl_sales');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe('Sales');
    expect((await app.request('/api/pipelines/pl_gone')).status).toBe(404);
    expect((await app.request('/api/pipelines/pl_missing')).status).toBe(404);
  });

  it('updates a pipeline and archives it', async () => {
    const app = pipelines();
    const res = await app.request('/api/pipelines/pl_renewals', json('PATCH', { name: 'Renewals 2', description: null, isArchived: false, settings: { a: 1 } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe('Renewals 2');
    expect((await app.request('/api/pipelines/pl_missing', json('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await app.request('/api/pipelines/pl_renewals', json('PATCH', { name: '' }))).status).toBe(400);
    expect((await app.request('/api/pipelines/pl_renewals', json('PATCH', { isArchived: 'yes', color: 5 }))).status).toBe(400);
  });

  it('refuses without the permission', async () => {
    const app = pipelines('pipelines:read');
    expect((await app.request('/api/pipelines', json('POST', { name: 'No' }))).status).toBe(403);
    expect((await app.request('/api/pipelines/pl_sales', json('PATCH', { name: 'No' }))).status).toBe(403);
    expect((await app.request('/api/pipelines/pl_sales', { method: 'DELETE' })).status).toBe(403);
    expect((await pipelines('pipelines:create').request('/api/pipelines')).status).toBe(403);
  });

  it('creates with nullable fields and deletes, stages included', async () => {
    const app = pipelines();
    const created = await app.request('/api/pipelines', json('POST', { name: 'Temp', description: null, icon: 'Star', template: 't1', isDefault: true }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const stage = await stages().request('/api/pipeline-stages', json('POST', { name: 'Only', pipeline: data.id }));
    expect(stage.status).toBe(201);
    expect((await app.request(`/api/pipelines/${data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/pipelines/${data.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app.request('/api/pipelines', json('POST', { description: 'no name' }))).status).toBe(400);
  });
});

describe('/api/pipeline-stages · every route', () => {
  it('lists a pipeline with paging', async () => {
    const app = stages();
    const res = await app.request('/api/pipeline-stages?pipeline=pl_sales&limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[]; pagination: { hasMore: boolean } };
    expect(body.data.map((s) => s.id)).toEqual(['pls_a', 'pls_b']);
    expect(body.pagination.hasMore).toBe(true);
    expect((await app.request('/api/pipeline-stages')).status).toBe(200);
  });

  it('reads, updates and 404s a stage', async () => {
    const app = stages();
    expect((await app.request('/api/pipeline-stages/pls_b')).status).toBe(200);
    expect((await app.request('/api/pipeline-stages/pls_missing')).status).toBe(404);
    const res = await app.request('/api/pipeline-stages/pls_b', json('PATCH', { name: 'Demo call', probability: 40, color: null }));
    expect(res.status).toBe(200);
    expect((await app.request('/api/pipeline-stages/pls_missing', json('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await app.request('/api/pipeline-stages/pls_b', json('PATCH', { probability: 101 }))).status).toBe(400);
    expect((await app.request('/api/pipeline-stages/pls_b', json('PATCH', { position: -1, isWon: 'no' }))).status).toBe(400);
  });

  it('reorders a pipeline and refuses an empty list', async () => {
    const app = stages();
    const res = await app.request('/api/pipeline-stages/reorder', json('POST', { pipeline: 'pl_sales', ids: ['pls_b', 'pls_a', 'pls_won'] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { pipeline: 'pl_sales', ids: ['pls_b', 'pls_a', 'pls_won'] } });
    expect((await app.request('/api/pipeline-stages/reorder', json('POST', { ids: [] }))).status).toBe(400);
    expect((await app.request('/api/pipeline-stages/reorder', json('POST', { ids: ['pls_other'] }))).status).toBe(200);
    expect((await stages('pipelines:update').request('/api/pipeline-stages/reorder', json('POST', { ids: ['x'] }))).status).toBe(403);
  });

  it('creates won and lost stages at the end, and refuses deleting a stage with deals', async () => {
    const app = stages();
    const lost = await app.request('/api/pipeline-stages', json('POST', { name: 'Lost', isLost: true, pipeline: 'pl_sales', probability: null }));
    expect(lost.status).toBe(201);
    await db.insert(schema.crmOpportunities).values({
      id: 'opp_in_stage',
      name: 'Deal',
      customerId: 'cmp_x',
      stageId: 'pls_a',
      ownerId: 'user_test_default',
    });
    const refused = await app.request('/api/pipeline-stages/pls_a', { method: 'DELETE' });
    expect(refused.status).toBe(400);
    expect((await app.request('/api/pipeline-stages/pls_other', { method: 'DELETE' })).status).toBe(204);
    expect((await app.request('/api/pipeline-stages/pls_other', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('/api/pipeline-field-visibility · every route', () => {
  it('reads empty visibility, writes it and keeps the other settings', async () => {
    const app = visibility();
    const empty = await app.request('/api/pipeline-field-visibility/pl_sales/field-visibility');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ data: {} });
    const written = await app.request(
      '/api/pipeline-field-visibility/pl_sales/field-visibility',
      json('PATCH', { grid: ['name', 'amount'] }),
    );
    expect(written.status).toBe(200);
    const merged = await app.request(
      '/api/pipeline-field-visibility/pl_sales/field-visibility',
      json('PATCH', { kanban: ['amount'] }),
    );
    expect(await merged.json()).toEqual({ data: { grid: ['name', 'amount'], kanban: ['amount'] } });
    expect((await app.request('/api/pipeline-field-visibility/pl_sales/field-visibility')).status).toBe(200);
  });

  it('refuses a bad body, a missing pipeline and a missing permission', async () => {
    const app = visibility();
    expect(
      (await app.request('/api/pipeline-field-visibility/pl_sales/field-visibility', json('PATCH', { grid: [''] }))).status,
    ).toBe(400);
    expect(
      (await app.request('/api/pipeline-field-visibility/pl_sales/field-visibility', json('PATCH', { grid: 'name' }))).status,
    ).toBe(400);
    expect((await app.request('/api/pipeline-field-visibility/pl_missing/field-visibility')).status).toBe(404);
    expect(
      (await app.request('/api/pipeline-field-visibility/pl_missing/field-visibility', json('PATCH', { grid: [] }))).status,
    ).toBe(404);
    expect(
      (await visibility('pipelines:read').request('/api/pipeline-field-visibility/pl_sales/field-visibility', json('PATCH', {}))).status,
    ).toBe(403);
    expect((await visibility('pipelines:update').request('/api/pipeline-field-visibility/pl_sales/field-visibility')).status).toBe(403);
  });
});
