/**
 * DB-backed integration tests for /api/opportunities.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { opportunitiesRoutes } from './index';
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

describe('/api/opportunities · pglite integration', () => {
  it('POST / writes an opportunity and publishes opportunity.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        permissions: permissions('opportunities:create'),
        tenantDb: db,
      },
    });

    const res = await request('/api/opportunities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E Deal',
        customerId: 'cust_e2e_synthetic',
        amount: 5000,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^opp_/);

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('E2E Deal');

    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'opportunity',
        action: 'created',
      }),
    );
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        permissions: permissions('opportunities:create'),
        tenantDb: db,
      },
    });
    const res = await request('/api/opportunities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', customerId: 'cust_x' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST / rejects missing customerId', async () => {
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        permissions: permissions('opportunities:create'),
        tenantDb: db,
      },
    });
    const res = await request('/api/opportunities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lonely deal' }),
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Owner-scoping tests (verify opportunities:scope:all is wired correctly)
  // ---------------------------------------------------------------------------

  it('scope-isolation: scoped user does NOT see another owner\'s opportunity in list', async () => {
    const otherId = generateId('opp');
    const now = new Date();
    await db.insert(schema.crmOpportunities).values({
      id: otherId,
      name: 'Other owner deal',
      customerId: 'cust_scope_test',
      amount: '1000',
      currency: 'EUR',
      stage: 'prospecting',
      status: 'open',
      ownerId: 'user_other_opp',
      closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      probability: 0,
      pipeline: 'default',
      createdAt: now,
      updatedAt: now,
    });

    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_scoped_opp',
        permissions: permissions('opportunities:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/opportunities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain(otherId);
  });

  it('scope-isolation: scoped user gets 404 on GET /:id for another owner\'s opportunity', async () => {
    const otherId = generateId('opp');
    const now = new Date();
    await db.insert(schema.crmOpportunities).values({
      id: otherId,
      name: 'Private deal',
      customerId: 'cust_scope_test2',
      amount: '2000',
      currency: 'EUR',
      stage: 'prospecting',
      status: 'open',
      ownerId: 'user_other_opp2',
      closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      probability: 0,
      pipeline: 'default',
      createdAt: now,
      updatedAt: now,
    });

    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_scoped_opp2',
        permissions: permissions('opportunities:read'),
        tenantDb: db,
      },
    });
    const res = await request(`/api/opportunities/${otherId}`);
    expect(res.status).toBe(404);
  });

  it('scope-isolation: user with opportunities:scope:all DOES see another owner\'s opportunity in list', async () => {
    const ownedId = generateId('opp');
    const now = new Date();
    await db.insert(schema.crmOpportunities).values({
      id: ownedId,
      name: 'Admin visible deal',
      customerId: 'cust_scope_test3',
      amount: '3000',
      currency: 'EUR',
      stage: 'prospecting',
      status: 'open',
      ownerId: 'user_admin_target_opp',
      closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      probability: 0,
      pipeline: 'default',
      createdAt: now,
      updatedAt: now,
    });

    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_admin_opp',
        permissions: permissions('opportunities:read', 'opportunities:scope:all'),
        tenantDb: db,
      },
    });
    const res = await request('/api/opportunities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(ownedId);
  });

  // ---------------------------------------------------------------------------
  // Stage moves: `stageId` is what the board places a deal by, `stage` is the
  // legacy text twin — a move by `stageId` must not leave the two disagreeing.
  // ---------------------------------------------------------------------------

  async function seedDealInStage() {
    const now = new Date();
    const pipelineId = generateId('pl');
    const stageOne = generateId('pls');
    const stageTwo = generateId('pls');
    await db.insert(schema.crmPipelineStages).values([
      { id: stageOne, name: 'Stage 1', position: 0, pipeline: pipelineId, createdAt: now, updatedAt: now },
      { id: stageTwo, name: 'Stage 2', position: 1, pipeline: pipelineId, createdAt: now, updatedAt: now },
    ]);
    const dealId = generateId('opp');
    await db.insert(schema.crmOpportunities).values({
      id: dealId,
      name: 'Acme annual contract',
      customerId: 'cust_stage_move',
      amount: '1000',
      currency: 'EUR',
      stage: 'prospecting',
      stageId: stageOne,
      status: 'open',
      ownerId: 'user_stage_move',
      closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      probability: 0,
      pipeline: pipelineId,
      createdAt: now,
      updatedAt: now,
    });
    return { dealId, stageOne, stageTwo };
  }

  it('PATCH /:id with only stageId moves the deal and keeps the legacy stage in step', async () => {
    const { dealId, stageTwo } = await seedDealInStage();
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_stage_move',
        permissions: permissions('opportunities:update'),
        tenantDb: db,
      },
    });

    const res = await request(`/api/opportunities/${dealId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId: stageTwo }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, dealId))
      .limit(1);
    expect(row?.stageId).toBe(stageTwo);
    expect(row?.stage).toBe(stageTwo);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'opportunity', action: 'stage_changed' }),
    );
  });

  it('PATCH /:id rejects a stageId that is not a pipeline stage and leaves the deal untouched', async () => {
    const { dealId, stageOne } = await seedDealInStage();
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_stage_move',
        permissions: permissions('opportunities:update'),
        tenantDb: db,
      },
    });

    const res = await request(`/api/opportunities/${dealId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId: 'pls_does_not_exist' }),
    });
    expect(res.status).toBe(400);

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, dealId))
      .limit(1);
    expect(row?.stageId).toBe(stageOne);
    expect(row?.stage).toBe('prospecting');
  });
});
