/**
 * /api/reach/mailboxes with the real Mailpool and billing-worker clients
 * against a `fetch` stub (test-support/http-stubs), so the conformance suite
 * compares both backends end to end: create (billing, slots, Mailpool, the
 * warmup pool, the master routes) and its refusals and rollback, reads with
 * the pool's numbers, update, pause, resume and delete.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { approvedAccess } from '../../lib/mailpool/testing-routes';
import {
  WARMUP_TEST_KEY,
  poolStats,
  resetReachMaster,
  resetReachTenant,
  seedMailbox,
  seedPoolMailbox,
  seedReachDomain,
} from '../../lib/mailpool/testing-db';
import { createHttpStubs, MAILPOOL_ENV } from '../../test-support/http-stubs';

let masterDb: MasterDatabase;
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  const { conformanceMasterDb } = await vi.importActual<typeof import('@weldsuite/worker-kit/testing/conformance')>(
    '@weldsuite/worker-kit/testing/conformance',
  );
  return { ...actual, getMasterDb: () => conformanceMasterDb(masterDb as never) };
});

const { default: mailboxRoutes } = await import('./index');

let db: Database;
let stubs: ReturnType<typeof createHttpStubs>;

const ALL = ['reach_mailboxes:read', 'reach_mailboxes:create', 'reach_mailboxes:update', 'reach_mailboxes:delete'];
const ENV = { ...MAILPOOL_ENV, WELDREACH_WARMUP_KEY: WARMUP_TEST_KEY };

function api(keys: string[] = ALL, access = approvedAccess(), env: Record<string, string> = ENV) {
  return createTestApp('/api/reach/mailboxes', mailboxRoutes, {
    context: {
      appAccess: access,
      permissions: permissions(...keys),
      tenantDb: db,
      masterDb: masterDb as unknown as Database,
      workspaceId: 'ws_acme',
      clerkOrgId: 'org_acme',
    },
    env: env as never,
  }).request;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const createBody = { domainId: 'rdom_1', localPart: ' Jane.Doe ', firstName: 'Jane', lastName: 'Doe', type: 'google' };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  stubs = createHttpStubs();
  vi.stubGlobal('fetch', stubs.fetch);
  await resetReachTenant(db);
  await resetReachMaster(masterDb);
  await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com', mailpoolDomainId: '5001' });
});

describe('create', () => {
  it('bills, provisions and enters the warmup pool; the response has no logins', async () => {
    const res = await api()('/api/reach/mailboxes', json('POST', createBody));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ email: 'jane.doe@getacme.com', status: 'warming', warmupStatus: 'waiting' });
    expect(JSON.stringify(data)).not.toContain('secret');
    const routes = await masterDb.select().from(masterSchema.reachRoutes);
    expect(routes.map((r) => r.kind).sort()).toEqual(['inbound_token', 'mailpool_mailbox']);
    expect(await masterDb.select().from(masterSchema.reachWarmupMailboxes)).toHaveLength(1);
  });

  it('waits as provisioning when Mailpool has no logins yet, adding a slot when the account is full', async () => {
    stubs.world.createWithLogins = false;
    stubs.world.createStatus = 'pending';
    stubs.world.slots = { mailboxes: { google: 3 }, slots: { google: 3 } };
    const res = await api()('/api/reach/mailboxes', json('POST', { ...createBody, type: 'shared', localPart: 'kim' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('provisioning');
    expect(await masterDb.select().from(masterSchema.reachWarmupMailboxes)).toHaveLength(0);
  });

  it('rolls everything back when Mailpool cannot activate the mailbox', async () => {
    stubs.world.createStatus = 'inactive';
    const res = await api()('/api/reach/mailboxes', json('POST', createBody));
    expect(res.status).toBe(502);
    expect(await db.select().from(schema.reachMailboxes)).toHaveLength(0);
    expect(await masterDb.select().from(masterSchema.reachRoutes)).toHaveLength(0);
  });

  it('answers 402 without a payment method, and 502 when billing fails', async () => {
    stubs.world.billing['/inboxes'] = { status: 402, body: { error: { code: 'PAYMENT_METHOD_REQUIRED', message: 'none' } } };
    expect((await api()('/api/reach/mailboxes', json('POST', createBody))).status).toBe(402);
    // billing-worker without Stripe, as on the Kubernetes editions.
    stubs.world.billing['/inboxes'] = { status: 503, body: { error: { code: 'BILLING_NOT_CONFIGURED', message: 'Billing is not configured for this environment.' } } };
    expect((await api()('/api/reach/mailboxes', json('POST', createBody))).status).toBe(502);
    expect(await db.select().from(schema.reachMailboxes)).toHaveLength(0);
  });

  it('answers 502 when Mailpool refuses the create', async () => {
    stubs.world.refusals['POST /mailboxes'] = { status: 400, body: { message: 'Invalid name' } };
    expect((await api()('/api/reach/mailboxes', json('POST', createBody))).status).toBe(502);
    expect(await db.select().from(schema.reachMailboxes)).toHaveLength(0);
  });

  it('refuses what cannot be created before anything is paid', async () => {
    const { REACH_INBOUND_DOMAIN: _inbound, ...noInbound } = ENV;
    expect((await api(ALL, approvedAccess(), noInbound)('/api/reach/mailboxes', json('POST', createBody))).status).toBe(503);
    const { WELDREACH_WARMUP_KEY: _key, ...noWarmup } = ENV;
    expect((await api(ALL, approvedAccess(), noWarmup)('/api/reach/mailboxes', json('POST', createBody))).status).toBe(503);
    const { MAILPOOL_API_KEY: _mp, ...noMailpool } = ENV;
    expect((await api(ALL, approvedAccess(), noMailpool)('/api/reach/mailboxes', json('POST', createBody))).status).toBe(503);
    expect((await api()('/api/reach/mailboxes', json('POST', { ...createBody, domainId: 'rdom_nope' }))).status).toBe(404);
    await seedReachDomain(db, { id: 'rdom_2', hostDomainId: 'dom_2', name: 'acme2.com', status: 'connecting' });
    expect((await api()('/api/reach/mailboxes', json('POST', { ...createBody, domainId: 'rdom_2' }))).status).toBe(409);
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', email: 'jane.doe@getacme.com' });
    expect((await api()('/api/reach/mailboxes', json('POST', createBody))).status).toBe(409);
    expect((await api(ALL, approvedAccess({ limits: { maxMailboxes: 1 } }))('/api/reach/mailboxes', json('POST', createBody))).status).toBe(403);
    expect(
      (await api(ALL, approvedAccess({ billingStatus: 'canceled' }))('/api/reach/mailboxes', json('POST', { ...createBody, localPart: 'kim' })))
        .status,
    ).toBe(402);
    expect((await api(ALL, approvedAccess({ workspaceId: null }))('/api/reach/mailboxes', json('POST', createBody))).status).toBe(403);
    expect(stubs.calls('https://billing-worker-test.weldsuite.org')).toEqual([]);
  });

  it.each([
    ['a bad local part', { ...createBody, localPart: 'jane doe!' }],
    ['an unknown type', { ...createBody, type: 'outlook' }],
    ['no names', { domainId: 'rdom_1', localPart: 'x', type: 'google' }],
  ])('validates %s', async (_label, body) => {
    expect((await api()('/api/reach/mailboxes', json('POST', body))).status).toBe(400);
  });

  it('needs reach_mailboxes:create', async () => {
    expect((await api(['reach_mailboxes:read'])('/api/reach/mailboxes', json('POST', createBody))).status).toBe(403);
  });
});

describe('reads', () => {
  beforeEach(async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'warming', warmupDay: 3 });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'active' });
    await seedMailbox(db, { id: 'rmbx_3', domainId: 'rdom_1', status: 'deleted' });
    await seedPoolMailbox(masterDb, { tenantMailboxId: 'rmbx_1', status: 'warming', rampDay: 3, stats: poolStats({ sent7d: 12, spamRescues7d: 2 }) });
  });

  it('lists live mailboxes with the pool numbers, filtered by status and domain', async () => {
    const res = await api()('/api/reach/mailboxes');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; warmupSent7d: number; warmupBlocker: string | null }> };
    expect(data.map((m) => m.id)).toEqual(['rmbx_1', 'rmbx_2']);
    expect(data[0]).toMatchObject({ warmupSent7d: 12, warmupBlocker: 'pool_too_small' });
    expect((await api()('/api/reach/mailboxes?status=deleted')).status).toBe(200);
    expect((await api()('/api/reach/mailboxes?domainId=rdom_1&status=active')).status).toBe(200);
    expect((await api()('/api/reach/mailboxes?status=gone')).status).toBe(400);
  });

  it('reads one mailbox, 404 for a deleted or unknown one', async () => {
    expect((await api()('/api/reach/mailboxes/rmbx_1')).status).toBe(200);
    expect((await api()('/api/reach/mailboxes/rmbx_3')).status).toBe(404);
    expect((await api(['reach_settings:read'])('/api/reach/mailboxes/rmbx_1')).status).toBe(403);
  });
});

describe('update, pause, resume and delete', () => {
  beforeEach(async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1', status: 'active', dailyCap: 30, rampCurrent: 25, signature: 'Jane' });
    await seedPoolMailbox(masterDb, { tenantMailboxId: 'rmbx_1', status: 'maintaining', rampDay: 20, startedAt: new Date('2026-10-01T00:00:00Z') });
    await masterDb.insert(masterSchema.reachRoutes).values([
      { id: 'rrt_1', kind: 'mailpool_mailbox', externalId: 'mp_rmbx_1', workspaceId: 'ws_acme', clerkOrgId: 'org_acme', tenantEntityId: 'rmbx_1' },
      { id: 'rrt_2', kind: 'inbound_token', externalId: 'tokenrmbx1', workspaceId: 'ws_acme', clerkOrgId: 'org_acme', tenantEntityId: 'rmbx_1' },
    ]);
  });

  it('renames at Mailpool and in the pool, and caps the ramp', async () => {
    const res = await api()('/api/reach/mailboxes/rmbx_1', json('PATCH', { firstName: 'Janet', signature: null, dailyCap: 20 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({ firstName: 'Janet', signature: null, dailyCap: 20, rampCurrent: 20 });
    const [pool] = await masterDb.select().from(masterSchema.reachWarmupMailboxes);
    expect(pool?.firstName).toBe('Janet');
    expect((await api()('/api/reach/mailboxes/rmbx_1', json('PATCH', { dailyCap: 99 }))).status).toBe(400);
    expect((await api()('/api/reach/mailboxes/rmbx_nope', json('PATCH', { firstName: 'X' }))).status).toBe(404);
  });

  it('refuses to update a mailbox being deleted, and answers 502 when Mailpool refuses', async () => {
    stubs.world.refusals['PUT /mailboxes/mp_rmbx_1'] = { status: 400, body: { message: 'Nope' } };
    expect((await api()('/api/reach/mailboxes/rmbx_1', json('PATCH', { lastName: 'Smith' }))).status).toBe(502);
    await db.update(schema.reachMailboxes).set({ status: 'deleting' });
    expect((await api()('/api/reach/mailboxes/rmbx_1', json('PATCH', { lastName: 'Smith' }))).status).toBe(409);
  });

  it('pauses and resumes, the pool following', async () => {
    let res = await api()('/api/reach/mailboxes/rmbx_1/pause', json('POST', {}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('paused');
    expect((await api()('/api/reach/mailboxes/rmbx_1/pause', json('POST', {}))).status).toBe(200);
    res = await api()('/api/reach/mailboxes/rmbx_1/resume', json('POST', {}));
    expect(res.status).toBe(200);
    const [pool] = await masterDb.select().from(masterSchema.reachWarmupMailboxes);
    expect(pool?.status).toBe('maintaining');
    expect((await api()('/api/reach/mailboxes/rmbx_1/resume', json('POST', {}))).status).toBe(200);
  });

  it('refuses to pause or resume what cannot be, and to resume on an inactive domain', async () => {
    await db.update(schema.reachMailboxes).set({ status: 'error' });
    expect((await api()('/api/reach/mailboxes/rmbx_1/pause', json('POST', {}))).status).toBe(409);
    expect((await api()('/api/reach/mailboxes/rmbx_1/resume', json('POST', {}))).status).toBe(409);
    await db.update(schema.reachMailboxes).set({ status: 'paused' });
    await db.update(schema.reachDomains).set({ status: 'error' });
    expect((await api()('/api/reach/mailboxes/rmbx_1/resume', json('POST', {}))).status).toBe(409);
    expect((await api(['reach_mailboxes:read'])('/api/reach/mailboxes/rmbx_1/pause', json('POST', {}))).status).toBe(403);
    expect((await api(['reach_mailboxes:read'])('/api/reach/mailboxes/rmbx_1/resume', json('POST', {}))).status).toBe(403);
  });

  it('deletes: Mailpool, the pool, the routes, the logins, and gives the inbox back', async () => {
    const res = await api()('/api/reach/mailboxes/rmbx_1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.reachMailboxes);
    expect(row).toMatchObject({ status: 'deleted', smtpCredentials: null });
    const routes = await masterDb.select().from(masterSchema.reachRoutes);
    expect(routes.every((r) => r.status === 'deleted')).toBe(true);
    expect((await api()('/api/reach/mailboxes/rmbx_1', { method: 'DELETE' })).status).toBe(404);
  });

  it('completes a delete when billing cannot take the inbox back, and keeps the mailbox when Mailpool refuses', async () => {
    stubs.world.refusals['DELETE /mailboxes/mp_rmbx_1'] = { status: 400, body: { message: 'Nope' } };
    expect((await api()('/api/reach/mailboxes/rmbx_1', { method: 'DELETE' })).status).toBe(502);
    expect((await db.select().from(schema.reachMailboxes))[0]?.status).toBe('active');
    delete stubs.world.refusals['DELETE /mailboxes/mp_rmbx_1'];
    stubs.world.billing['/inboxes'] = { status: 503, body: { error: { code: 'BILLING_NOT_CONFIGURED', message: 'x' } } };
    expect((await api()('/api/reach/mailboxes/rmbx_1', { method: 'DELETE' })).status).toBe(204);
    expect((await api(['reach_mailboxes:read'])('/api/reach/mailboxes/rmbx_1', { method: 'DELETE' })).status).toBe(403);
  });
});
