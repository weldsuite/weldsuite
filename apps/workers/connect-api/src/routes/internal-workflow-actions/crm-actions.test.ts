/**
 * WeldConnect CRM actions over the internal route, against pglite:
 * create_lead, create_deal, move_deal_stage, log_activity. Same shape as
 * contacts.test.ts — the owner's permissions are checked at run time, the
 * relevant crm-domain service writes the row, and the entity event carries
 * the run's chain depth.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;
const published: Array<Record<string, unknown>> = [];

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => db };
});

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return {
    ...actual,
    publishEntityEventRaw: async (event: Record<string, unknown>) => {
      published.push(event);
    },
  };
});

const { internalWorkflowActionsRoutes } = await import('./index');

function app() {
  const root = new Hono<{ Variables: { internalTrusted: boolean } }>();
  root.use('*', async (c, next) => {
    c.set('internalTrusted', true);
    await next();
  });
  root.route('/', internalWorkflowActionsRoutes as never);
  return (path: string, body: unknown) =>
    root.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, {});
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
