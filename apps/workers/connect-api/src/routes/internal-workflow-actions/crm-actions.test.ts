/**
 * WeldConnect CRM actions over the internal route, against pglite:
 * create_lead, create_deal, move_deal_stage, log_activity. Same shape as
 * contacts.test.ts — the owner's permissions are checked at run time, the
 * relevant crm-domain service writes the row, and the entity event carries
 * the run's chain depth.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;
const published: Array<Record<string, unknown>> = [];

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => conformanceTenantDb(db) };
});

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return {
    ...actual,
    publishEntityEventRaw: async (event: Record<string, unknown>) => {
      published.push(event);
      // Still sent, so the conformance harness compares it with Rust's.
      await actual.publishEntityEventRaw(event as never);
    },
  };
});

const { internalWorkflowActionsRoutes } = await import('./index');

const SECRET = 'internal-secret-for-tests';
const BASE = '/api/internal/workflow-actions';

/** The routes behind their internal bearer, as connect-api's public mount serves them. */
function app() {
  const { request } = createTestApp(BASE, internalWorkflowActionsRoutes as never, {
    context: { tenantDb: db },
    env: { INTERNAL_API_SECRET: SECRET } as never,
  });
  return (path: string, body: unknown) =>
    request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    });
}

const actor = (ownerUserId: string) => ({ workspaceId: 'org_1', ownerUserId, triggeredBy: 'system', chainDepth: 1 });

async function seedStage(fields: Partial<typeof schema.crmPipelineStages.$inferInsert> = {}) {
  const id = generateId('stg');
  await db.insert(schema.crmPipelineStages).values({
    id,
    name: fields.name ?? 'Stage',
    pipeline: fields.pipeline ?? 'default',
    position: fields.position ?? 0,
    isWon: fields.isWon ?? false,
    isLost: fields.isLost ?? false,
    probability: fields.probability ?? 50,
  });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_member', userId: 'member_1', role: 'MEMBER' },
    { id: 'wm_member2', userId: 'member_2', role: 'MEMBER' },
    { id: 'wm_viewer', userId: 'viewer_1', role: 'VIEWER' },
    { id: 'wm_admin', userId: 'admin_1', role: 'ADMIN' },
  ]);
}, 60_000);

beforeEach(() => {
  published.length = 0;
});

