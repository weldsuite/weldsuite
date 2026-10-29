/**
 * /api/user-apps management routes against real master and tenant databases
 * (pglite): the owner's app CRUD, the store, installs and consent, versions
 * and review, OAuth clients and session tokens. Conformance-ready
 * (rust/conformance/suites.json): the shared KV, the bundle bucket and the
 * lifecycle webhook calls are compared between the backends.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { FakeBucket, JSON_HEADERS, sharedKv, type FakeKv } from '../../test/user-apps-fixtures';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));

import { userAppsRoutes } from './index';

const {
  userApps,
  userAppVersions,
  userAppInstalls,
  userAppTokens,
  userAppOauthClients,
  userAppDevSessions,
  appDeveloperAccounts,
  adminUsers,
} = masterSchema;
const { workspaceInstalledApps } = tenantSchema;

const OWNER = 'ws_owner';
const OTHER = 'ws_other';
const WEBHOOK = 'https://hooks.example.com/weld';
const SECRET = 'internal-secret-for-tests';

const EVERYTHING = permissions('weldapps:read', 'weldapps:develop', 'weldapps:publish', 'weldapps:manage');

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let master: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let tenant: any;
let kv: FakeKv;
let storage: FakeBucket;
let privateStorage: FakeBucket;

/** The real `fetch`: the conformance harness talks to the Rust server with it. */
const realFetch = globalThis.fetch.bind(globalThis);
let webhookCalls: Array<{ url: string; body: unknown }> = [];

/** Where the app gateway forwards to (`EXTERNAL_API_URL`), answered by `externalApi`. */
const EXTERNAL_API = 'https://ext-api.example.test';
/** A cached gateway token external-api no longer accepts. */
const STALE_TOKEN = `wsat_${'0'.repeat(40)}`;

interface UpstreamCall {
  method: string;
  url: string;
  authorization: string | null;
  headers: Record<string, string>;
  body: string;
}
let upstreamCalls: UpstreamCall[] = [];

/** external-api, as the gateway sees it: by method and path, never by call order. */
async function externalApi(request: Request): Promise<Response> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const call: UpstreamCall = {
    method: request.method,
    url: request.url,
    authorization: request.headers.get('authorization'),
    headers,
    body: await request.text(),
  };
  upstreamCalls.push(call);
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
  if (call.authorization === `Bearer ${STALE_TOKEN}`) {
    return json(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
  }
  const path = new URL(call.url).pathname;
  if (request.method === 'GET' && path === '/v1/contacts') {
    return json(200, { data: [{ id: 'con_1' }] }, { 'x-ratelimit-remaining': '99', 'x-upstream-secret': 'internal' });
  }
  if (request.method === 'POST' && path === '/v1/contacts') {
    return json(201, { data: JSON.parse(call.body) as unknown });
  }
  if (request.method === 'DELETE' && path === '/v1/contacts/con_1') return new Response(null, { status: 204 });
  return json(404, { error: { code: 'NOT_FOUND', message: `${path} not found` } });
}

interface Caller {
  workspaceId?: string;
  userId?: string;
  perms?: ReturnType<typeof permissions>;
  env?: Record<string, unknown>;
}

function api({ workspaceId = OWNER, userId = 'user_dev', perms = EVERYTHING, env = {} }: Caller = {}) {
  return createTestApp('/api/user-apps', userAppsRoutes, {
    context: { workspaceId, userId, orgId: 'org_owner', permissions: perms, tenantDb, masterDb: master },
    env: {
      WORKSPACE_CACHE: kv as unknown as KVNamespace,
      STORAGE: storage as unknown as R2Bucket,
      PRIVATE_STORAGE: privateStorage as unknown as R2Bucket,
      INTERNAL_API_SECRET: SECRET,
      ...env,
    } as never,
  }).request;
}

const send = (method: string, path: string, body: unknown, caller?: Caller) =>
  api(caller)(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute));

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  tenant = tenantDb;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
}, 180_000);

async function seed(): Promise<void> {
  await master.delete(userAppTokens);
  await master.delete(userAppDevSessions);
  await master.delete(userAppInstalls);
  await master.delete(userAppOauthClients);
  await master.delete(userAppVersions);
  await master.delete(userApps);
  await master.delete(appDeveloperAccounts);
  await master.delete(adminUsers);
  await tenant.delete(workspaceInstalledApps);

  await master.insert(userApps).values([
    {
      id: 'uapp_mine',
      code: 'mineapp',
      name: 'Mine',
      description: 'My own app',
      ownerWorkspaceId: OWNER,
      createdBy: 'user_dev',
      requestedScopes: ['crm:read'],
      webhookUrl: WEBHOOK,
      createdAt: at(3),
      updatedAt: at(3),
    },
    {
      id: 'uapp_mine_old',
      code: 'oldapp',
      name: 'Old',
      ownerWorkspaceId: OWNER,
      createdBy: 'user_dev',
      createdAt: at(1),
      updatedAt: at(1),
    },
    {
      id: 'uapp_pub',
      code: 'pubapp',
      name: 'Public',
      ownerWorkspaceId: OTHER,
      createdBy: 'user_other',
      visibility: 'public',
      reviewStatus: 'approved',
      currentVersionId: 'uav_pub_1',
      requestedScopes: ['crm:read'],
      webhookUrl: WEBHOOK,
      stripeProductId: 'prod_x',
      createdAt: at(2),
      updatedAt: at(2),
    },
    {
      id: 'uapp_paid',
      code: 'paidapp',
      name: 'Paid',
      ownerWorkspaceId: OTHER,
      createdBy: 'user_other',
      visibility: 'public',
      reviewStatus: 'approved',
      pricingType: 'subscription',
      priceMonthly: '9.99',
      createdAt: at(0),
      updatedAt: at(0),
    },
    {
      id: 'uapp_hidden',
      code: 'hiddenapp',
      name: 'Hidden',
      ownerWorkspaceId: OTHER,
      createdBy: 'user_other',
      createdAt: at(4),
      updatedAt: at(4),
    },
  ]);
  await master.insert(userAppVersions).values({
    id: 'uav_pub_1',
    appId: 'uapp_pub',
    version: '1.0.0',
    bundleKey: 'user-apps/uapp_pub/uav_pub_1',
    createdBy: 'user_other',
    status: 'published',
    manifest: { code: 'pubapp', name: 'Public', version: '1.0.0', scopes: ['crm:read'] },
    createdAt: at(2),
  });
}

