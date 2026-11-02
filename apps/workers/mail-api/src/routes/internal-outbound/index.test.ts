import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import { masterSchema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { OUTBOUND_DEFAULT_LIMITS } from '@weldsuite/app-api-client/schemas/outbound-mail';

let master: MasterDatabase;

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(master) };
});

import { internalOutboundRoutes } from './index';

const SECRET = 'x'.repeat(40);
const names: string[] = [];
const refreshed: string[] = [];

const INSPECTION = {
  usage: {
    mode: 'shadow',
    trustLevel: 'new',
    state: 'active',
    stateReason: null,
    limits: { ...OUTBOUND_DEFAULT_LIMITS.new },
    workspace: {
      hour: 0,
      day: { used: 2, limit: 300 },
      firstContactDay: { used: 1, limit: 50 },
      month: { used: 2, limit: null },
    },
    senders: [],
    deliveries7d: { delivered: 0, hardBounces: 0, softBounces: 0, complaints: 0, rejected: 0 },
    coldOutreachCapped: false,
  },
  riskScore: 12,
  riskReasons: ['first_contact_share:0.40'],
  shadowDenials7d: { SENDING_LIMITED: 2 },
};

/** A stub `OUTBOUND_LEDGER`: answers by method, records which ledger was named. */
const ledger = {
  idFromName: (n: string) => (names.push(n), n),
  get: (name: string) => ({
    refreshPolicy: async () => {
      refreshed.push(name);
    },
    requestReview: async () => true,
    inspect: async () => INSPECTION,
  }),
};

/** A stub `OUTBOUND_PLATFORM`. */
const platform = {
  idFromName: (n: string) => n,
  get: () => ({ status: async () => ({ tripped: false, recipients: 120, quota: null, reason: null }) }),
};

let tenantDb: Database;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  await master.insert(masterSchema.workspaces).values({ id: 'ws_admin', name: 'Admin test', slug: 'admin-test', clerkOrgId: 'org_admin' });
}, 60_000);

function app(env: Record<string, unknown> = {}) {
  return createTestApp('/internal/outbound', internalOutboundRoutes as never, {
    context: { tenantDb, masterDb: master as unknown as Database },
    env: { OUTBOUND_ADMIN_SECRET: SECRET, OUTBOUND_LEDGER: ledger, OUTBOUND_PLATFORM: platform, ...env } as never,
  });
}

const headers = { 'x-admin-secret': SECRET, 'x-admin-email': 'Ops@WeldSuite.org', 'content-type': 'application/json' };

const post = (path: string, body: unknown, env?: Record<string, unknown>) =>
  app(env).request(`/internal/outbound${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('/internal/outbound', () => {
  it('is closed without a configured secret', async () => {
    const res = await app({ OUTBOUND_ADMIN_SECRET: 'short' }).request('/internal/outbound/platform', { headers });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'NOT_CONFIGURED', message: 'The admin API is not configured' } });
  });

  it('refuses a wrong secret and a missing admin identity', async () => {
    expect((await app().request('/internal/outbound/platform', { headers: { ...headers, 'x-admin-secret': 'y'.repeat(40) } })).status).toBe(401);
    const anonymous = await app().request('/internal/outbound/platform', { headers: { 'x-admin-secret': SECRET } });
    expect(anonymous.status).toBe(400);
    expect(await anonymous.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'x-admin-email must identify the acting admin' },
    });
    const notAnEmail = await app().request('/internal/outbound/platform', {
      headers: { ...headers, 'x-admin-email': 'ops' },
    });
    expect(notAnEmail.status).toBe(400);
  });

  it('reloads a workspace ledger', async () => {
    const res = await post('/refresh', { workspaceId: 'ws_admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(refreshed).toContain('ws:ws_admin');
    expect(names).toContain('ws:ws_admin');
  });

  it('queues a staff review and 404s an unknown workspace', async () => {
    const ok = await post('/review', { workspaceId: 'ws_admin' });
    expect(await ok.json()).toEqual({ data: { queued: true } });
    const missing = await post('/review', { workspaceId: 'ws_nope' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('validates the workspace body', async () => {
    const empty = await post('/refresh', { workspaceId: '' });
    expect(empty.status).toBe(400);
    const missing = await post('/review', {});
    expect(missing.status).toBe(400);
  });

  it('answers 503 without a ledger', async () => {
    const res = await post('/refresh', { workspaceId: 'ws_admin' }, { OUTBOUND_LEDGER: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'NOT_CONFIGURED', message: 'No ledger binding' } });
    const inspect = await app({ OUTBOUND_LEDGER: undefined }).request('/internal/outbound/inspect?workspaceId=ws_admin', { headers });
    expect(inspect.status).toBe(503);
  });

  it("inspects a workspace's ledger", async () => {
    const res = await app().request('/internal/outbound/inspect?workspaceId=ws_admin', { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: INSPECTION });
    const unknown = await app().request('/internal/outbound/inspect?workspaceId=ws_nope', { headers });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Workspace with ID 'ws_nope' not found" } });
    const noId = await app().request('/internal/outbound/inspect', { headers });
    expect(noId.status).toBe(400);
  });

  it('reports the platform budget', async () => {
    const res = await app().request('/internal/outbound/platform', { headers });
    expect(await res.json()).toEqual({ data: { tripped: false, recipients: 120, quota: null, reason: null } });
    const none = await app({ OUTBOUND_PLATFORM: undefined }).request('/internal/outbound/platform', { headers });
    expect(none.status).toBe(503);
    expect(await none.json()).toEqual({ error: { code: 'NOT_CONFIGURED', message: 'No platform budget binding' } });
  });

  it('answers per domain for the sending-events backfill', async () => {
    // No Cloudflare credentials here, so no domain gets a subscription.
    const res = await post('/sending-events/subscribe', { domains: [' Acme.COM ', 'example.org'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { results: { 'acme.com': false, 'example.org': false } } });
    const invalid = await post('/sending-events/subscribe', { domains: [] });
    expect(invalid.status).toBe(400);
  });
});