describe('POST /create-lead', () => {
  it('creates the lead as the owner and publishes lead:created with the chain depth', async () => {
    const res = await app()('/create-lead', {
      ...actor('member_1'),
      lead: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', companyName: 'Analytical Engines' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lead: { id: string; name: string; email: string } };
    expect(body.lead.email).toBe('ada@example.test');

    const [row] = await db.select().from(schema.crmLeads).where(eq(schema.crmLeads.id, body.lead.id));
    expect(row).toMatchObject({ firstName: 'Ada', email: 'ada@example.test', ownerId: 'member_1', status: 'new' });
    expect(published).toEqual([
      expect.objectContaining({ entityType: 'lead', action: 'created', userId: 'member_1', workflowDepth: 1 }),
    ]);
  });

  it('refuses when the owner may not create leads', async () => {
    const res = await app()('/create-lead', { ...actor('viewer_1'), lead: { email: 'no@example.test' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission to create leads/);
  });

  it('refuses when the owner left the workspace', async () => {
    const res = await app()('/create-lead', { ...actor('gone_1'), lead: { email: 'no@example.test' } });
    expect(res.status).toBe(403);
  });

  it('rejects a missing email before touching the database', async () => {
    const res = await app()('/create-lead', { ...actor('member_1'), lead: { firstName: 'No Email' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /create-deal', () => {
  it('creates the deal as the owner and publishes opportunity:created', async () => {
    const res = await app()('/create-deal', {
      ...actor('member_1'),
      deal: { name: 'Acme Renewal', customerId: 'cust_1', amount: 5000, currency: 'EUR' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deal: { id: string; name: string; stage: string; status: string } };
    expect(body.deal).toMatchObject({ name: 'Acme Renewal', stage: 'prospecting', status: 'open' });

    const [row] = await db.select().from(schema.crmOpportunities).where(eq(schema.crmOpportunities.id, body.deal.id));
    expect(row).toMatchObject({ name: 'Acme Renewal', customerId: 'cust_1', ownerId: 'member_1' });
    expect(Number(row?.amount)).toBe(5000);
    expect(published).toEqual([
      expect.objectContaining({ entityType: 'opportunity', action: 'created', userId: 'member_1', workflowDepth: 1 }),
    ]);
  });

  it('refuses when the owner may not create deals', async () => {
    const res = await app()('/create-deal', { ...actor('viewer_1'), deal: { name: 'No', customerId: 'cust_1' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission to create deals/);
  });

  it('rejects a missing customerId before touching the database', async () => {
    const res = await app()('/create-deal', { ...actor('member_1'), deal: { name: 'No Customer' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /move-deal-stage', () => {
  it("moves a deal the owner owns, syncs won status, and publishes the derived events", async () => {
    const wonStage = await seedStage({ isWon: true, probability: 100 });
    const createRes = await app()('/create-deal', { ...actor('member_1'), deal: { name: 'Pipeline Deal', customerId: 'cust_1' } });
    const { deal } = (await createRes.json()) as { deal: { id: string } };
    published.length = 0;

    const res = await app()('/move-deal-stage', { ...actor('member_1'), dealId: deal.id, stageId: wonStage });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deal: { id: string; stageId: string; status: string } };
    expect(body.deal.status).toBe('won');

    const actions = published.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['updated', 'stage_changed', 'won']));
    expect(published[0]).toMatchObject({ entityType: 'opportunity', workflowDepth: 1, userId: 'member_1' });
  });

  it("keeps a member's workflow to deals they own", async () => {
    const stage = await seedStage();
    const createRes = await app()('/create-deal', { ...actor('member_2'), deal: { name: "Other's Deal", customerId: 'cust_1' } });
    const { deal } = (await createRes.json()) as { deal: { id: string } };

    const res = await app()('/move-deal-stage', { ...actor('member_1'), dealId: deal.id, stageId: stage });
    expect(res.status).toBe(404);
  });

  it("lets an owner with opportunities:scope:all move any deal", async () => {
    const stage = await seedStage();
    const createRes = await app()('/create-deal', { ...actor('member_2'), deal: { name: 'Admin Reach', customerId: 'cust_1' } });
    const { deal } = (await createRes.json()) as { deal: { id: string } };

    const res = await app()('/move-deal-stage', { ...actor('admin_1'), dealId: deal.id, stageId: stage });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown stage', async () => {
    const createRes = await app()('/create-deal', { ...actor('member_1'), deal: { name: 'Bad Stage Deal', customerId: 'cust_1' } });
    const { deal } = (await createRes.json()) as { deal: { id: string } };

    const res = await app()('/move-deal-stage', { ...actor('member_1'), dealId: deal.id, stageId: 'stg_missing' });
    expect(res.status).toBe(400);
  });
});

describe('POST /log-activity', () => {
  it('logs the activity as the owner and publishes activity:created', async () => {
    const res = await app()('/log-activity', {
      ...actor('member_1'),
      activity: { type: 'call', subject: 'Discovery call', personId: 'person_1' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { id: string; type: string; subject: string } };
    expect(body.activity).toMatchObject({ type: 'call', subject: 'Discovery call' });

    const [row] = await db.select().from(schema.crmActivities).where(eq(schema.crmActivities.id, body.activity.id));
    expect(row).toMatchObject({ type: 'call', subject: 'Discovery call', personId: 'person_1', assignedToId: 'member_1' });
    expect(published).toEqual([
      expect.objectContaining({ entityType: 'activity', action: 'created', userId: 'member_1', workflowDepth: 1 }),
    ]);
  });

  it('refuses when the owner may not log activities', async () => {
    const res = await app()('/log-activity', { ...actor('viewer_1'), activity: { type: 'note', subject: 'No' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission to log activities/);
  });

  it('rejects a missing subject before touching the database', async () => {
    const res = await app()('/log-activity', { ...actor('member_1'), activity: { type: 'note' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /create-customer', () => {
  const customerBody = (over: Record<string, unknown> = {}) => ({
    workspaceId: 'org_1',
    userId: 'member_1',
    ownerUserId: 'member_1',
    chainDepth: 2,
    customer: { name: '  Acme Corp ', email: 'billing@acme.test', phone: '+31 20 123', notes: '' },
    ...over,
  });

  it('creates the company as the owner and publishes company:created with the chain depth', async () => {
    const res = await app()('/create-customer', customerBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean; customer: { id: string; name: string; status: string } };
    expect(body).toMatchObject({ created: true, customer: { name: 'Acme Corp', status: 'active' } });

    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, body.customer.id));
    expect(row).toMatchObject({ name: 'Acme Corp', email: 'billing@acme.test', ownerId: 'member_1', source: 'weldconnect' });
    expect(published).toEqual([
      expect.objectContaining({ entityType: 'company', action: 'created', userId: 'member_1', workflowDepth: 2 }),
    ]);
  });

  it('reuses a company with the same email (any case) instead of duplicating it', async () => {
    const res = await app()('/create-customer', customerBody({ customer: { name: 'Acme Again', email: 'BILLING@acme.test' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false, customer: { name: 'Acme Corp' } });
    expect(published).toEqual([]);
  });

  it('creates a second company when skipIfEmailExists is off, without an owner for a schedule run', async () => {
    const res = await app()(
      '/create-customer',
      customerBody({
        userId: 'system',
        ownerUserId: undefined,
        skipIfEmailExists: false,
        customer: { name: 'Acme Twin', email: 'billing@acme.test', status: 'prospect' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean; customer: { id: string; status: string } };
    expect(body).toMatchObject({ created: true, customer: { status: 'prospect' } });
    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, body.customer.id));
    expect(row?.ownerId).toBeNull();
  });

  it('refuses when the owner may not create companies', async () => {
    const res = await app()('/create-customer', customerBody({ ownerUserId: 'viewer_1' }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission to create companies/);
  });

  it('rejects an invalid email and a missing name in one answer', async () => {
    const res = await app()('/create-customer', customerBody({ customer: { name: ' ', email: 'not-an-email' } }));
    expect(res.status).toBe(400);
    const issues = ((await res.json()) as { error: { issues: Array<{ path: string[]; message: string }> } }).error.issues;
    expect(issues.map((i) => i.path.join('.'))).toEqual(['customer.name', 'customer.email']);
  });
});

describe('the internal bearer', () => {
  const call = (env: Record<string, unknown>, headers: Record<string, string>) =>
    createTestApp(BASE, internalWorkflowActionsRoutes as never, { context: { tenantDb: db }, env: env as never }).request(
      `${BASE}/create-lead`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' },
    );

  it('is closed without a configured secret', async () => {
    const res = await call({}, { Authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Internal auth not configured' });
  });

  it('refuses a missing or wrong bearer before reading the body', async () => {
    const missing = await call({ INTERNAL_API_SECRET: SECRET }, {});
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Missing or invalid Authorization header' });
    const wrong = await call({ INTERNAL_API_SECRET: SECRET }, { Authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Unauthorized' });
  });
});