beforeEach(async () => {
  await seed();
  kv = sharedKv();
  storage = new FakeBucket();
  privateStorage = new FakeBucket();
  webhookCalls = [];
  upstreamCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(WEBHOOK)) {
        webhookCalls.push({ url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null });
        return new Response(null, { status: 204 });
      }
      if (url.startsWith(EXTERNAL_API)) return externalApi(new Request(input, init));
      return realFetch(input, init);
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const appRow = async (id: string) =>
  (await master.select().from(userApps).where(eq(userApps.id, id)))[0] as typeof userApps.$inferSelect;

async function installFor(appId: string, workspaceId: string, extra: Partial<typeof userAppInstalls.$inferInsert> = {}) {
  await master.insert(userAppInstalls).values({
    id: `uai_${appId.slice(5)}_${workspaceId.slice(3)}`,
    appId,
    workspaceId,
    status: 'active',
    grantedScopes: ['crm:read'],
    installedBy: 'user_dev',
    ...extra,
  });
}

// ── list, create, read, update, delete ──────────────────────────────────────

describe('GET /api/user-apps', () => {
  it("lists the workspace's own apps, newest first, with a cursor", async () => {
    const res = await api()('/api/user-apps?limit=1');
    expect(res.status).toBe(200);
    const page = (await res.json()) as { data: Array<{ id: string }>; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(page.data.map((a) => a.id)).toEqual(['uapp_mine']);
    expect(page.pagination).toEqual({ totalCount: 2, hasMore: true, cursor: 'uapp_mine' });

    const next = await api()('/api/user-apps?limit=1&cursor=uapp_mine');
    const second = (await next.json()) as { data: Array<{ id: string }>; pagination: { hasMore: boolean } };
    expect(second.data.map((a) => a.id)).toEqual(['uapp_mine_old']);
    expect(second.pagination.hasMore).toBe(false);
  });

  it("ignores a cursor that points at another workspace's app, and a bad limit", async () => {
    const res = await api()('/api/user-apps?limit=nope&cursor=uapp_hidden');
    const page = (await res.json()) as { data: Array<{ id: string }> };
    expect(page.data.map((a) => a.id)).toEqual(['uapp_mine', 'uapp_mine_old']);
  });

  it('needs weldapps:read', async () => {
    expect((await api({ perms: permissions('crm:read') })('/api/user-apps')).status).toBe(403);
  });
});

describe('POST /api/user-apps', () => {
  it('creates a community app shell for the workspace', async () => {
    const res = await send('POST', '/api/user-apps', {
      code: 'newapp',
      name: 'New app',
      category: 'Sales',
      websiteUrl: 'https://example.com',
      screenshots: ['https://example.com/1.png'],
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      code: 'newapp',
      name: 'New app',
      description: null,
      icon: 'Puzzle',
      category: 'Sales',
      ownerWorkspaceId: OWNER,
      createdBy: 'user_dev',
      publisherType: 'community',
      visibility: 'private',
      reviewStatus: 'draft',
      screenshots: ['https://example.com/1.png'],
    });
  });

  it('marks apps of an official publisher workspace as weldsuite', async () => {
    const res = await send(
      'POST',
      '/api/user-apps',
      { code: 'weldcrm', name: 'Official CRM' },
      { env: { WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS: ` ws_x , ${OWNER}` } },
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { publisherType: string } }).data.publisherType).toBe('weldsuite');
  });

  it('refuses a reserved code and one that is taken', async () => {
    const reserved = await send('POST', '/api/user-apps', { code: 'weldcrm', name: 'Fake CRM' });
    expect(reserved.status).toBe(409);
    expect(await reserved.json()).toEqual({ error: { code: 'CONFLICT', message: "App code 'weldcrm' is reserved" } });
    const taken = await send('POST', '/api/user-apps', { code: 'pubapp', name: 'Copy' });
    expect(taken.status).toBe(409);
  });

  it('validates the body, refinements last', async () => {
    const res = await send('POST', '/api/user-apps', {
      code: 'X',
      name: '',
      icon: 'a'.repeat(60),
      websiteUrl: 'not a url',
      webhookUrl: 'http://localhost/hook',
      screenshots: 'nope',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: Array<{ path: string[]; code: string }> } };
    expect(body.error.issues.map((i) => `${i.path.join('.')}:${i.code}`)).toEqual([
      'code:too_small',
      'code:invalid_string',
      'name:too_small',
      'websiteUrl:invalid_string',
      'screenshots:invalid_type',
      'icon:custom',
      'webhookUrl:custom',
    ]);
  });

  it('needs weldapps:develop', async () => {
    const res = await send('POST', '/api/user-apps', { code: 'newapp', name: 'New' }, { perms: permissions('weldapps:read') });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/user-apps/:id', () => {
  it('returns an own app and hides everyone else’s', async () => {
    const own = await api()('/api/user-apps/uapp_mine');
    expect(own.status).toBe(200);
    expect(((await own.json()) as { data: { code: string } }).data.code).toBe('mineapp');
    const foreign = await api()('/api/user-apps/uapp_pub');
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: { code: 'NOT_FOUND', message: "App with ID 'uapp_pub' not found" } });
  });
});

