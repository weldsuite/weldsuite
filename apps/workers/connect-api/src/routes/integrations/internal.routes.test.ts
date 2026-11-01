/**
 * The internal (service-binding) `/api/integrations` routes on pglite,
 * mounted ahead of the Clerk-authed router as the worker mounts them: the
 * `X-Internal-Secret` check, the tenant from `X-Workspace-Id` or (through
 * the master database) `X-Internal-Workspace-Id`, the fall-through when no
 * internal header is sent, the CRM sync trigger and the Google Calendar watch
 * renewal, and WeldAds' scheduled sync and Meta event ingest.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as masterSchema from '@weldsuite/db/schema/master';
import { encryptField } from '@weldsuite/db/lib/crypto';
import { conformanceMasterDb, conformanceTenantDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant as Database),
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => ({ id: 'ws_test_default', clerkOrgId: orgId }),
  };
});

import { integrationsRoutes } from './index';
import { integrationsInternalRoutes } from './internal';

const SECRET = 'internal-test-secret';
const KEY_V2 = '11'.repeat(32);
const t = schema.integrationConnections;

/** The fetch the stub hands loopback calls to: the conformance harness's own. */
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(url)) return realFetch(input, init);
      // Meta's Graph API: no campaigns anywhere.
      if (url.startsWith('https://graph.facebook.com/')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const kv = createMemoryKv();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.tenant = db;
  holder.master = master;
  await master
    .insert(masterSchema.workspaces)
    .values({ id: 'ws_test_default', name: 'Default', slug: 'default-internal', clerkOrgId: 'org_test_default' })
    .onConflictDoNothing();
}, 60_000);

/** The worker's mount order: the internal router, then the Clerk-authed one. */
const routes = new Hono<{ Bindings: Env; Variables: Variables }>();
routes.route('/', integrationsInternalRoutes);
routes.route('/', integrationsRoutes);

function crmSyncBinding() {
  return {
    create: vi.fn(async (options: { id?: string }) => ({ id: options?.id ?? 'crm-run' })),
    get: vi.fn(async (id: string) => ({ id })),
  };
}

function app(env: Record<string, unknown> = {}) {
  return createTestApp<Env, Variables>('/api/integrations', routes, {
    context: { tenantDb: db, masterDb: master, permissions: permissions('integrations:read', 'integrations:update') },
    env: {
      WORKSPACE_CACHE: kv,
      INTERNAL_API_SECRET: SECRET,
      DATABASE_ENCRYPTION_KEY_V2: KEY_V2,
      ...env,
    } as never,
  }).request;
}

