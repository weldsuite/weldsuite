/**
 * /api/ad-connections on pglite: the Meta OAuth start and callback, the
 * connection list, a sync (push of pending campaigns, pull of synced ones,
 * with their insights) and the disconnect. Meta's Graph API is a fetch stub
 * that answers by URL (../../test/meta-stub.ts); the OAuth state lives in a
 * KV namespace and the sync index in a master pglite, both shared with the
 * Rust server in conformance mode.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { encryptField } from '@weldsuite/db/lib/crypto';
import { hashCampaignPayload } from '@weldsuite/meta-ads';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { FACEBOOK_ENV, GRAPH, createMetaFetchStub, graphCallsSince, sortCalls } from '../../test/meta-stub';

const WORKSPACE_ID = 'ws_test_default';
const ORG_ID = 'org_test_default';

// The sync index lives in the master database; the workspace resolves to the
// harness's default one.
const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => ({ id: 'ws_test_default', clerkOrgId: orgId }),
  };
});

import { adConnectionsRoutes } from './index';

const { adPlatformConnections: connections, adAccounts: accounts, adCampaigns: campaigns } = schema;
const BASE = '/api/ad-connections';
const KEYRING = { v2: FACEBOOK_ENV.DATABASE_ENCRYPTION_KEY_V2 };

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const kv = createMemoryKv();
const meta = createMetaFetchStub();

interface AppOptions {
  env?: Record<string, unknown>;
  orgId?: string | null;
  grants?: string[];
}

function app({ env = {}, orgId = ORG_ID, grants = ['ad_accounts:read', 'ad_accounts:update'] }: AppOptions = {}) {
  return createTestApp(BASE, adConnectionsRoutes, {
    context: { tenantDb: db, masterDb: master, orgId, permissions: permissions(...grants) },
    env: { WORKSPACE_CACHE: kv, ...FACEBOOK_ENV, ...env } as never,
  });
}

function post(path: string, body?: unknown, options: AppOptions = {}) {
  return app(options).request(`${BASE}${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** Starts the OAuth flow and returns the state it stored. */
async function authorize(): Promise<string> {
  const res = await post('/facebook/authorize');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { state: string } };
  return body.data.state;
}

async function seedConnection(id: string, values: Partial<typeof connections.$inferInsert> = {}) {
  const now = new Date();
  await db.insert(connections).values({
    id,
    platform: 'facebook',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...values,
  });
}

async function seedAccount(id: string, connectionId: string, values: Partial<typeof accounts.$inferInsert> = {}) {
  const now = new Date();
  await db.insert(accounts).values({
    id,
    connectionId,
    platformAccountId: `act_${id}`,
    name: id,
    isSelected: true,
    createdAt: now,
    updatedAt: now,
    ...values,
  });
}

async function seedCampaign(id: string, adAccountId: string, values: Partial<typeof campaigns.$inferInsert> = {}) {
  const now = new Date();
  await db.insert(campaigns).values({
    id,
    adAccountId,
    name: id,
    syncStatus: 'pending_push',
    createdAt: now,
    updatedAt: now,
    ...values,
  });
}

async function campaign(id: string) {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row!;
}