describe('PATCH /api/user-apps/:id', () => {
  it('updates the given fields, clears nullable ones, and drops the asset cache on isActive', async () => {
    kv.store.set('uapp-assets:v2:mineapp', JSON.stringify({ appId: 'uapp_mine', bundleKey: 'x', entrypoint: 'index.html' }));
    const res = await send('PATCH', '/api/user-apps/uapp_mine', {
      name: 'Renamed',
      isActive: false,
      webhookUrl: null,
      screenshots: [],
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ name: 'Renamed', isActive: false, webhookUrl: null, screenshots: [], description: 'My own app' });
    expect(kv.store.has('uapp-assets:v2:mineapp')).toBe(false);
  });

  it('validates, and refuses foreign apps', async () => {
    expect((await send('PATCH', '/api/user-apps/uapp_mine', { isActive: 'yes', websiteUrl: 'x' })).status).toBe(400);
    expect((await send('PATCH', '/api/user-apps/uapp_pub', { name: 'Mine now' })).status).toBe(404);
  });
});

describe('DELETE /api/user-apps/:id', () => {
  it('refuses while another workspace has it installed', async () => {
    await installFor('uapp_mine', OTHER);
    const res = await api()('/api/user-apps/uapp_mine', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'App is still installed in other workspaces' } });
  });

  it('soft-deletes, revokes installs and tokens, and removes the tenant row', async () => {
    await installFor('uapp_mine', OWNER);
    await master.insert(userAppTokens).values({
      id: 'uat_mine',
      installId: 'uai_mine_owner',
      appId: 'uapp_mine',
      workspaceId: OWNER,
      tokenHash: 'hash_mine',
      tokenPrefix: 'wsat_1234567',
    });
    await tenant.insert(workspaceInstalledApps).values({ id: 'wsapp_mine', appCode: 'mineapp', appType: 'user', userAppId: 'uapp_mine' });

    const res = await api()('/api/user-apps/uapp_mine', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const row = await appRow('uapp_mine');
    expect(row.deletedAt).not.toBeNull();
    expect(row.isActive).toBe(false);
    const [install] = await master.select().from(userAppInstalls).where(eq(userAppInstalls.id, 'uai_mine_owner'));
    expect(install.status).toBe('revoked');
    const [token] = await master.select().from(userAppTokens).where(eq(userAppTokens.id, 'uat_mine'));
    expect(token.revokedAt).not.toBeNull();
    const [tenantRow] = await tenant.select().from(workspaceInstalledApps).where(eq(workspaceInstalledApps.id, 'wsapp_mine'));
    expect(tenantRow.deletedAt).not.toBeNull();
    expect((await api()('/api/user-apps/uapp_mine', { method: 'DELETE' })).status).toBe(404);
  });
});

// ── the store and installs ──────────────────────────────────────────────────

describe('GET /api/user-apps/store', () => {
  it('lists public approved apps and own ones, with install state and without webhook or Stripe ids', async () => {
    await installFor('uapp_pub', OWNER, { pendingScopes: ['crm:write'] });
    await tenant.insert(workspaceInstalledApps).values({ id: 'wsapp_pub', appCode: 'pubapp', appType: 'user', userAppId: 'uapp_pub' });

    const res = await api()('/api/user-apps/store');
    expect(res.status).toBe(200);
    const { data, pagination } = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      pagination: { totalCount: number };
    };
    expect(data.map((a) => a.id)).toEqual(['uapp_mine', 'uapp_pub', 'uapp_mine_old', 'uapp_paid']);
    expect(pagination.totalCount).toBe(4);
    const pub = data.find((a) => a.id === 'uapp_pub')!;
    expect(pub).toMatchObject({ isInstalled: true, pendingScopes: ['crm:write'] });
    expect(pub).not.toHaveProperty('webhookUrl');
    expect(pub).not.toHaveProperty('stripeProductId');
    expect(data.find((a) => a.id === 'uapp_paid')).toMatchObject({ isInstalled: false, pendingScopes: null, priceMonthly: '9.99' });
  });

  it('adopts a first-party install when an official hosted app now owns its code', async () => {
    await master.insert(userApps).values({
      id: 'uapp_official',
      code: 'officialapp',
      name: 'Official',
      ownerWorkspaceId: OTHER,
      createdBy: 'user_other',
      publisherType: 'weldsuite',
      visibility: 'public',
      reviewStatus: 'approved',
      requestedScopes: ['crm:read'],
      createdAt: at(5),
    });
    await tenant.insert(workspaceInstalledApps).values({ id: 'wsapp_sys', appCode: 'officialapp', appType: 'system' });

    const res = await api()('/api/user-apps/installed');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ appCode: string; appType: string; app: { id: string } }> };
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ appCode: 'officialapp', appType: 'user', app: { id: 'uapp_official' } });
    const [install] = await master.select().from(userAppInstalls).where(eq(userAppInstalls.appId, 'uapp_official'));
    expect(install).toMatchObject({ workspaceId: OWNER, status: 'active', installedBy: 'user_dev' });
    expect((await appRow('uapp_official')).installCount).toBe(1);
  });
});

describe('GET /api/user-apps/store/:code', () => {
  it('shows a visible app and hides a private foreign one', async () => {
    const res = await api()('/api/user-apps/store/pubapp');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { isInstalled: boolean } }).data.isInstalled).toBe(false);
    const hidden = await api()('/api/user-apps/store/hiddenapp');
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: { code: 'NOT_FOUND', message: "App with ID 'hiddenapp' not found" } });
  });
});