const internal = (headers: Record<string, string> = {}, body?: unknown): RequestInit => ({
  method: 'POST',
  headers: {
    'X-Internal-Secret': SECRET,
    'X-Workspace-Id': 'org_test_default',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...headers,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function seedConnection(id: string, values: Partial<typeof t.$inferInsert> = {}) {
  await db.insert(t).values({
    id,
    provider: 'hubspot',
    name: 'Seeded',
    status: 'active',
    direction: 'inbound',
    oauthTokens: { accessToken: 'seed-at' },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...values,
  } as typeof t.$inferInsert);
}

describe('the internal secret and tenant headers', () => {
  it('refuses a wrong secret, and a call without a workspace header', async () => {
    await seedConnection('intc_int_auth0001');
    const wrong = await app()('/api/integrations/connections/intc_int_auth0001/sync', internal({ 'X-Internal-Secret': 'nope' }));
    expect(wrong.status).toBe(401);
    const unset = await app({ INTERNAL_API_SECRET: undefined })('/api/integrations/connections/intc_int_auth0001/sync', internal());
    expect(unset.status).toBe(401);
    const noWorkspace = await app()('/api/integrations/connections/intc_int_auth0001/renew-watch', {
      method: 'POST',
      headers: { 'X-Internal-Secret': SECRET },
    });
    expect(noWorkspace.status).toBe(400);
    const unknownInternal = await app()('/api/integrations/connections/intc_int_auth0001/sync', {
      method: 'POST',
      headers: { 'X-Internal-Secret': SECRET, 'X-Internal-Workspace-Id': 'ws_unknown' },
    });
    expect(unknownInternal.status).toBe(400);
  });

  it('falls through to the member routes without internal headers', async () => {
    await seedConnection('intc_int_member01');
    const res = await app({ CRM_SYNC: crmSyncBinding() })('/api/integrations/connections/intc_int_member01/sync', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('POST /connections/:id/sync (internal)', () => {
  it('starts a full or incremental sync, by Clerk org id or internal workspace id', async () => {
    const crmSync = crmSyncBinding();
    await seedConnection('intc_int_sync0001');
    const res = await app({ CRM_SYNC: crmSync })('/api/integrations/connections/intc_int_sync0001/sync', internal({}, { syncType: 'incremental' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ message: 'Sync started' });
    expect(crmSync.create).toHaveBeenCalled();

    await seedConnection('intc_int_sync0002');
    const byWorkspace = await app({ CRM_SYNC: crmSync })('/api/integrations/connections/intc_int_sync0002/sync', {
      method: 'POST',
      headers: { 'X-Internal-Secret': SECRET, 'X-Internal-Workspace-Id': 'ws_test_default', 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(byWorkspace.status).toBe(200);
    const again = await app({ CRM_SYNC: crmSync })('/api/integrations/connections/intc_int_sync0002/sync', internal());
    expect(again.status).toBe(409);
  });

  it('answers 404 and 400 as the member route does', async () => {
    expect((await app()('/api/integrations/connections/intc_missing000000/sync', internal())).status).toBe(404);
    await seedConnection('intc_int_notoken1', { oauthTokens: null });
    expect((await app()('/api/integrations/connections/intc_int_notoken1/sync', internal())).status).toBe(400);
  });
});

describe('POST /connections/:id/renew-watch (internal)', () => {
  it('404s a connection that is not a Google Calendar one', async () => {
    await seedConnection('intc_int_watch001');
    expect((await app()('/api/integrations/connections/intc_int_watch001/renew-watch', internal())).status).toBe(404);
    await seedConnection('intc_int_watch002', { provider: 'google_calendar', oauthTokens: null });
    expect((await app()('/api/integrations/connections/intc_int_watch002/renew-watch', internal())).status).toBe(500);
  });
});

describe('WeldAds', () => {
  async function seedAdConnection(id: string, token: string | null) {
    const now = new Date();
    await db.insert(schema.adPlatformConnections).values({
      id,
      platform: 'facebook',
      status: 'active',
      oauthTokens: token ? { accessToken: await encryptField(token, { v2: KEY_V2 }), tokenType: 'bearer' } : null,
      createdAt: now,
      updatedAt: now,
    } as typeof schema.adPlatformConnections.$inferInsert);
  }

  async function seedAccount(id: string, connectionId: string, isSelected: boolean) {
    const now = new Date();
    await db.insert(schema.adAccounts).values({
      id,
      connectionId,
      platformAccountId: `act_${id}`,
      name: id,
      isSelected,
      createdAt: now,
      updatedAt: now,
    } as typeof schema.adAccounts.$inferInsert);
  }

  it('syncs an ad connection, and refuses a missing one or one without a token', async () => {
    await seedAdConnection('adc_int_sync00001', 'meta-token');
    const res = await app()('/api/integrations/ad-connections/adc_int_sync00001/sync?scope=push', internal());
    expect(res.status).toBe(200);
    const pulled = await app()('/api/integrations/ad-connections/adc_int_sync00001/sync?scope=metrics', internal());
    expect(pulled.status).toBe(200);
    expect((await app()('/api/integrations/ad-connections/adc_missing000000/sync', internal())).status).toBe(404);
    await seedAdConnection('adc_int_notoken01', null);
    expect((await app()('/api/integrations/ad-connections/adc_int_notoken01/sync', internal())).status).toBe(400);
  });

  it('ingests a Meta event for a selected account, and skips the others', async () => {
    expect((await app()('/api/integrations/ad-events', internal({}, { objectType: 'campaign' }))).status).toBe(400);

    const skipped = await app()('/api/integrations/ad-events', internal({}, { platformAccountId: 'act_nobody' }));
    expect(((await skipped.json()) as { data: unknown }).data).toEqual({ skipped: true, reason: 'account_not_selected' });

    await seedAdConnection('adc_int_event0001', null);
    await seedAccount('ada_int_event0001', 'adc_int_event0001', true);
    const missing = await app()('/api/integrations/ad-events', internal({}, { platformAccountId: 'act_ada_int_event0001' }));
    expect(((await missing.json()) as { data: unknown }).data).toEqual({ skipped: true, reason: 'missing_token' });

    await seedAdConnection('adc_int_event0002', 'meta-token');
    await seedAccount('ada_int_event0002', 'adc_int_event0002', true);
    const ingested = await app()('/api/integrations/ad-events', internal({}, { platformAccountId: 'act_ada_int_event0002', objectType: 'campaign' }));
    expect(ingested.status).toBe(200);
  });
});
