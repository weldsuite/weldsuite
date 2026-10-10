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

  it('POST / fills customerName from the linked company (TASK-917: "(unknown company)" on the deal panel)', async () => {
    const companyId = generateId('co');
    const now = new Date();
    await db.insert(schema.companies).values({
      id: companyId,
      name: 'Acme Resolved Co',
      displayName: 'Acme Resolved Co',
      createdAt: now,
      updatedAt: now,
    });
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        permissions: permissions('opportunities:create'),
        tenantDb: db,
      },
    });

    const res = await request('/api/opportunities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Deal with company', customerId: companyId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, body.data.id))
      .limit(1);
    expect(row?.customerName).toBe('Acme Resolved Co');
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

  // ---------------------------------------------------------------------------
  // Won/lost <-> stage sync (TASK-919): the two directions must agree —
  // dragging into a won/lost stage flips status, and marking won/lost moves
  // the stage.
  // ---------------------------------------------------------------------------

  async function seedDealWithWonLostStages() {
    const now = new Date();
    const pipelineId = generateId('pl');
    const openStage = generateId('pls');
    const wonStage = generateId('pls');
    const lostStage = generateId('pls');
    await db.insert(schema.crmPipelineStages).values([
      { id: openStage, name: 'Open', position: 0, pipeline: pipelineId, probability: 25, isWon: false, isLost: false, createdAt: now, updatedAt: now },
      { id: wonStage, name: 'Won', position: 1, pipeline: pipelineId, probability: 100, isWon: true, isLost: false, createdAt: now, updatedAt: now },
      { id: lostStage, name: 'Lost', position: 2, pipeline: pipelineId, probability: 0, isWon: false, isLost: true, createdAt: now, updatedAt: now },
    ]);
    const dealId = generateId('opp');
    await db.insert(schema.crmOpportunities).values({
      id: dealId,
      name: 'Won/lost sync deal',
      customerId: 'cust_won_lost_sync',
      amount: '1000',
      currency: 'EUR',
      stage: 'prospecting',
      stageId: openStage,
      status: 'open',
      ownerId: 'user_won_lost_sync',
      closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      probability: 25,
      pipeline: pipelineId,
      createdAt: now,
      updatedAt: now,
    });
    return { dealId, pipelineId, openStage, wonStage, lostStage };
  }

  it('PATCH /:id moving a deal to an isWon stage sets status=won, actualCloseDate and probability', async () => {
    const { dealId, wonStage } = await seedDealWithWonLostStages();
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_won_lost_sync',
        permissions: permissions('opportunities:update'),
        tenantDb: db,
      },
    });

    const res = await request(`/api/opportunities/${dealId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId: wonStage }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, dealId))
      .limit(1);
    expect(row?.stageId).toBe(wonStage);
    expect(row?.status).toBe('won');
    expect(row?.actualCloseDate).toBeInstanceOf(Date);
    expect(row?.probability).toBe(100);
  });

  it('PATCH /:id moving a deal out of a won stage back to an open stage reopens it and clears actualCloseDate', async () => {
    const { dealId, openStage, wonStage } = await seedDealWithWonLostStages();
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_won_lost_sync',
        permissions: permissions('opportunities:update'),
        tenantDb: db,
      },
    });

    await request(`/api/opportunities/${dealId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId: wonStage }),
    });

    const res = await request(`/api/opportunities/${dealId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId: openStage }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, dealId))
      .limit(1);
    expect(row?.stageId).toBe(openStage);
    expect(row?.status).toBe('open');
    expect(row?.actualCloseDate).toBeNull();
  });

  it('PATCH /:id with status=won (no stageId) moves the deal to the pipeline\'s isWon stage and stamps actualCloseDate', async () => {
    const { dealId, wonStage } = await seedDealWithWonLostStages();
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_won_lost_sync',
        permissions: permissions('opportunities:update'),
        tenantDb: db,
      },
    });

    const res = await request(`/api/opportunities/${dealId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'won' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, dealId))
      .limit(1);
    expect(row?.status).toBe('won');
    expect(row?.stageId).toBe(wonStage);
    expect(row?.actualCloseDate).toBeInstanceOf(Date);
  });

  it('PATCH /:id with status=lost (no stageId) moves the deal to the pipeline\'s isLost stage', async () => {
    const { dealId, lostStage } = await seedDealWithWonLostStages();
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: {
        userId: 'user_won_lost_sync',
        permissions: permissions('opportunities:update'),
        tenantDb: db,
      },
    });

    const res = await request(`/api/opportunities/${dealId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'lost' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, dealId))
      .limit(1);
    expect(row?.status).toBe('lost');
    expect(row?.stageId).toBe(lostStage);
  });

  // ---------------------------------------------------------------------------
  // TASK-947: reopening / creating keeps probability in step with the stage.
  // ---------------------------------------------------------------------------

  function patchAs(userId: string) {
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: { userId, permissions: permissions('opportunities:update'), tenantDb: db },
    });
    return (id: string, body: Record<string, unknown>) =>
      request(`/api/opportunities/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
  }

  async function loadDeal(id: string) {
    const [row] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, id))
      .limit(1);
    return row;
  }

  it('PATCH /:id status=open on a Won deal moves it to the first open stage with that stage\'s probability', async () => {
    const { dealId, openStage } = await seedDealWithWonLostStages();
    const patch = patchAs('user_won_lost_sync');
    await patch(dealId, { status: 'won' });
    expect((await loadDeal(dealId))?.probability).toBe(100);

    const res = await patch(dealId, { status: 'open' });
    expect(res.status).toBe(200);

    const row = await loadDeal(dealId);
    expect(row?.status).toBe('open');
    expect(row?.stageId).toBe(openStage);
    expect(row?.stage).toBe(openStage);
    expect(row?.probability).toBe(25);
    expect(row?.actualCloseDate).toBeNull();
  });

  it('PATCH /:id status=open keeps an explicitly supplied probability', async () => {
    const { dealId } = await seedDealWithWonLostStages();
    const patch = patchAs('user_won_lost_sync');
    await patch(dealId, { status: 'lost' });

    await patch(dealId, { status: 'open', probability: 60 });
    const row = await loadDeal(dealId);
    expect(row?.status).toBe('open');
    expect(row?.probability).toBe(60);
  });

  it('PATCH /:id moving a Lost deal onto an open stage takes the stage probability', async () => {
    const { dealId, openStage, lostStage } = await seedDealWithWonLostStages();
    const patch = patchAs('user_won_lost_sync');
    await patch(dealId, { stageId: lostStage });
    expect((await loadDeal(dealId))?.probability).toBe(0);

    await patch(dealId, { stageId: openStage });
    const row = await loadDeal(dealId);
    expect(row?.status).toBe('open');
    expect(row?.probability).toBe(25);
  });

  it('PATCH /:id moving a Lost deal onto an open stage keeps an explicit probability from the same request', async () => {
    const { dealId, openStage, lostStage } = await seedDealWithWonLostStages();
    const patch = patchAs('user_won_lost_sync');
    await patch(dealId, { stageId: lostStage });

    await patch(dealId, { stageId: openStage, probability: 70 });
    expect((await loadDeal(dealId))?.probability).toBe(70);
  });

  it('POST / without probability starts at the stage probability; explicit probability wins', async () => {
    const { openStage } = await seedDealWithWonLostStages();
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: { userId: 'user_create_prob', permissions: permissions('opportunities:create'), tenantDb: db },
    });
    const post = async (body: Record<string, unknown>) => {
      const res = await request('/api/opportunities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Prob deal', customerId: 'cust_prob', ...body }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { id: string } }).data.id;
    };

    expect((await loadDeal(await post({ stageId: openStage })))?.probability).toBe(25);
    expect((await loadDeal(await post({ stageId: openStage, probability: 80 })))?.probability).toBe(80);
  });

  // ---------------------------------------------------------------------------
  // TASK-949: currency must be a real ISO 4217 code.
  // ---------------------------------------------------------------------------

  it('POST / rejects an unknown currency code and accepts a real one', async () => {
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: { userId: 'user_cur', permissions: permissions('opportunities:create'), tenantDb: db },
    });
    const post = (currency: string) =>
      request('/api/opportunities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cur deal', customerId: 'cust_cur', currency }),
      });
    expect((await post('XYZ')).status).toBe(400);
    const ok = await post('GBP');
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { data: { id: string } }).data.id;
    expect((await loadDeal(id))?.currency).toBe('GBP');
  });

  it('PATCH /:id rejects an unknown currency code', async () => {
    const { dealId } = await seedDealInStage();
    const res = await patchAs('user_stage_move')(dealId, { currency: 'XYZ' });
    expect(res.status).toBe(400);
    expect((await loadDeal(dealId))?.currency).toBe('EUR');
  });

  // ---------------------------------------------------------------------------
  // TASK-1040: deals of a deleted company must stay on the board.
  // ---------------------------------------------------------------------------

  it('GET / still lists deals whose company was deleted, flagged companyDeleted', async () => {
    const now = new Date();
    const companyId = generateId('co');
    await db.insert(schema.companies).values({
      id: companyId,
      name: 'Doomed Co',
      displayName: 'Doomed Co',
      createdAt: now,
      updatedAt: now,
    });
    const pipelineId = generateId('pl');
    const liveDeal = generateId('opp');
    const orphanDeal = generateId('opp');
    const base = {
      amount: '100',
      currency: 'EUR',
      stage: 'prospecting',
      status: 'open',
      ownerId: 'user_orphan',
      closeDate: new Date(Date.now() + 86_400_000),
      pipeline: pipelineId,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.crmOpportunities).values([
      { ...base, id: liveDeal, name: 'Live deal', customerId: companyId, customerName: 'Doomed Co' },
      { ...base, id: orphanDeal, name: 'Orphan deal', customerId: 'co_never_existed' },
    ]);
    await db.update(schema.companies).set({ deletedAt: new Date() }).where(eq(schema.companies.id, companyId));

    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: { userId: 'user_orphan', permissions: permissions('opportunities:read'), tenantDb: db },
    });
    const res = await request(`/api/opportunities?pipeline=${pipelineId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; companyDeleted: boolean }>;
      pagination: { totalCount: number };
    };
    expect(body.pagination.totalCount).toBe(2);
    const byId = new Map(body.data.map((d) => [d.id, d]));
    expect(byId.get(liveDeal)?.companyDeleted).toBe(true);
    expect(byId.get(orphanDeal)?.companyDeleted).toBe(true);

    const one = await request(`/api/opportunities/${liveDeal}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { data: { companyDeleted: boolean } }).data.companyDeleted).toBe(true);
  });

  it('GET / flags companyDeleted=false for a deal with a live company', async () => {
    const now = new Date();
    const companyId = generateId('co');
    await db.insert(schema.companies).values({ id: companyId, name: 'Alive Co', displayName: 'Alive Co', createdAt: now, updatedAt: now });
    const pipelineId = generateId('pl');
    const dealId = generateId('opp');
    await db.insert(schema.crmOpportunities).values({
      id: dealId,
      name: 'Alive deal',
      customerId: companyId,
      amount: '1',
      currency: 'EUR',
      stage: 'prospecting',
      status: 'open',
      ownerId: 'user_alive',
      closeDate: new Date(Date.now() + 86_400_000),
      pipeline: pipelineId,
      createdAt: now,
      updatedAt: now,
    });
    const { request } = createTestApp('/api/opportunities', opportunitiesRoutes, {
      context: { userId: 'user_alive', permissions: permissions('opportunities:read'), tenantDb: db },
    });
    const res = await request(`/api/opportunities?pipeline=${pipelineId}`);
    const body = (await res.json()) as { data: Array<{ id: string; companyDeleted: boolean }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.companyDeleted).toBe(false);
  });
});