describe('GET /api/user-apps/installed', () => {
  it('lists active tenant installs of live apps with their sidenav fields', async () => {
    await tenant.insert(workspaceInstalledApps).values([
      { id: 'wsapp_pub', appCode: 'pubapp', appType: 'user', userAppId: 'uapp_pub', grantedScopes: ['crm:read'], displayOrder: 2 },
      { id: 'wsapp_hidden', appCode: 'hiddenapp', appType: 'user', userAppId: 'uapp_hidden', isActive: false },
      { id: 'wsapp_crm', appCode: 'weldcrm', appType: 'system' },
    ]);
    await master.update(userApps).set({ isActive: false }).where(eq(userApps.id, 'uapp_hidden'));

    const res = await api()('/api/user-apps/installed');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: 'wsapp_pub',
      appCode: 'pubapp',
      grantedScopes: ['crm:read'],
      app: { id: 'uapp_pub', code: 'pubapp', name: 'Public', currentVersionId: 'uav_pub_1', publisherType: 'community' },
    });
  });
});

describe('GET /api/user-apps/developer-account', () => {
  it('is null until the workspace has a payout account', async () => {
    expect(await (await api()('/api/user-apps/developer-account')).json()).toEqual({ data: null });
    await master.insert(appDeveloperAccounts).values({ id: 'adev_1', workspaceId: OWNER, stripeConnectAccountId: 'acct_1' });
    const res = await api()('/api/user-apps/developer-account');
    expect(((await res.json()) as { data: { stripeConnectAccountId: string } }).data.stripeConnectAccountId).toBe('acct_1');
  });

  it('needs weldapps:develop', async () => {
    expect((await api({ perms: permissions('weldapps:read') })('/api/user-apps/developer-account')).status).toBe(403);
  });
});

describe('POST /api/user-apps/:id/install', () => {
  it('installs into the workspace: grant, token, tenant row, count, event and webhook', async () => {
    const res = await send('POST', '/api/user-apps/uapp_pub/install', { grantedScopes: ['crm:*'] });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { install: Record<string, unknown>; token: string } };
    expect(data.install).toMatchObject({ appId: 'uapp_pub', workspaceId: OWNER, status: 'active', grantedScopes: ['crm:*'] });
    expect(data.token).toMatch(/^wsat_[0-9a-f]{40}$/);

    const [tenantRow] = await tenant.select().from(workspaceInstalledApps).where(eq(workspaceInstalledApps.appCode, 'pubapp'));
    expect(tenantRow).toMatchObject({ appType: 'user', userAppId: 'uapp_pub', isActive: true, grantedScopes: ['crm:*'] });
    const tokens = await master.select().from(userAppTokens).where(eq(userAppTokens.appId, 'uapp_pub'));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ tokenType: 'install', expiresAt: null, tokenPrefix: data.token.slice(0, 12) });
    expect((await appRow('uapp_pub')).installCount).toBe(1);
    expect(webhookCalls.at(-1)).toMatchObject({ url: WEBHOOK, body: { event: 'app.installed', appId: 'uapp_pub', workspaceId: OWNER } });
  });

  it('revives a revoked install and takes over an existing tenant row', async () => {
    await installFor('uapp_pub', OWNER, { status: 'revoked', revokedAt: at(9) });
    await tenant.insert(workspaceInstalledApps).values({ id: 'wsapp_pub', appCode: 'pubapp', appType: 'user', isActive: false, deletedAt: at(9) });
    const res = await send('POST', '/api/user-apps/uapp_pub/install', {});
    expect(res.status).toBe(409);
    const ok = await send('POST', '/api/user-apps/uapp_pub/install', { grantedScopes: ['crm:read', 'crm:write'] });
    expect(ok.status).toBe(201);
    const { data } = (await ok.json()) as { data: { install: { id: string; revokedAt: string | null } } };
    expect(data.install).toMatchObject({ id: 'uai_pub_owner', revokedAt: null });
    const [tenantRow] = await tenant.select().from(workspaceInstalledApps).where(eq(workspaceInstalledApps.id, 'wsapp_pub'));
    expect(tenantRow).toMatchObject({ isActive: true, deletedAt: null, userAppId: 'uapp_pub' });
    expect((await appRow('uapp_pub')).installCount).toBe(1);
  });

  it('requires an active subscription for a foreign paid app', async () => {
    const res = await send('POST', '/api/user-apps/uapp_paid/install', {});
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: {
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'This app requires an active subscription',
        details: { appId: 'uapp_paid', priceMonthly: '9.99', currency: 'EUR' },
      },
    });
    await installFor('uapp_paid', OWNER, { status: 'revoked', subscriptionStatus: 'trialing', grantedScopes: [] });
    expect((await send('POST', '/api/user-apps/uapp_paid/install', {})).status).toBe(201);
  });

  it('hides private foreign apps, validates scopes and needs weldapps:manage', async () => {
    expect((await send('POST', '/api/user-apps/uapp_hidden/install', {})).status).toBe(404);
    expect((await send('POST', '/api/user-apps/uapp_pub/install', { grantedScopes: ['Not A Scope'] })).status).toBe(400);
    expect((await send('POST', '/api/user-apps/uapp_pub/install', {}, { perms: permissions('weldapps:read') })).status).toBe(403);
  });
});

