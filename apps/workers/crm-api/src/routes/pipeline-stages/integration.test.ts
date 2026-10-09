/**
 * DB-backed integration tests for /api/pipeline-stages.
 *
 * Pipeline stages use the `pipelines:*` permission set (same gate as
 * the parent pipeline) so the harness needs `pipelines:create` /
 * `pipelines:read` etc., not `pipeline-stages:*`.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { pipelineStagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/pipeline-stages · pglite integration', () => {
  it('POST / writes a stage and publishes pipeline_stage.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:create'), tenantDb: db },
    });

    const res = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Prospect', position: 0, color: '#abc' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^pls_/);

    const [row] = await db
      .select()
      .from(schema.crmPipelineStages)
      .where(eq(schema.crmPipelineStages.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Prospect');
    expect(row?.position).toBe(0);

    expect(mockedPublish).toHaveBeenCalled();
    const call = mockedPublish.mock.calls[0]![0] as {
      entityType: string;
      action: string;
    };
    expect(call.action).toBe('created');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:create'), tenantDb: db },
    });
    const res = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', position: 0 }),
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Position default (TASK-921, "Stage adden werkt niet"): a stage created
  // without a position must land after the last open stage, before any
  // isWon/isLost stage, not always at 0.
  // ---------------------------------------------------------------------------

  it('POST / without a position appends after the last open stage, before won/lost stages', async () => {
    const pipeline = generateId('pl');
    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:create'), tenantDb: db },
    });

    const open1 = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Open 1', position: 0, pipeline }),
    });
    expect(open1.status).toBe(201);

    const open2 = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Open 2', position: 1, pipeline }),
    });
    expect(open2.status).toBe(201);

    const won = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Won', position: 2, pipeline, isWon: true }),
    });
    expect(won.status).toBe(201);

    // No `position` — must land at 2 (after the two open stages), not 0.
    const res = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New open stage', pipeline }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.crmPipelineStages)
      .where(eq(schema.crmPipelineStages.id, body.data.id))
      .limit(1);
    expect(row?.position).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // TASK-946: a stage added without a position must sit BEFORE Won/Lost, and
  // Won/Lost must move right instead of tying with it.
  // ---------------------------------------------------------------------------

  async function seedStage(pipeline: string, name: string, position: number, flags: { isWon?: boolean; isLost?: boolean } = {}) {
    const now = new Date();
    await db.insert(schema.crmPipelineStages).values({
      id: generateId('pls'),
      name,
      position,
      pipeline,
      isWon: flags.isWon ?? false,
      isLost: flags.isLost ?? false,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function listStageNames(request: (path: string, init?: RequestInit) => Response | Promise<Response>, pipeline: string) {
    const res = await request(`/api/pipeline-stages?pipeline=${pipeline}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string; position: number }> };
    return body.data.map((s) => `${s.name}@${s.position}`);
  }

  it('POST / without a position inserts before Won/Lost and shifts them', async () => {
    const pipeline = generateId('pl');
    await seedStage(pipeline, 'Lead', 0);
    await seedStage(pipeline, 'Qualified', 1);
    await seedStage(pipeline, 'Won', 2, { isWon: true });
    await seedStage(pipeline, 'Lost', 3, { isLost: true });

    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:create', 'pipelines:read'), tenantDb: db },
    });
    const res = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stage 3', pipeline }),
    });
    expect(res.status).toBe(201);

    expect(await listStageNames(request, pipeline)).toEqual([
      'Lead@0',
      'Qualified@1',
      'Stage 3@2',
      'Won@3',
      'Lost@4',
    ]);

    // A second one keeps stacking in front of the closed stages.
    const res2 = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stage 4', pipeline }),
    });
    expect(res2.status).toBe(201);
    expect(await listStageNames(request, pipeline)).toEqual([
      'Lead@0',
      'Qualified@1',
      'Stage 3@2',
      'Stage 4@3',
      'Won@4',
      'Lost@5',
    ]);
  });

  it('POST / without a position repairs a legacy tie between an open stage and Won', async () => {
    const pipeline = generateId('pl');
    await seedStage(pipeline, 'Negotiation', 0);
    await seedStage(pipeline, 'Stage 3', 1);
    await seedStage(pipeline, 'Won', 1, { isWon: true }); // legacy tie
    await seedStage(pipeline, 'Lost', 2, { isLost: true });

    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:create', 'pipelines:read'), tenantDb: db },
    });
    const res = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stage 4', pipeline }),
    });
    expect(res.status).toBe(201);
    expect(await listStageNames(request, pipeline)).toEqual([
      'Negotiation@0',
      'Stage 3@1',
      'Stage 4@2',
      'Won@3',
      'Lost@4',
    ]);
  });

  it('GET / lists open stages before won/lost stages that tie on position', async () => {
    const pipeline = generateId('pl');
    await seedStage(pipeline, 'Won', 1, { isWon: true });
    await seedStage(pipeline, 'Open', 1);

    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:read'), tenantDb: db },
    });
    expect(await listStageNames(request, pipeline)).toEqual(['Open@1', 'Won@1']);
  });

  it('POST / adds a new Won/Lost stage without a position after every stage', async () => {
    const pipeline = generateId('pl');
    await seedStage(pipeline, 'Open', 0);
    await seedStage(pipeline, 'Won', 1, { isWon: true });

    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:create', 'pipelines:read'), tenantDb: db },
    });
    const res = await request('/api/pipeline-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lost', pipeline, isLost: true }),
    });
    expect(res.status).toBe(201);
    expect(await listStageNames(request, pipeline)).toEqual(['Open@0', 'Won@1', 'Lost@2']);
  });

  // ---------------------------------------------------------------------------
  // Delete guard (TASK-921): a stage still holding deals must not be
  // deletable — the deals would be orphaned (stageId pointing nowhere).
  // ---------------------------------------------------------------------------

  it('DELETE /:id is blocked when the stage still has deals', async () => {
    const now = new Date();
    const pipeline = generateId('pl');
    const stageId = generateId('pls');
    await db.insert(schema.crmPipelineStages).values({
      id: stageId,
      name: 'Occupied stage',
      position: 0,
      pipeline,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.crmOpportunities).values({
      id: generateId('opp'),
      name: 'Deal in the way',
      customerId: 'cust_delete_guard',
      amount: '100',
      currency: 'EUR',
      stage: 'prospecting',
      stageId,
      status: 'open',
      ownerId: 'user_delete_guard',
      closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      probability: 0,
      pipeline,
      createdAt: now,
      updatedAt: now,
    });

    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:delete'), tenantDb: db },
    });
    const res = await request(`/api/pipeline-stages/${stageId}`, { method: 'DELETE' });
    expect(res.status).toBe(400);

    const [row] = await db
      .select()
      .from(schema.crmPipelineStages)
      .where(eq(schema.crmPipelineStages.id, stageId))
      .limit(1);
    expect(row?.deletedAt).toBeNull();
  });

  it('DELETE /:id succeeds for an empty stage', async () => {
    const now = new Date();
    const stageId = generateId('pls');
    await db.insert(schema.crmPipelineStages).values({
      id: stageId,
      name: 'Empty stage',
      position: 0,
      pipeline: generateId('pl'),
      createdAt: now,
      updatedAt: now,
    });

    const { request } = createTestApp('/api/pipeline-stages', pipelineStagesRoutes, {
      context: { permissions: permissions('pipelines:delete'), tenantDb: db },
    });
    const res = await request(`/api/pipeline-stages/${stageId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});
