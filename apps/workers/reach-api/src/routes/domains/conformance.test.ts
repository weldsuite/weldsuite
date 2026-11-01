/**
 * /api/reach/domains with the real Mailpool client and DNS checks against a
 * `fetch` stub (test-support/http-stubs), so the conformance suite compares
 * both backends end to end: candidates and their guards, connect (and its
 * refusals), the DNS refresh and disconnect, with the master route table.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { approvedAccess } from '../../lib/mailpool/testing-routes';
import { resetReachMaster, resetReachTenant, seedHostDomain, seedMailbox, seedReachDomain } from '../../lib/mailpool/testing-db';
import { createHttpStubs, MAILPOOL_ENV } from '../../test-support/http-stubs';

let masterDb: MasterDatabase;
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  const { conformanceMasterDb: wrap } = await vi.importActual<typeof import('@weldsuite/worker-kit/testing/conformance')>(
    '@weldsuite/worker-kit/testing/conformance',
  );
  return { ...actual, getMasterDb: () => wrap(masterDb as never) };
});

const { default: domainRoutes } = await import('./index');

let db: Database;
let stubs: ReturnType<typeof createHttpStubs>;

const ALL = ['reach_mailboxes:read', 'reach_mailboxes:create', 'reach_mailboxes:update', 'reach_mailboxes:delete'];

function api(keys: string[] = ALL, access = approvedAccess(), env: Record<string, string> = MAILPOOL_ENV) {
  return createTestApp('/api/reach/domains', domainRoutes, {
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

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  stubs = createHttpStubs();
  vi.stubGlobal('fetch', stubs.fetch);
  await resetReachTenant(db);
  await resetReachMaster(masterDb);
  await seedHostDomain(db, { id: 'dom_free', fullDomain: 'getacme.com' });
  await seedHostDomain(db, { id: 'dom_mx', fullDomain: 'acme-mail.com' });
  await seedHostDomain(db, { id: 'dom_web', fullDomain: 'acme-web.com' });
  await seedHostDomain(db, { id: 'dom_pending', fullDomain: 'acme-pending.com', status: 'pending' });
  await seedHostDomain(db, { id: 'dom_elsewhere', fullDomain: 'acme-elsewhere.com', zoneProvider: 'hetzner' });
  stubs.world.dns['acme-mail.com MX'] = ['mx.acme-mail.com'];
  stubs.world.dns['www.acme-web.com A'] = ['203.0.113.7'];
});

describe('candidates', () => {
  it('lists the WeldHost domains with why each cannot be connected', async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_web', name: 'acme-web.com' });
    const res = await api()('/api/reach/domains/candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ hostDomainId: string; eligible: boolean; reason: string | null }> };
    const reasons = Object.fromEntries(body.data.map((c) => [c.hostDomainId, c.reason]));
    expect(reasons).toEqual({
      dom_free: null,
      dom_mx: 'has_mx',
      dom_web: 'already_connected',
      dom_pending: 'not_active',
      dom_elsewhere: 'not_on_cloudflare',
    });
  });

  it('does not hide a domain over a resolver failure, and says when the limit is reached', async () => {
    stubs.world.dns['getacme.com MX'] = null;
    let res = await api()('/api/reach/domains/candidates');
    expect(res.status).toBe(200);
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_web', name: 'acme-web.com' });
    res = await api(ALL, approvedAccess({ limits: { maxDomains: 1 } }))('/api/reach/domains/candidates');
    const body = (await res.json()) as { data: Array<{ hostDomainId: string; reason: string | null }> };
    expect(body.data.find((c) => c.hostDomainId === 'dom_free')?.reason).toBe('limit_reached');
  });

  it('refuses a workspace without a master workspace row', async () => {
    const res = await api(ALL, approvedAccess({ workspaceId: null }))('/api/reach/domains/candidates');
    expect(res.status).toBe(403);
  });
});

describe('connect', () => {
  it('connects an eligible domain: 201, the route in master, an event', async () => {
    const res = await api()('/api/reach/domains', post({ hostDomainId: 'dom_free' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { name: string; status: string; mailboxCount: number } };
    expect(data).toMatchObject({ name: 'getacme.com', status: 'active', mailboxCount: 0 });
    const routes = await masterDb.select().from(masterSchema.reachRoutes);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ kind: 'mailpool_domain', workspaceId: 'ws_acme', clerkOrgId: 'org_acme' });
  });

  it('lets staff force a domain that has mail records', async () => {
    const res = await api(ALL, approvedAccess({ limits: { forceAllowDomains: ['acme-mail.com'] } }))(
      '/api/reach/domains',
      post({ hostDomainId: 'dom_mx' }),
    );
    expect(res.status).toBe(201);
  });

  it.each([
    ['an unknown domain', { hostDomainId: 'dom_nope' }, 404],
    ['a domain with MX records', { hostDomainId: 'dom_mx' }, 422],
    ['a domain with a website', { hostDomainId: 'dom_web' }, 422],
    ['a pending domain', { hostDomainId: 'dom_pending' }, 422],
    ['a domain off WeldHost nameservers', { hostDomainId: 'dom_elsewhere' }, 422],
    ['a missing id', {}, 400],
  ])('refuses %s', async (_label, body, status) => {
    const res = await api()('/api/reach/domains', post(body));
    expect(res.status).toBe(status);
    expect(await masterDb.select().from(masterSchema.reachRoutes)).toHaveLength(0);
  });

  it('refuses a domain that is already connected (409) and one DNS cannot check (503)', async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_free', name: 'getacme.com' });
    expect((await api()('/api/reach/domains', post({ hostDomainId: 'dom_free' }))).status).toBe(409);
    stubs.world.dns['acme-web.com AAAA'] = null;
    expect((await api(ALL, approvedAccess({ limits: { maxDomains: 5 } }))('/api/reach/domains', post({ hostDomainId: 'dom_web' }))).status).toBe(503);
  });

  it('reports what Mailpool skipped, and answers 503 without a Mailpool key', async () => {
    stubs.world.skippedDomains['getacme.com'] = 'zone not found';
    const res = await api()('/api/reach/domains', post({ hostDomainId: 'dom_free' }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('zone not found');
    const { MAILPOOL_API_KEY: _key, ...withoutKey } = MAILPOOL_ENV;
    expect((await api(ALL, approvedAccess(), withoutKey)('/api/reach/domains', post({ hostDomainId: 'dom_free' }))).status).toBe(503);
  });

  it('answers 502 when Mailpool fails', async () => {
    stubs.world.refusals['POST /domains/cloudflare/connect'] = { status: 400, body: { message: 'Bad request' } };
    expect((await api()('/api/reach/domains', post({ hostDomainId: 'dom_free' }))).status).toBe(502);
  });

  it('needs reach_mailboxes:create', async () => {
    const res = await api(['reach_mailboxes:read'])('/api/reach/domains', post({ hostDomainId: 'dom_free' }));
    expect(res.status).toBe(403);
  });
});

describe('reads, DNS refresh and disconnect', () => {
  beforeEach(async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_free', name: 'getacme.com', mailpoolDomainId: '5001' });
    await masterDb.insert(masterSchema.reachRoutes).values({
      id: 'rrt_1',
      kind: 'mailpool_domain',
      externalId: '5001',
      workspaceId: 'ws_acme',
      clerkOrgId: 'org_acme',
      tenantEntityId: 'rdom_1',
    });
  });

  it('lists and reads domains with their mailbox counts', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });
    const list = await api()('/api/reach/domains');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: Array<{ mailboxCount: number }> }).data[0]?.mailboxCount).toBe(1);
    expect((await api()('/api/reach/domains/rdom_1')).status).toBe(200);
    expect((await api()('/api/reach/domains/rdom_nope')).status).toBe(404);
    expect((await api(['reach_settings:read'])('/api/reach/domains')).status).toBe(403);
  });

  it('refreshes the DNS health from what Mailpool wrote and what resolves', async () => {
    stubs.world.domainDns = [
      { type: 'MX', key: '@', value: 'mx1.mailpool.test', priority: 10 },
      { type: 'TXT', key: '@', value: 'v=spf1 include:_spf.mailpool.test ~all' },
      { type: 'TXT', key: 'mp1._domainkey', value: 'v=DKIM1; k=rsa; p=ABC' },
      { type: 'TXT', key: '_dmarc', value: 'v=DMARC1; p=quarantine' },
    ];
    stubs.world.dns['getacme.com MX'] = ['mx1.mailpool.test'];
    stubs.world.dns['getacme.com TXT'] = ['v=spf1 include:_spf.mailpool.test ~all'];
    stubs.world.dns['_dmarc.getacme.com TXT'] = ['v=DMARC1; p=quarantine'];
    stubs.world.dns['mp1._domainkey.getacme.com TXT'] = ['v=DKIM1; k=rsa; p=ABC'];
    const res = await api()('/api/reach/domains/rdom_1/refresh-dns', { method: 'POST' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { dnsStatus: Record<string, unknown>; dmarcPolicy: string } };
    expect(data.dnsStatus).toMatchObject({ spf: true, dkim: true, dmarc: true, mx: true });
    expect(data.dmarcPolicy).toBe('quarantine');
  });

  it('marks a domain Mailpool disabled, and answers 503 when DNS fails', async () => {
    stubs.world.remoteDomainStatus = 'inactive';
    const res = await api()('/api/reach/domains/rdom_1/refresh-dns', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string; lastError: string } }).data).toMatchObject({ status: 'error', lastError: 'Domain suspended' });
    stubs.world.dns['getacme.com TXT'] = null;
    expect((await api()('/api/reach/domains/rdom_1/refresh-dns', { method: 'POST' })).status).toBe(503);
    expect((await api(['reach_mailboxes:read'])('/api/reach/domains/rdom_1/refresh-dns', { method: 'POST' })).status).toBe(403);
  });

  it('refuses to disconnect a domain that still has mailboxes', async () => {
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });
    const res = await api()('/api/reach/domains/rdom_1', { method: 'DELETE' });
    expect(res.status).toBe(409);
  });

  it('disconnects: Mailpool, the route and the row', async () => {
    const res = await api()('/api/reach/domains/rdom_1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [route] = await masterDb.select().from(masterSchema.reachRoutes);
    expect(route?.status).toBe('deleted');
    expect((await api()('/api/reach/domains/rdom_1', { method: 'DELETE' })).status).toBe(404);
    expect((await api(['reach_mailboxes:read'])('/api/reach/domains/rdom_1', { method: 'DELETE' })).status).toBe(403);
  });

  it('keeps the domain when Mailpool refuses the delete', async () => {
    stubs.world.refusals['DELETE /domains/5001'] = { status: 400, body: { message: 'Cannot delete' } };
    expect((await api()('/api/reach/domains/rdom_1', { method: 'DELETE' })).status).toBe(502);
    expect((await api()('/api/reach/domains/rdom_1')).status).toBe(200);
  });
});