describe('DELETE /api/user-apps/:id/install', () => {
  it('revokes the grant and its tokens, deactivates the tenant row, and tells the app', async () => {
    await installFor('uapp_pub', OWNER);
    await master.update(userApps).set({ installCount: 1 }).where(eq(userApps.id, 'uapp_pub'));
    await master.insert(userAppTokens).values({
      id: 'uat_pub',
      installId: 'uai_pub_owner',
      appId: 'uapp_pub',
      workspaceId: OWNER,
      tokenHash: 'hash_pub',
      tokenPrefix: 'wsat_1234567',
    });
    await tenant.insert(workspaceInstalledApps).values({ id: 'wsapp_pub', appCode: 'pubapp', appType: 'user', userAppId: 'uapp_pub' });
    kv.store.set(`uapp-access:v1:uapp_pub:${OWNER}`, '1');

    const res = await api()('/api/user-apps/uapp_pub/install', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [install] = await master.select().from(userAppInstalls).where(eq(userAppInstalls.id, 'uai_pub_owner'));
    expect(install.status).toBe('revoked');
    const [token] = await master.select().from(userAppTokens).where(eq(userAppTokens.id, 'uat_pub'));
    expect(token.revokedAt).not.toBeNull();
    expect((await appRow('uapp_pub')).installCount).toBe(0);
    expect(kv.store.has(`uapp-access:v1:uapp_pub:${OWNER}`)).toBe(false);
    expect(webhookCalls.at(-1)).toMatchObject({ body: { event: 'app.uninstalled', appCode: 'pubapp' } });

    expect((await api()('/api/user-apps/uapp_pub/install', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /api/user-apps/:id/consent', () => {
  it('grants approved pending scopes and keeps the rest pending', async () => {
    await installFor('uapp_pub', OWNER, { pendingScopes: ['crm:write', 'tickets:read'] });
    await master.insert(userAppTokens).values({
      id: 'uat_pub',
      installId: 'uai_pub_owner',
      appId: 'uapp_pub',
      workspaceId: OWNER,
      tokenHash: 'hash_pub',
      tokenPrefix: 'wsat_1234567',
      scopes: ['crm:read'],
    });
    await tenant.insert(workspaceInstalledApps).values({ id: 'wsapp_pub', appCode: 'pubapp', appType: 'user', userAppId: 'uapp_pub' });

    const res = await send('POST', '/api/user-apps/uapp_pub/consent', { approvedScopes: ['crm:write'] });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { grantedScopes: string[]; pendingScopes: string[] | null } };
    expect(data).toMatchObject({ grantedScopes: ['crm:read', 'crm:write'], pendingScopes: ['tickets:read'] });
    const [token] = await master.select().from(userAppTokens).where(eq(userAppTokens.id, 'uat_pub'));
    expect(token.scopes).toEqual(['crm:read', 'crm:write']);

    const last = await send('POST', '/api/user-apps/uapp_pub/consent', { approvedScopes: ['tickets:read'] });
    expect(((await last.json()) as { data: { pendingScopes: unknown } }).data.pendingScopes).toBeNull();
  });

  it('refuses scopes that are not pending, and apps that are not installed', async () => {
    await installFor('uapp_pub', OWNER, { pendingScopes: ['crm:write'] });
    const res = await send('POST', '/api/user-apps/uapp_pub/consent', { approvedScopes: ['crm:delete'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'approvedScopes must be a subset of the pending scopes' },
    });
    expect((await send('POST', '/api/user-apps/uapp_paid/consent', { approvedScopes: [] })).status).toBe(404);
    expect((await send('POST', '/api/user-apps/uapp_pub/consent', {})).status).toBe(400);
  });
});

describe('POST /api/user-apps/code/:code/session-token', () => {
  it('mints a one-hour session token for an installed app', async () => {
    await installFor('uapp_pub', OWNER);
    await tenant.insert(workspaceInstalledApps).values({ id: 'wsapp_pub', appCode: 'pubapp', appType: 'user', userAppId: 'uapp_pub' });
    const res = await api({ env: { EXTERNAL_API_URL: 'https://api-test.weldsuite.org' } })('/api/user-apps/code/pubapp/session-token', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { token: string; expiresAt: string; apiBaseUrl: string } };
    expect(data.apiBaseUrl).toBe('https://api-test.weldsuite.org');
    expect(data.token).toMatch(/^wsat_/);
    const minutes = (Date.parse(data.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(59);
    const [token] = await master.select().from(userAppTokens).where(eq(userAppTokens.appId, 'uapp_pub'));
    expect(token).toMatchObject({ tokenType: 'session', scopes: ['crm:read'] });
  });

  it('answers 404 without an active install', async () => {
    const res = await api()('/api/user-apps/code/pubapp/session-token', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "App install with ID 'pubapp' not found" } });
  });
});

// ── the app gateway ─────────────────────────────────────────────────────────

describe('ALL /api/user-apps/code/:code/gateway/*', () => {
  // The gateway caches its token per workspace and app, in the process too:
  // each test installs the app for a workspace of its own.
  async function installed(workspaceId: string) {
    await installFor('uapp_pub', workspaceId, { grantedScopes: ['crm:read', 'crm:write'] });
    await tenant
      .insert(workspaceInstalledApps)
      .values({ id: 'wsapp_pub', appCode: 'pubapp', appType: 'user', userAppId: 'uapp_pub', grantedScopes: ['crm:read'] });
    return (path: string, init?: RequestInit) =>
      api({ workspaceId, env: { EXTERNAL_API_URL: `${EXTERNAL_API}/` } })(`/api/user-apps/code/pubapp/gateway${path}`, init);
  }

  it('forwards a read with a session token, the allowed headers and the query', async () => {
    const gateway = await installed('ws_gw_read');
    const res = await gateway('/v1/contacts?limit=5&q=a%20b', {
      headers: { accept: 'application/json', cookie: 'session=secret', 'x-request-id': 'req_1', authorization: 'Bearer member' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'con_1' }] });
    expect(res.headers.get('x-ratelimit-remaining')).toBe('99');
    expect(res.headers.get('x-upstream-secret')).toBeNull();

    const call = upstreamCalls.at(-1)!;
    expect(call).toMatchObject({ method: 'GET', url: `${EXTERNAL_API}/v1/contacts?limit=5&q=a%20b` });
    expect(call.authorization).toMatch(/^Bearer wsat_[0-9a-f]{40}$/);
    expect(call.headers).toMatchObject({ accept: 'application/json', 'x-request-id': 'req_1' });
    expect(call.headers).not.toHaveProperty('cookie');
    const tokens = await master.select().from(userAppTokens).where(eq(userAppTokens.workspaceId, 'ws_gw_read'));
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0]).toMatchObject({ tokenType: 'session', scopes: ['crm:read', 'crm:write'] });
  });

  it('forwards a write with its body, and an empty answer as is', async () => {
    const gateway = await installed('ws_gw_write');
    const res = await gateway('/v1/contacts', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Ann' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { name: 'Ann' } });
    expect(upstreamCalls.at(-1)).toMatchObject({ method: 'POST', body: '{"name":"Ann"}' });

    const removed = await gateway('/v1/contacts/con_1', { method: 'DELETE' });
    expect(removed.status).toBe(204);
  });

  it('passes external-api refusals through', async () => {
    const gateway = await installed('ws_gw_refused');
    const res = await gateway('/v1/nothing-here');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '/v1/nothing-here not found' } });
  });

  it('drops a cached token external-api refuses and retries once with a fresh one', async () => {
    const gateway = await installed('ws_gw_stale');
    kv.store.set(
      'uagw:v1:ws_gw_stale:pubapp',
      JSON.stringify({ token: STALE_TOKEN, expiresAt: Date.now() + 30 * 60 * 1000 }),
    );
    const res = await gateway('/v1/contacts');
    expect(res.status).toBe(200);
    const auths = upstreamCalls.map((c) => c.authorization);
    expect(auths).toContain(`Bearer ${STALE_TOKEN}`);
    expect(auths.at(-1)).toMatch(/^Bearer wsat_[0-9a-f]{40}$/);
    expect(auths.at(-1)).not.toBe(`Bearer ${STALE_TOKEN}`);
  });

  it('answers 404 when the workspace has not installed the app', async () => {
    const res = await api({ workspaceId: 'ws_gw_none', env: { EXTERNAL_API_URL: EXTERNAL_API } })(
      '/api/user-apps/code/pubapp/gateway/v1/contacts',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "App install with ID 'pubapp' not found" } });
    expect(upstreamCalls).toEqual([]);
  });

  it('refuses paths outside /v1/ before anything else', async () => {
    const gateway = await installed('ws_gw_paths');
    for (const path of ['/v2/contacts', '/v1/a%2Fb', '/v1/a//b', '/v1/%2e%2e/admin', '/v1']) {
      const res = await gateway(path);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: 'App gateway paths must be external API paths under /v1/' },
      });
    }
    expect(upstreamCalls).toEqual([]);
  });

  it('needs weldapps:read', async () => {
    const res = await api({ perms: permissions('crm:read') })('/api/user-apps/code/pubapp/gateway/v1/contacts');
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/user-apps/code/:code/dev-session', () => {
  const future = () => new Date(Date.now() + 5 * 60 * 1000);

  it("removes the caller's own preview session and nobody else's", async () => {
    await master.insert(userAppDevSessions).values([
      { id: 'uads_dev', appId: 'uapp_mine', workspaceId: OWNER, userId: 'user_dev', url: 'http://localhost:5173/', expiresAt: future() },
      { id: 'uads_other', appId: 'uapp_mine', workspaceId: OWNER, userId: 'user_other_dev', url: 'http://localhost:5174/', expiresAt: future() },
    ]);
    const res = await api()('/api/user-apps/code/mineapp/dev-session', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const rows = await master.select().from(userAppDevSessions);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['uads_other']);
    // Nothing left to clear is fine too.
    expect((await api()('/api/user-apps/code/mineapp/dev-session', { method: 'DELETE' })).status).toBe(204);
  });

  it('answers 404 for an app the workspace does not own, and needs weldapps:develop', async () => {
    const foreign = await api()('/api/user-apps/code/pubapp/dev-session', { method: 'DELETE' });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: { code: 'NOT_FOUND', message: "App with ID 'pubapp' not found" } });
    const res = await api({ perms: permissions('weldapps:read') })('/api/user-apps/code/mineapp/dev-session', {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });
});