async function syncIndex(connectionId: string) {
  const [row] = await master
    .select()
    .from(masterSchema.adSyncIndex)
    .where(and(eq(masterSchema.adSyncIndex.workspaceId, WORKSPACE_ID), eq(masterSchema.adSyncIndex.connectionId, connectionId)));
  return row as typeof masterSchema.adSyncIndex.$inferSelect | undefined;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', meta);
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master
    .insert(masterSchema.workspaces)
    .values({ id: WORKSPACE_ID, clerkOrgId: ORG_ID, name: 'Ads', slug: 'ads' } as typeof masterSchema.workspaces.$inferInsert);
}, 180_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/ad-connections/facebook/authorize', () => {
  it('stores a state for the workspace and answers the Facebook dialog URL', async () => {
    const res = await post('/facebook/authorize');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { authorizeUrl: string; state: string } };
    expect(data.state).toMatch(/^[0-9a-f-]{36}$/);
    const url = new URL(data.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.facebook.com/v21.0/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'fb-app',
      redirect_uri: 'https://app.example.test/weldads/connect/callback',
      response_type: 'code',
      state: data.state,
      scope: 'ads_read,business_management,ads_management',
    });
    expect(JSON.parse(kv.store.get(`ads_oauth_state:${data.state}`)!)).toEqual({
      orgId: ORG_ID,
      userId: 'user_test_default',
      platform: 'facebook',
    });
  });

  it('builds the callback on app.weldsuite.org without PUBLIC_APP_URL', async () => {
    const res = await post('/facebook/authorize', undefined, { env: { PUBLIC_APP_URL: undefined } });
    const { data } = (await res.json()) as { data: { authorizeUrl: string } };
    expect(new URL(data.authorizeUrl).searchParams.get('redirect_uri')).toBe(
      'https://app.weldsuite.org/weldads/connect/callback',
    );
  });

  it('answers 500 when Facebook OAuth is not configured', async () => {
    const res = await post('/facebook/authorize', undefined, { env: { FACEBOOK_APP_ID: undefined } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Facebook OAuth is not configured' },
    });
  });

  it('refuses a request without an active workspace', async () => {
    const res = await post('/facebook/authorize', undefined, { orgId: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No active workspace' } });
  });

  it('needs ad_accounts:update', async () => {
    const res = await post('/facebook/authorize', undefined, { grants: ['ad_accounts:read'] });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/ad-connections/facebook/callback', () => {
  let connectionId: string;

  it('connects Facebook: tokens, profile, ad accounts and the sync index', async () => {
    const state = await authorize();
    const from = meta.mock.calls.length;
    const res = await post('/facebook/callback', { code: 'good-code', state });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; platform: string; status: string } };
    expect(data).toMatchObject({ platform: 'facebook', status: 'active' });
    connectionId = data.id;

    expect(graphCallsSince(meta, from)).toEqual(sortCalls([
      `GET ${GRAPH}/me/adaccounts?fields=id%2Cname%2Caccount_status%2Ccurrency%2Ctimezone_name&limit=200&access_token=long-token`,
      `GET ${GRAPH}/me?fields=id%2Cname&access_token=long-token`,
      `GET ${GRAPH}/oauth/access_token?client_id=fb-app&client_secret=fb-secret&redirect_uri=https%3A%2F%2Fapp.example.test%2Fweldads%2Fconnect%2Fcallback&code=good-code`,
      `GET ${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=fb-app&client_secret=fb-secret&fb_exchange_token=short-token`,
    ]));
    expect(kv.store.has(`ads_oauth_state:${state}`)).toBe(false);

    const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(row).toMatchObject({ metaUserId: 'meta_user_1', metaUserName: 'Meta User', status: 'active', lastError: null });
    expect(row!.tokenExpiresAt).toBeInstanceOf(Date);
    expect(row!.oauthTokens?.tokenType).toBe('bearer');
    expect(row!.oauthTokens?.accessToken).toMatch(/^v2:[0-9a-f]+:[0-9a-f]+$/);

    const found = await db.select().from(accounts).where(eq(accounts.connectionId, connectionId));
    expect(found.map((a) => [a.platformAccountId, a.name, a.currency, a.timezone, a.status, a.isSelected]).sort()).toEqual([
      ['act_100', 'Main account', 'EUR', 'Europe/Amsterdam', '1', false],
      ['act_200', 'Second account', 'USD', null, '2', false],
    ]);
    expect(await syncIndex(connectionId)).toMatchObject({ clerkOrgId: ORG_ID, isEnabled: false, nextMetricsSyncAt: null });
  });

  it('reconnects onto the same connection and refreshes the accounts it finds', async () => {
    const state = await authorize();
    const res = await post('/facebook/callback', { code: 'second-code', state });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: connectionId, platform: 'facebook', status: 'active' } });

    const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
    // No `name` in the profile: the name is the id; no `expires_in`: no expiry.
    expect(row).toMatchObject({ metaUserName: 'meta_user_1', tokenExpiresAt: null });
    const found = await db.select().from(accounts).where(eq(accounts.connectionId, connectionId));
    expect(found.map((a) => [a.platformAccountId, a.name, a.currency, a.timezone, a.status]).sort()).toEqual([
      // The currency Meta left out stays as it was.
      ['act_100', 'Main account (renamed)', 'EUR', 'Europe/Brussels', '3'],
      ['act_200', 'Second account', 'USD', null, '2'],
    ]);
  });

  it('answers 400 with Meta’s message when the code is refused, spending the state', async () => {
    const state = await authorize();
    const res = await post('/facebook/callback', { code: 'bad-code', state });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid verification code format.' } });
    expect(kv.store.has(`ads_oauth_state:${state}`)).toBe(false);
  });

  it('answers 400 when Meta hands back no access token', async () => {
    const state = await authorize();
    const res = await post('/facebook/callback', { code: 'no-token-code', state });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No access token in Meta response' } });
  });

  it('refuses an unknown state', async () => {
    const res = await post('/facebook/callback', { code: 'good-code', state: 'no-such-state' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid or expired OAuth state' } });
  });

  it('refuses a state another workspace started, and leaves it in place', async () => {
    await kv.put('ads_oauth_state:other-org', JSON.stringify({ orgId: 'org_other', userId: 'user_x', platform: 'facebook' }));
    const res = await post('/facebook/callback', { code: 'good-code', state: 'other-org' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid or expired OAuth state' } });
    expect(kv.store.has('ads_oauth_state:other-org')).toBe(true);
  });

  it('answers 500 when Facebook OAuth is not configured, after spending the state', async () => {
    const state = await authorize();
    const res = await post('/facebook/callback', { code: 'good-code', state }, { env: { FACEBOOK_APP_SECRET: undefined } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Facebook OAuth is not configured' },
    });
    expect(kv.store.has(`ads_oauth_state:${state}`)).toBe(false);
  });

  it('refuses a request without an active workspace', async () => {
    const res = await post('/facebook/callback', { code: 'good-code', state: 'any' }, { orgId: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No active workspace' } });
  });

  it('validates the body', async () => {
    const res = await post('/facebook/callback', { code: '', state: 7 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { issues: Array<{ path: string[] }> } };
    expect(body.success).toBe(false);
    expect(body.error.issues.map((issue) => issue.path[0])).toEqual(['code', 'state']);
  });

  it('needs ad_accounts:update', async () => {
    const res = await post('/facebook/callback', { code: 'good-code', state: 'x' }, { grants: ['ad_accounts:read'] });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/ad-connections', () => {
  it('lists the live connections newest first, without their tokens', async () => {
    await seedConnection('adcn_list_old', {
      createdAt: new Date('2026-01-01T00:00:00Z'),
      metaUserName: 'Old',
      oauthTokens: { accessToken: 'secret' },
    });
    await seedConnection('adcn_list_gone', { deletedAt: new Date(), createdAt: new Date('2026-02-01T00:00:00Z') });
    const res = await app().request(BASE);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    const ids = data.map((row) => row.id);
    expect(ids).toContain('adcn_list_old');
    expect(ids).not.toContain('adcn_list_gone');
    expect(ids.at(-1)).toBe('adcn_list_old');
    for (const row of data) expect(row).not.toHaveProperty('oauthTokens');
  });

  it('needs ad_accounts:read', async () => {
    const res = await app({ grants: ['ad_campaigns:read'] }).request(BASE);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/ad-connections/:id/sync', () => {
  const main = 'adac_sync_main';
  const other = 'adac_sync_other';

  beforeAll(async () => {
    const accessToken = await encryptField('sync-token', KEYRING);
    await seedConnection('adcn_sync', { oauthTokens: { accessToken, tokenType: 'bearer' } });
    await seedAccount(main, 'adcn_sync', { platformAccountId: 'act_100', currency: 'EUR' });
    await seedAccount(other, 'adcn_sync', { platformAccountId: '200' });
    await seedAccount('adac_sync_off', 'adcn_sync', { platformAccountId: 'act_300', isSelected: false });
    await master.insert(masterSchema.adSyncIndex).values({
      id: 'adsx_sync',
      workspaceId: WORKSPACE_ID,
      connectionId: 'adcn_sync',
      clerkOrgId: ORG_ID,
      isEnabled: true,
      nextMetricsSyncAt: new Date('2026-01-01T00:00:00Z'),
    });

    // Pending pushes: a new campaign, an update, and five Meta (or the sync) refuses.
    await seedCampaign('adcp_s_new', main, { name: 'New launch', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', dailyBudget: 1500 });
    await seedCampaign('adcp_s_existing', main, {
      platformCampaignId: 'cmp_existing',
      name: 'Existing',
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
      lifetimeBudget: 90000,
    });
    await seedCampaign('adcp_s_noobj', main, { name: 'No objective', dailyBudget: 100 });
    await seedCampaign('adcp_s_nobudget', main, { name: 'No budget', objective: 'OUTCOME_LEADS' });
    await seedCampaign('adcp_s_zero', main, { name: 'Zero', objective: 'OUTCOME_LEADS', dailyBudget: 0 });
    await seedCampaign('adcp_s_refused', main, { platformCampaignId: 'cmp_refused', name: 'Edit me', objective: 'OUTCOME_LEADS' });
    await seedCampaign('adcp_s_refused_new', main, { name: 'Refused', objective: 'OUTCOME_LEADS', lifetimeBudget: 500 });
    // An unselected account's campaign is left alone.
    await seedCampaign('adcp_s_off', 'adac_sync_off', { name: 'Off', objective: 'OUTCOME_LEADS', dailyBudget: 100 });

    // Synced campaigns: stale, unchanged, gone from Meta, and one on the other account.
    await seedCampaign('adcp_s_synced', main, { platformCampaignId: 'cmp_synced', syncStatus: 'synced', contentHash: 'stale' });
    await seedCampaign('adcp_s_unchanged', main, {
      platformCampaignId: 'cmp_unchanged',
      name: 'Unchanged',
      syncStatus: 'synced',
      contentHash: hashCampaignPayload({ name: 'Unchanged', status: 'PAUSED' }),
    });
    await seedCampaign('adcp_s_gone', main, { platformCampaignId: 'cmp_gone', syncStatus: 'synced', contentHash: 'stale' });
    await seedCampaign('adcp_s_other', other, { platformCampaignId: 'cmp_other_account', syncStatus: 'synced' });
  });

  const sync = (query = '', options: AppOptions = {}) => post(`/adcn_sync/sync${query}`, undefined, options);

  it('pushes the pending campaigns to Meta and records what fails', async () => {
    const from = meta.mock.calls.length;
    const res = await sync('?scope=push');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { syncedCampaigns: 2, writtenCampaigns: 2, pushed: 2, failed: 5, pulled: 0 },
    });

    const calls = graphCallsSince(meta, from);
    expect(calls).toContain(`POST ${GRAPH}/act_100/campaigns`);
    expect(calls).toContain(`POST ${GRAPH}/cmp_existing`);
    expect(calls).toContain(`GET ${GRAPH}/cmp_new_launch?fields=id%2Cname%2Cstatus%2Cobjective%2Cdaily_budget%2Clifetime_budget&access_token=sync-token`);

    expect(await campaign('adcp_s_new')).toMatchObject({
      platformCampaignId: 'cmp_new_launch',
      syncStatus: 'synced',
      dailyBudget: 1500,
      currency: 'EUR',
      metrics: { spend: '0', impressions: '0', dateStart: '2026-10-01', dateEnd: '2026-10-30' },
      contentHash: hashCampaignPayload({
        name: 'New launch',
        status: 'PAUSED',
        objective: 'OUTCOME_TRAFFIC',
        dailyBudget: 1500,
        metrics: { spend: '0', impressions: '0', dateStart: '2026-10-01', dateEnd: '2026-10-30' },
      }),
    });
    expect(await campaign('adcp_s_existing')).toMatchObject({ name: 'Existing renamed', syncStatus: 'synced', lifetimeBudget: 90000 });
    expect(await campaign('adcp_s_noobj')).toMatchObject({
      syncStatus: 'error',
      syncError: 'Campaign objective is required before syncing',
    });
    expect(await campaign('adcp_s_nobudget')).toMatchObject({
      syncStatus: 'error',
      syncError: 'Campaign budget is required before syncing',
    });
    expect(await campaign('adcp_s_zero')).toMatchObject({
      syncStatus: 'error',
      syncError: 'A daily or lifetime budget is required to create a campaign',
    });
    expect(await campaign('adcp_s_refused')).toMatchObject({ syncStatus: 'error', syncError: 'Campaign cannot be edited' });
    expect(await campaign('adcp_s_refused_new')).toMatchObject({ syncStatus: 'error', syncError: 'Invalid parameter' });
    expect(await campaign('adcp_s_off')).toMatchObject({ syncStatus: 'pending_push' });

    const [row] = await db.select().from(connections).where(eq(connections.id, 'adcn_sync'));
    expect(row!.lastSyncAt).toBeInstanceOf(Date);
    // A push alone leaves the metrics schedule as it was.
    expect((await syncIndex('adcn_sync'))!.nextMetricsSyncAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('pulls the synced campaigns whose content changed', async () => {
    const res = await sync();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { syncedCampaigns: 2, writtenCampaigns: 2, pushed: 0, failed: 0, pulled: 2 },
    });
    expect(await campaign('adcp_s_synced')).toMatchObject({
      name: 'Synced remote',
      status: 'ACTIVE',
      objective: 'OUTCOME_LEADS',
      dailyBudget: 2500,
      metrics: { spend: '99.5', clicks: '12' },
    });
    // The other account has no currency of its own: the campaign keeps none.
    expect(await campaign('adcp_s_other')).toMatchObject({ name: 'Other account', dailyBudget: 700, currency: null });
    expect(await campaign('adcp_s_gone')).toMatchObject({ contentHash: 'stale' });
    const index = await syncIndex('adcn_sync');
    expect(index!.nextMetricsSyncAt!.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
  });

  it('narrows a pull to one account and campaign', async () => {
    await db.update(campaigns).set({ contentHash: 'stale-again' }).where(eq(campaigns.id, 'adcp_s_other'));
    await db.update(campaigns).set({ contentHash: 'stale-again' }).where(eq(campaigns.id, 'adcp_s_synced'));
    const from = meta.mock.calls.length;
    const res = await sync('?scope=metrics&platformAccountId=200&platformCampaignId=cmp_other_account');
    expect(await res.json()).toEqual({
      data: { syncedCampaigns: 1, writtenCampaigns: 1, pushed: 0, failed: 0, pulled: 1 },
    });
    expect(graphCallsSince(meta, from)).toEqual(sortCalls([
      `GET ${GRAPH}/act_200/insights?level=campaign&fields=campaign_id%2Cspend%2Cimpressions%2Cclicks%2Cctr%2Ccpc%2Creach%2Cdate_start%2Cdate_stop&date_preset=last_30d&filtering=%5B%7B%22field%22%3A%22campaign.id%22%2C%22operator%22%3A%22EQUAL%22%2C%22value%22%3A%22cmp_other_account%22%7D%5D&limit=1&access_token=sync-token`,
      `GET ${GRAPH}/cmp_other_account?fields=id%2Cname%2Cstatus%2Cobjective%2Cdaily_budget%2Clifetime_budget&access_token=sync-token`,
    ]));
    expect(await campaign('adcp_s_synced')).toMatchObject({ contentHash: 'stale-again' });
  });

  it('syncs without a workspace too', async () => {
    const res = await sync('?scope=pull', { orgId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { syncedCampaigns: 1, writtenCampaigns: 1, pushed: 0, failed: 0, pulled: 1 },
    });
  });

  it('marks the connection failed when the sync breaks', async () => {
    const accessToken = await encryptField('sync-token', KEYRING);
    await seedConnection('adcn_sync_fail', { oauthTokens: { accessToken } });
    await seedAccount('adac_sync_fail', 'adcn_sync_fail', { platformAccountId: 'act_900' });
    // Meta reports a fractional budget, which the integer column refuses.
    await seedCampaign('adcp_s_fraction', 'adac_sync_fail', { platformCampaignId: 'cmp_fraction', syncStatus: 'synced' });
    const res = await post('/adcn_sync_fail/sync');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to sync ad connection' } });
    const [row] = await db.select().from(connections).where(eq(connections.id, 'adcn_sync_fail'));
    expect(row!.status).toBe('error');
    expect(row!.lastError).toBeTruthy();
  });

  it('refuses a connection without a token', async () => {
    await seedConnection('adcn_sync_notoken');
    const res = await post('/adcn_sync_notoken/sync');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Connection has no valid access token' } });
  });

  it('answers 404 for an unknown or disconnected connection', async () => {
    for (const id of ['adcn_missing', 'adcn_list_gone']) {
      const res = await post(`/${id}/sync`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'NOT_FOUND', message: `Ad connection with ID '${id}' not found` },
      });
    }
  });

  it('needs ad_accounts:update', async () => {
    const res = await sync('', { grants: ['ad_accounts:read'] });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/ad-connections/:id', () => {
  const remove = (id: string, options: AppOptions = {}) => app(options).request(`${BASE}/${id}`, { method: 'DELETE' });

  it('disconnects: accounts, campaigns and the sync index go with it', async () => {
    await seedConnection('adcn_delete');
    await seedAccount('adac_delete', 'adcn_delete');
    await seedCampaign('adcp_delete', 'adac_delete');
    await master.insert(masterSchema.adSyncIndex).values({
      id: 'adsx_delete',
      workspaceId: WORKSPACE_ID,
      connectionId: 'adcn_delete',
      clerkOrgId: ORG_ID,
    });

    const res = await remove('adcn_delete');
    expect(res.status).toBe(204);
    const [row] = await db.select().from(connections).where(eq(connections.id, 'adcn_delete'));
    expect(row).toMatchObject({ status: 'error' });
    expect(row!.deletedAt).toBeInstanceOf(Date);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, 'adac_delete'));
    expect(account).toMatchObject({ isSelected: false });
    expect(account!.deletedAt).toBeInstanceOf(Date);
    expect((await campaign('adcp_delete')).deletedAt).toBeInstanceOf(Date);
    expect(await syncIndex('adcn_delete')).toBeUndefined();

    const again = await remove('adcn_delete');
    expect(again.status).toBe(404);
  });

  it('keeps the sync index without an active workspace', async () => {
    await seedConnection('adcn_delete_noorg');
    await master.insert(masterSchema.adSyncIndex).values({
      id: 'adsx_delete_noorg',
      workspaceId: WORKSPACE_ID,
      connectionId: 'adcn_delete_noorg',
      clerkOrgId: ORG_ID,
    });
    const res = await remove('adcn_delete_noorg', { orgId: null });
    expect(res.status).toBe(204);
    expect(await syncIndex('adcn_delete_noorg')).toBeDefined();
  });

  it('answers 404 for an unknown connection', async () => {
    const res = await remove('adcn_nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Ad connection with ID 'adcn_nope' not found" } });
  });

  it('needs ad_accounts:update', async () => {
    const res = await remove('adcn_sync', { grants: ['ad_accounts:read'] });
    expect(res.status).toBe(403);
  });
});
