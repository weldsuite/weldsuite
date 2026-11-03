/**
 * /api/ad-campaigns on pglite, beyond the happy paths of
 * ./integration.test.ts: the list's filters and pages, a campaign by id, and
 * the refusals of create and update (validation, accounts that are gone or
 * not synced).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { adCampaignsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const { adPlatformConnections: connections, adAccounts: accounts, adCampaigns: campaigns } = schema;
const BASE = '/api/ad-campaigns';
const ALL = ['ad_campaigns:read', 'ad_campaigns:create', 'ad_campaigns:update'];

let db: Database;

function app(grants = ALL) {
  return createTestApp(BASE, adCampaignsRoutes, { context: { tenantDb: db, permissions: permissions(...grants) } });
}

function send(method: string, path: string, body: unknown, grants = ALL) {
  return app(grants).request(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface ListBody {
  data: Array<{ id: string; name: string; accountName: string; platformAccountId: string }>;
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

async function list(query = ''): Promise<ListBody> {
  const res = await app().request(`${BASE}${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(connections).values({ id: 'adcn_c', platform: 'facebook', status: 'active', createdAt: now, updatedAt: now });
  await db.insert(accounts).values([
    { id: 'adac_live', connectionId: 'adcn_c', platformAccountId: 'act_10', name: 'Live', currency: 'EUR', isSelected: true, createdAt: now, updatedAt: now },
    { id: 'adac_idle', connectionId: 'adcn_c', platformAccountId: 'act_11', name: 'Idle', createdAt: now, updatedAt: now },
    { id: 'adac_gone', connectionId: 'adcn_c', platformAccountId: 'act_12', name: 'Gone', isSelected: true, createdAt: now, updatedAt: now, deletedAt: now },
  ]);
  const row = (id: string, minute: number, values: Partial<typeof campaigns.$inferInsert> = {}) => ({
    id,
    adAccountId: 'adac_live',
    name: id,
    createdAt: at(minute),
    updatedAt: at(minute),
    ...values,
  });
  await db.insert(campaigns).values([
    row('adcp_l1', 1, { name: 'Spring sale', status: 'ACTIVE', syncStatus: 'synced', platformCampaignId: 'c1', metrics: { spend: '3' } }),
    row('adcp_l2', 2, { name: 'Summer sale', status: 'PAUSED', syncStatus: 'pending_push', dailyBudget: 900 }),
    row('adcp_l3', 3, { name: 'Brand', status: 'ACTIVE', syncStatus: 'error', syncError: 'Meta said no' }),
    row('adcp_l4', 4, { name: 'Autumn sale', adAccountId: 'adac_idle', status: 'ACTIVE', syncStatus: 'local' }),
    row('adcp_l5', 5, { name: 'Deleted sale', deletedAt: at(6) }),
    row('adcp_idle', 7, { name: 'Idle campaign', adAccountId: 'adac_idle', objective: 'OUTCOME_LEADS', syncStatus: 'synced' }),
    row('adcp_gone', 8, { name: 'Gone account', adAccountId: 'adac_gone', syncStatus: 'synced' }),
  ]);
}, 180_000);

describe('GET /api/ad-campaigns', () => {
  it('lists the live campaigns, most recently updated first, with their account', async () => {
    const body = await list();
    expect(body.data.map((c) => c.id)).toEqual(['adcp_gone', 'adcp_idle', 'adcp_l4', 'adcp_l3', 'adcp_l2', 'adcp_l1']);
    expect(body.data[5]).toMatchObject({ accountName: 'Live', platformAccountId: 'act_10', metrics: { spend: '3' } });
    expect(body.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
  });

  it('filters on account, status, sync status and name', async () => {
    expect((await list('?adAccountId=adac_idle')).data.map((c) => c.id)).toEqual(['adcp_idle', 'adcp_l4']);
    expect((await list('?status=ACTIVE')).data.map((c) => c.id)).toEqual(['adcp_l4', 'adcp_l3', 'adcp_l1']);
    expect((await list('?syncStatus=synced')).data.map((c) => c.id)).toEqual(['adcp_gone', 'adcp_idle', 'adcp_l1']);
    const sales = await list('?search=sale');
    expect(sales.data.map((c) => c.id)).toEqual(['adcp_l4', 'adcp_l2', 'adcp_l1']);
    expect(sales.pagination.totalCount).toBe(3);
    // `like` is case-sensitive.
    expect((await list('?search=Sale')).data).toEqual([]);
    expect((await list('?status=&search=')).data).toHaveLength(6);
  });

  it('pages with a cursor', async () => {
    const first = await list('?limit=2');
    expect(first.data.map((c) => c.id)).toEqual(['adcp_gone', 'adcp_idle']);
    expect(first.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'adcp_idle' });
    const second = await list('?limit=2&cursor=adcp_idle');
    expect(second.data.map((c) => c.id)).toEqual(['adcp_l4', 'adcp_l3']);
    expect(second.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'adcp_l3' });
    const last = await list('?limit=5&cursor=adcp_l3');
    expect(last.data.map((c) => c.id)).toEqual(['adcp_l2', 'adcp_l1']);
    expect(last.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
  });

  it('counts without the last filter when the cursor is unknown, as the worker does', async () => {
    const unknown = await list('?search=sale&cursor=adcp_missing');
    expect(unknown.data.map((c) => c.id)).toEqual(['adcp_l4', 'adcp_l2', 'adcp_l1']);
    expect(unknown.pagination.totalCount).toBe(6);
    // With no filter left, the count takes the deleted campaign too.
    expect((await list('?cursor=adcp_missing')).pagination.totalCount).toBe(7);
  });

  it('caps the page at 100 and reads a page of none', async () => {
    expect((await list('?limit=500')).data).toHaveLength(6);
    const none = await list('?limit=0');
    expect(none.data).toEqual([]);
    expect(none.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: null });
  });

  it('answers 500 for a sync status the column does not know', async () => {
    const res = await app().request(`${BASE}?syncStatus=bogus`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list ad campaigns' } });
  });

  it('needs ad_campaigns:read', async () => {
    const res = await app(['ad_campaigns:create']).request(BASE);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/ad-campaigns/:id', () => {
  it('answers the campaign', async () => {
    const res = await app().request(`${BASE}/adcp_l3`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ id: 'adcp_l3', name: 'Brand', syncError: 'Meta said no', contentHash: null, metrics: null });
  });

  it('answers 404 for an unknown or deleted campaign', async () => {
    for (const id of ['adcp_missing', 'adcp_l5']) {
      const res = await app().request(`${BASE}/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Ad campaign with ID '${id}' not found` } });
    }
  });

  it('needs ad_campaigns:read', async () => {
    const res = await app(['ad_campaigns:update']).request(`${BASE}/adcp_l3`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/ad-campaigns', () => {
  it('creates a paused campaign in the account’s currency, with a lifetime budget only', async () => {
    const res = await send('POST', '', {
      adAccountId: 'adac_live',
      name: '  Winter  ',
      objective: 'OUTCOME_AWARENESS',
      lifetimeBudget: 50000,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      name: 'Winter',
      status: 'PAUSED',
      currency: 'EUR',
      dailyBudget: null,
      lifetimeBudget: 50000,
      syncStatus: 'pending_push',
      platformCampaignId: null,
      deletedAt: null,
    });
  });

  it('validates the body', async () => {
    const cases: Array<[unknown, string[]]> = [
      [{}, ['adAccountId', 'name', 'objective']],
      [{ adAccountId: 'adac_live', name: 'x', objective: 'OUTCOME_SALES' }, ['dailyBudget']],
      [{ adAccountId: '', name: ' ', objective: 'OUTCOME_SALES', dailyBudget: -1.5 }, ['adAccountId', 'name', 'dailyBudget', 'dailyBudget']],
      [{ adAccountId: 'adac_live', name: 'x', objective: 'MONEY', status: 'DELETED', lifetimeBudget: 0 }, ['objective', 'status', 'lifetimeBudget']],
      [{ adAccountId: 'adac_live', name: 'x'.repeat(256), objective: 'OUTCOME_SALES', dailyBudget: '5' }, ['name', 'dailyBudget']],
    ];
    for (const [body, paths] of cases) {
      const res = await send('POST', '', body);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { issues: Array<{ path: unknown[] }> } };
      expect(json.error.issues.map((issue) => issue.path.join('.'))).toEqual(paths);
    }
  });

  it('refuses an account that is gone or not synced', async () => {
    const base = { name: 'Nope', objective: 'OUTCOME_SALES', dailyBudget: 100 };
    const cases: Array<[string, string]> = [
      ['adac_missing', 'Ad account not found'],
      ['adac_gone', 'Ad account not found'],
      ['adac_idle', 'Ad account is not selected for sync'],
    ];
    for (const [adAccountId, message] of cases) {
      const res = await send('POST', '', { ...base, adAccountId });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  it('needs ad_campaigns:create', async () => {
    const res = await send('POST', '', { adAccountId: 'adac_live', name: 'x', objective: 'OUTCOME_SALES', dailyBudget: 1 }, [
      'ad_campaigns:read',
    ]);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/ad-campaigns/:id', () => {
  it('updates several fields and marks the campaign for a push', async () => {
    const res = await send('PATCH', '/adcp_l3', {
      name: 'Brand 2',
      objective: 'OUTCOME_ENGAGEMENT',
      dailyBudget: 1200,
      lifetimeBudget: 99000,
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      name: 'Brand 2',
      status: 'ACTIVE',
      objective: 'OUTCOME_ENGAGEMENT',
      dailyBudget: 1200,
      lifetimeBudget: 99000,
      syncStatus: 'pending_push',
      syncError: null,
    });
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, 'adcp_l3'));
    expect(row!.name).toBe('Brand 2');
  });

  it('validates the body', async () => {
    const cases: Array<[unknown, string[]]> = [
      [{}, ['']],
      [{ name: '', status: 'STOPPED' }, ['name', 'status']],
      [{ dailyBudget: 0, lifetimeBudget: 2.5 }, ['dailyBudget', 'lifetimeBudget']],
      [{ objective: null }, ['objective']],
    ];
    for (const [body, paths] of cases) {
      const res = await send('PATCH', '/adcp_l3', body);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { issues: Array<{ path: unknown[]; message: string }> } };
      expect(json.error.issues.map((issue) => issue.path.join('.'))).toEqual(paths);
      if (paths[0] === '') expect(json.error.issues[0]?.message).toBe('At least one field is required');
    }
  });

  it('answers 404 for an unknown campaign, or one whose account is gone', async () => {
    for (const id of ['adcp_missing', 'adcp_l5', 'adcp_gone']) {
      const res = await send('PATCH', `/${id}`, { status: 'PAUSED' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Ad campaign with ID '${id}' not found` } });
    }
  });

  it('refuses a campaign whose account is not synced', async () => {
    const res = await send('PATCH', '/adcp_idle', { name: 'Still idle' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Ad account is not selected for sync' } });
  });

  it('needs ad_campaigns:update', async () => {
    const res = await send('PATCH', '/adcp_l3', { status: 'PAUSED' }, ['ad_campaigns:read']);
    expect(res.status).toBe(403);
  });
});