// ── versions, review, OAuth ─────────────────────────────────────────────────

function upload(appId: string, parts: { manifest?: unknown; changelog?: string; files?: Record<string, string> }, caller?: Caller) {
  const form = new FormData();
  if (parts.manifest !== undefined) {
    form.append('manifest', typeof parts.manifest === 'string' ? parts.manifest : JSON.stringify(parts.manifest));
  }
  if (parts.changelog !== undefined) form.append('changelog', parts.changelog);
  for (const [name, text] of Object.entries(parts.files ?? {})) {
    form.append('files', new Blob([text], { type: 'text/plain' }), name);
  }
  return api(caller)(`/api/user-apps/${appId}/versions`, { method: 'POST', body: form });
}

const MANIFEST = {
  code: 'mineapp',
  name: 'Mine v1',
  version: '1.0.0',
  description: 'From the manifest',
  icon: 'Rocket',
  category: 'Sales',
  scopes: ['crm:read', 'tickets:read'],
  pricing: { type: 'subscription', monthlyPrice: 12.5, currency: 'usd' },
  unknownKey: 'dropped',
};

describe('POST /api/user-apps/:id/versions', () => {
  it('stores the bundle and publishes a private app at once, queueing new scopes on installs', async () => {
    await installFor('uapp_mine', OWNER, { grantedScopes: ['crm:read'] });
    await tenant.insert(workspaceInstalledApps).values({ id: 'wsapp_mine', appCode: 'mineapp', appType: 'user', userAppId: 'uapp_mine', grantedScopes: ['crm:read'] });
    kv.store.set('uapp-assets:v2:mineapp', '{}');

    const res = await upload('uapp_mine', {
      manifest: MANIFEST,
      changelog: 'First',
      files: { 'index.html': '<html>v1</html>', 'assets/index-abcdef12.js': 'console.log(1)' },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> & { id: string; bundleKey: string } };
    expect(data).toMatchObject({
      appId: 'uapp_mine',
      version: '1.0.0',
      status: 'draft',
      changelog: 'First',
      entrypoint: 'index.html',
      fileCount: 2,
      bundleSize: 29,
      requestedScopes: ['crm:read', 'tickets:read'],
    });
    expect(data.manifest).not.toHaveProperty('unknownKey');
    expect(storage.text(`${data.bundleKey}/index.html`)).toBe('<html>v1</html>');
    expect(storage.objects.get(`${data.bundleKey}/assets/index-abcdef12.js`)?.contentType).toBe('text/javascript; charset=utf-8');

    const app = await appRow('uapp_mine');
    expect(app).toMatchObject({
      currentVersionId: data.id,
      name: 'Mine v1',
      description: 'From the manifest',
      icon: 'Puzzle',
      category: 'Sales',
      pricingType: 'subscription',
      priceMonthly: '12.50',
      currency: 'USD',
      requestedScopes: ['crm:read', 'tickets:read'],
    });
    const [version] = await master.select().from(userAppVersions).where(eq(userAppVersions.id, data.id));
    expect(version.status).toBe('published');
    const [install] = await master.select().from(userAppInstalls).where(eq(userAppInstalls.id, 'uai_mine_owner'));
    expect(install.pendingScopes).toEqual(['tickets:read']);
    expect(kv.store.has('uapp-assets:v2:mineapp')).toBe(false);
  });

  it('sends a new version of a reviewed public app back to review', async () => {
    await master.update(userApps).set({ visibility: 'public', reviewStatus: 'approved' }).where(eq(userApps.id, 'uapp_mine'));
    const res = await upload('uapp_mine', { manifest: MANIFEST, files: { 'index.html': 'x' } });
    expect(res.status).toBe(201);
    const app = await appRow('uapp_mine');
    expect(app).toMatchObject({ reviewStatus: 'submitted', currentVersionId: null, name: 'Mine' });
  });

  it('refuses a version that already exists', async () => {
    await master.insert(userAppVersions).values({ id: 'uav_mine_1', appId: 'uapp_mine', version: '1.0.0', bundleKey: 'k', createdBy: 'user_dev' });
    const res = await upload('uapp_mine', { manifest: MANIFEST, files: { 'index.html': 'x' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'Version 1.0.0 already exists' } });
  });

  it('answers 400 for every malformed upload', async () => {
    const message = async (res: Response) => {
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: { message: string } }).error.message;
    };
    expect(await message(await upload('uapp_mine', { files: { 'index.html': 'x' } }))).toBe("Missing 'manifest' field (JSON string)");
    expect(await message(await upload('uapp_mine', { manifest: '{nope', files: { 'index.html': 'x' } }))).toBe(
      "Field 'manifest' is not valid JSON",
    );
    expect(await message(await upload('uapp_mine', { manifest: { ...MANIFEST, code: 'pubapp' }, files: { 'index.html': 'x' } }))).toBe(
      "Manifest code 'pubapp' does not match app code 'mineapp'",
    );
    expect(await message(await upload('uapp_mine', { manifest: MANIFEST }))).toBe('At least one bundle file is required');
    expect(await message(await upload('uapp_mine', { manifest: MANIFEST, files: { '../evil.js': 'x' } }))).toBe(
      "Invalid bundle file path: '../evil.js'",
    );
    const notMultipart = await api()('/api/user-apps/uapp_mine/versions', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(await message(notMultipart)).toBe('Expected multipart/form-data');
  });

  it('reports manifest validation as flattened issues', async () => {
    const res = await upload('uapp_mine', {
      manifest: { code: 'mineapp', name: '', version: '1.0', scopes: ['BAD'], pricing: { type: 'gift' }, webhookUrl: 'http://10.0.0.1/x' },
      files: { 'index.html': 'x' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid manifest',
        details: {
          formErrors: [],
          fieldErrors: {
            name: ['String must contain at least 1 character(s)'],
            version: ['semver (e.g. 1.0.0)'],
            scopes: ['scope must look like resource:action, resource:* or *'],
            pricing: ["Invalid enum value. Expected 'free' | 'subscription', received 'gift'"],
            webhookUrl: [
              'webhookUrl must be a public https URL with a DNS hostname (no private, link-local, loopback, metadata, or IP-literal hosts)',
            ],
          },
        },
      },
    });
  });

  it('answers 404 for a foreign app and needs weldapps:develop', async () => {
    expect((await upload('uapp_pub', { manifest: MANIFEST, files: { 'index.html': 'x' } })).status).toBe(404);
    expect((await upload('uapp_mine', { manifest: MANIFEST }, { perms: permissions('weldapps:read') })).status).toBe(403);
  });
});

describe('GET /api/user-apps/:id/versions', () => {
  it('lists the versions, newest first', async () => {
    await master.insert(userAppVersions).values([
      { id: 'uav_mine_1', appId: 'uapp_mine', version: '1.0.0', bundleKey: 'k1', createdBy: 'user_dev', createdAt: at(10) },
      { id: 'uav_mine_2', appId: 'uapp_mine', version: '1.1.0', bundleKey: 'k2', createdBy: 'user_dev', createdAt: at(11) },
    ]);
    const res = await api()('/api/user-apps/uapp_mine/versions');
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: { totalCount: number } };
    expect(body.data.map((v) => v.id)).toEqual(['uav_mine_2', 'uav_mine_1']);
    expect(body.pagination.totalCount).toBe(2);
    expect((await api()('/api/user-apps/uapp_pub/versions')).status).toBe(404);
  });
});

describe('POST /api/user-apps/:id/submit', () => {
  it('needs a version first', async () => {
    const res = await send('POST', '/api/user-apps/uapp_mine/submit', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Upload a version before submitting for review' } });
  });

  it('submits a community app for review with the notes', async () => {
    await master.insert(userAppVersions).values({ id: 'uav_mine_1', appId: 'uapp_mine', version: '1.0.0', bundleKey: 'k', createdBy: 'user_dev' });
    const res = await send('POST', '/api/user-apps/uapp_mine/submit', { notes: 'Please look' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      visibility: 'public',
      reviewStatus: 'submitted',
      reviewNotes: 'Please look',
      reviewedBy: null,
    });
  });

  it('approves an official app on submit', async () => {
    await master.update(userApps).set({ publisherType: 'weldsuite', reviewNotes: 'kept' }).where(eq(userApps.id, 'uapp_mine'));
    await master.insert(userAppVersions).values({ id: 'uav_mine_1', appId: 'uapp_mine', version: '1.0.0', bundleKey: 'k', createdBy: 'user_dev' });
    const res = await send('POST', '/api/user-apps/uapp_mine/submit', {});
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      reviewStatus: 'approved',
      reviewedBy: 'user_dev',
      reviewNotes: 'kept',
    });
  });

  it('validates, refuses foreign apps and needs weldapps:publish', async () => {
    expect((await send('POST', '/api/user-apps/uapp_mine/submit', { notes: 'x'.repeat(2001) })).status).toBe(400);
    expect((await send('POST', '/api/user-apps/uapp_pub/submit', {})).status).toBe(404);
    expect((await send('POST', '/api/user-apps/uapp_mine/submit', {}, { perms: permissions('weldapps:develop') })).status).toBe(403);
  });
});

describe('POST /api/user-apps/:id/review', () => {
  beforeEach(async () => {
    await master.insert(adminUsers).values({ id: 'adm_1', userId: 'user_staff', email: 'staff@weldsuite.org' });
    await master.update(userApps).set({ visibility: 'public', reviewStatus: 'submitted' }).where(eq(userApps.id, 'uapp_mine'));
    await master.insert(userAppVersions).values({
      id: 'uav_mine_1',
      appId: 'uapp_mine',
      version: '1.0.0',
      bundleKey: 'k',
      createdBy: 'user_dev',
      status: 'draft',
      manifest: { code: 'mineapp', name: 'Reviewed', version: '1.0.0', scopes: ['crm:read'] },
    });
  });

  it('is for platform staff only', async () => {
    const res = await send('POST', '/api/user-apps/uapp_mine/review', { decision: 'approved' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Platform staff only' } });
  });

  it('approves and publishes the candidate version', async () => {
    const res = await send('POST', '/api/user-apps/uapp_mine/review', { decision: 'approved', notes: 'Fine' }, { userId: 'user_staff', workspaceId: 'ws_staff' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      reviewStatus: 'approved',
      reviewNotes: 'Fine',
      reviewedBy: 'user_staff',
      currentVersionId: 'uav_mine_1',
      name: 'Reviewed',
    });
  });

  it('rejects', async () => {
    const res = await send('POST', '/api/user-apps/uapp_mine/review', { decision: 'rejected' }, { userId: 'user_staff' });
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({ reviewStatus: 'rejected', reviewNotes: null });
  });

  it('validates and answers 404 for an unknown app', async () => {
    expect((await send('POST', '/api/user-apps/uapp_mine/review', { decision: 'maybe' }, { userId: 'user_staff' })).status).toBe(400);
    expect((await send('POST', '/api/user-apps/uapp_nope/review', { decision: 'approved' }, { userId: 'user_staff' })).status).toBe(404);
  });
});

describe('OAuth client', () => {
  it('creates once (201), then rotates the secret keeping the client id (200)', async () => {
    expect((await api()('/api/user-apps/uapp_mine/oauth-client')).status).toBe(404);
    const created = await api()('/api/user-apps/uapp_mine/oauth-client', { method: 'POST' });
    expect(created.status).toBe(201);
    const first = ((await created.json()) as { data: { clientId: string; clientSecret: string } }).data;
    expect(first.clientId).toMatch(/^wac_[0-9a-f]{24}$/);
    expect(first.clientSecret).toMatch(/^wacs_[0-9a-f]{40}$/);

    const rotated = await api()('/api/user-apps/uapp_mine/oauth-client', { method: 'POST' });
    expect(rotated.status).toBe(200);
    const second = ((await rotated.json()) as { data: { clientId: string } }).data;
    expect(second.clientId).toBe(first.clientId);

    const read = await api()('/api/user-apps/uapp_mine/oauth-client');
    expect(((await read.json()) as { data: { clientId: string } }).data.clientId).toBe(first.clientId);
    const [client] = await master.select().from(userAppOauthClients).where(and(eq(userAppOauthClients.appId, 'uapp_mine')));
    expect(client.clientSecretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers 404 for foreign apps', async () => {
    expect((await api()('/api/user-apps/uapp_pub/oauth-client', { method: 'POST' })).status).toBe(404);
  });
});
