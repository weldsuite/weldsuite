/**
 * Every host-api route that needs no provider, on a real (pglite) tenant
 * database: the dashboard, lists and reads, creates, updates and deletes of
 * domains, DNS zones, email forwards and domain transfers, the DNS record
 * routes up to where they would call Cloudflare, and every refusal (404,
 * 400, 409, 423, the 503s and 500s of an unconfigured registrar, Stripe or
 * Cloudflare). The provider paths are in host-providers.integration.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Hono } from 'hono';
import { dnsRecordsRoutes } from './dns-records';
import { dnsZonesRoutes } from './dns-zones';
import { domainTransfersRoutes } from './domain-transfers';
import { domainsRoutes } from './domains';
import { emailForwardsRoutes } from './email-forwards';
import type { Env, Variables } from '../types';

const { hostDomains, hostDnsZones, hostDnsRecords, hostEmailForwards, hostDomainTransfers } = schema;

let db: Database;

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY);

const D = {
  active: 'dom_hr_active',
  expired: 'dom_hr_expired',
  unpaid: 'dom_hr_unpaid',
  cancelled: 'dom_hr_cancelled',
  cf: 'dom_hr_cf',
  rtr: 'dom_hr_rtr',
  ext: 'dom_hr_ext',
  zoned: 'dom_hr_zoned',
  plainZone: 'dom_hr_plainzone',
  doomed: 'dom_hr_doomed',
  registering: 'dom_hr_registering',
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const base = (id: string, fullDomain: string) => ({
    id,
    name: fullDomain.split('.')[0]!,
    tld: fullDomain.split('.').slice(1).join('.'),
    fullDomain,
  });
  await db.insert(hostDomains).values([
    {
      ...base(D.active, 'alpha-site.com'),
      status: 'active',
      registrationStatus: 'registered',
      registrar: 'realtimeregister',
      expiresAt: at(10),
      registeredAt: at(-10),
      renewedAt: at(-5),
      autoRenew: true,
      sslEnabled: true,
      nameservers: ['ns1.weldhost.com'],
      createdAt: at(-30),
    },
    { ...base(D.expired, 'beta-site.net'), status: 'expired', registrar: 'GoDaddy', expiresAt: at(-20), createdAt: at(-29) },
    { ...base(D.unpaid, 'gamma-site.com'), status: 'pending', registrationStatus: 'pending_payment', createdAt: at(-28) },
    { ...base(D.cancelled, 'delta-site.com'), status: 'cancelled', registrationStatus: 'failed', metadata: { error: 'Card declined' }, createdAt: at(-27) },
    { ...base(D.cf, 'cf-legacy.com'), status: 'active', registrar: 'cloudflare', externalRegistrarId: 'cf-legacy.com', createdAt: at(-26) },
    { ...base(D.rtr, 'rtr-owned.com'), status: 'active', registrar: 'realtimeregister', externalRegistrarId: 'rtr-owned.com', createdAt: at(-25) },
    {
      ...base(D.ext, 'outside-site.org'),
      status: 'pending',
      registrar: 'Namecheap',
      nameserverVerificationPending: true,
      createdAt: at(-24),
    },
    { ...base(D.zoned, 'zoned-site.com'), status: 'active', registrar: 'realtimeregister', createdAt: at(-23) },
    { ...base(D.plainZone, 'hetzner-site.com'), status: 'active', registrar: 'External', createdAt: at(-22) },
    { ...base(D.doomed, 'doomed-site.com'), status: 'active', registrar: 'External', createdAt: at(-21) },
    {
      ...base(D.registering, 'pending-reg.com'),
      status: 'pending',
      registrationStatus: 'pending_workflow',
      rtrProcessId: '1002',
      createdAt: at(-20),
    },
  ]);
  await db.insert(hostDnsZones).values([
    { id: 'zone_hr_cf', domainId: D.zoned, name: 'zoned-site.com', status: 'active', provider: 'cloudflare', externalZoneId: 'cfz_zoned', externalNameservers: ['ada.ns.cloudflare.com'], syncedAt: at(-1), createdAt: at(-5) },
    { id: 'zone_hr_hetzner', domainId: D.plainZone, name: 'hetzner-site.com', status: 'pending', provider: 'hetzner', createdAt: at(-4) },
    { id: 'zone_hr_doomed', domainId: D.doomed, name: 'doomed-site.com', status: 'active', provider: 'hetzner', createdAt: at(-3) },
  ]);
  await db.insert(hostDnsRecords).values([
    { id: 'dnsrec_hr_a', zoneId: 'zone_hr_cf', type: 'A', name: 'zoned-site.com', value: '203.0.113.5', externalRecordId: 'cfr_hr_a', status: 'active' },
    { id: 'dnsrec_hr_noext', zoneId: 'zone_hr_cf', type: 'A', name: 'www.zoned-site.com', value: '203.0.113.6', externalRecordId: null, status: 'active' },
    {
      id: 'dnsrec_hr_locked',
      zoneId: 'zone_hr_cf',
      type: 'TXT',
      name: 'zoned-site.com',
      value: 'v=spf1 -all',
      externalRecordId: 'cfr_hr_locked',
      status: 'active',
      metadata: { note: 'kept', locks: [{ source: 'weldmail', sourceId: 'md_1', purpose: 'spf', reason: 'Required by WeldMail (SPF)', lockedAt: '2026-01-01T00:00:00.000Z' }] },
    },
    { id: 'dnsrec_hr_hetzner', zoneId: 'zone_hr_hetzner', type: 'A', name: 'hetzner-site.com', value: '198.51.100.9', status: 'active' },
  ]);
  await db.insert(hostEmailForwards).values([
    { id: 'efwd_hr_1', domainId: D.active, source: 'info', destination: 'info@example.com', enabled: true, status: 'active', createdAt: at(-3) },
    { id: 'efwd_hr_2', domainId: D.active, source: 'sales', destination: 'sales@example.com', enabled: false, status: 'disabled', createdAt: at(-2) },
    { id: 'efwd_hr_3', domainId: D.expired, source: 'hello', destination: 'hello@example.com', enabled: true, status: 'pending', createdAt: at(-1) },
  ]);
  await db.insert(hostDomainTransfers).values([
    { id: 'txfr_hr_in', domainId: D.active, domainName: 'alpha-site.com', type: 'incoming', status: 'pending', createdAt: at(-3) },
    { id: 'txfr_hr_out', domainId: D.expired, domainName: 'beta-site.net', type: 'outgoing', status: 'in_progress', createdAt: at(-2) },
    { id: 'txfr_hr_fail', domainId: null, domainName: 'gone-site.com', type: 'incoming', status: 'pending', createdAt: at(-1) },
  ]);
}, 60_000);

type Routes = Hono<{ Bindings: Env; Variables: Variables }>;

function api(
  base: string,
  routes: Routes,
  opts: { keys?: string[]; env?: Record<string, unknown>; clerkOrgId?: string | null } = {},
) {
  return createTestApp(base, routes, {
    context: {
      permissions: permissions(...(opts.keys ?? ['*'])),
      tenantDb: db,
      ...(opts.clerkOrgId === undefined ? {} : { clerkOrgId: opts.clerkOrgId }),
    },
    env: { WORKSPACE_CACHE: createMemoryKv(), ...opts.env } as never,
  });
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const RTR_ENV = { REALTIME_REGISTER_API_KEY: 'rtr-key', REALTIME_REGISTER_CUSTOMER: 'weldsuite' };
const domains = (opts?: Parameters<typeof api>[2]) => api('/api/domains', domainsRoutes, opts).request;

// ---------------------------------------------------------------------------
// Domains: dashboard and lists
// ---------------------------------------------------------------------------

describe('domains: dashboard', () => {
  it('counts the listed domains only', async () => {
    const res = await domains()('/api/domains/dashboard');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, number> };
    expect(data.totalDomains).toBeGreaterThan(0);
    expect(data.expiringSoon).toBeGreaterThanOrEqual(1);
  });

  it('charts registrations, renewals and expirations per day', async () => {
    const request = domains();
    const res = await request('/api/domains/dashboard/chart?days=30');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ registrations: number; renewals: number; expirations: number }> };
    expect(data).toHaveLength(31);
    expect(data.reduce((n, p) => n + p.registrations, 0)).toBe(1);
    expect(data.reduce((n, p) => n + p.expirations, 0)).toBe(1);
    // a bad or zero value falls back to 90 days; the bounds are 1 and 365
    expect(((await (await request('/api/domains/dashboard/chart?days=zero')).json()) as { data: unknown[] }).data).toHaveLength(91);
    expect(((await (await request('/api/domains/dashboard/chart?days=0')).json()) as { data: unknown[] }).data).toHaveLength(91);
    expect(((await (await request('/api/domains/dashboard/chart?days=-4')).json()) as { data: unknown[] }).data).toHaveLength(2);
    expect(((await (await request('/api/domains/dashboard/chart?days=900')).json()) as { data: unknown[] }).data).toHaveLength(366);
  });

  it('lists the most recent domains', async () => {
    const request = domains();
    const res = await request('/api/domains/dashboard/recent?limit=3');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ registrar: string }> };
    expect(data).toHaveLength(3);
    expect((await request('/api/domains/dashboard/recent')).status).toBe(200);
  });

  it('needs domains:read', async () => {
    const res = await domains({ keys: ['dns:read'] })('/api/domains/dashboard');
    expect(res.status).toBe(403);
  });
});

describe('domains: list and detail', () => {
  it('pages, filters, searches and sorts', async () => {
    const request = domains();
    for (const query of [
      'page=1&pageSize=5',
      'page=2&pageSize=3&sortBy=fullDomain&sortOrder=asc',
      'sortBy=status&sortOrder=desc',
      'sortBy=expiresAt&sortOrder=asc',
      'sortBy=expiresAt',
      'status=active&sortBy=createdAt&sortOrder=asc',
      'status=all&search=site',
      'search=hetzner',
      'search=nothing-like-this',
    ]) {
      const res = await request(`/api/domains?${query}`);
      expect(res.status, query).toBe(200);
    }
    const body = (await (await request('/api/domains?search=alpha')).json()) as {
      domains: Array<{ id: string; registrar: string; usedByWeldReach: boolean }>;
      pagination: { total: number; totalPages: number };
    };
    expect(body.domains.map((d) => d.id)).toEqual([D.active]);
    expect(body.domains[0]!.registrar).toBe('WeldSuite');
    expect(body.pagination).toMatchObject({ total: 1, totalPages: 1 });
  });

  it('refuses a bad query', async () => {
    const request = domains();
    expect((await request('/api/domains?pageSize=0')).status).toBe(400);
    expect((await request('/api/domains?status=archived')).status).toBe(400);
    expect((await request('/api/domains?page=abc')).status).toBe(400);
  });

  it('reads a domain with its zone, and hides unpaid or failed ones', async () => {
    const request = domains();
    const zoned = (await (await request(`/api/domains/${D.zoned}`)).json()) as { data: { dnsZone: { id: string } } };
    expect(zoned.data.dnsZone.id).toBe('zone_hr_cf');
    const external = (await (await request(`/api/domains/${D.expired}`)).json()) as { data: { registrar: string; dnsZone: null } };
    expect(external.data).toMatchObject({ registrar: 'GoDaddy', dnsZone: null });
    expect((await request(`/api/domains/${D.unpaid}`)).status).toBe(404);
    expect((await request(`/api/domains/${D.cancelled}`)).status).toBe(404);
    expect((await request('/api/domains/dom_nope')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Domains: writes
// ---------------------------------------------------------------------------

describe('domains: create, update, delete', () => {
  it('creates a domain with the schema defaults', async () => {
    const request = domains();
    const res = await request('/api/domains', send('POST', { name: 'fresh', tld: 'io', fullDomain: 'fresh.io', registrar: 'Gandi', nameservers: ['a.ns.io'], notes: 'n' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { status: string; autoRenew: boolean; locked: boolean; registrar: string } };
    expect(data).toMatchObject({ status: 'pending', autoRenew: true, locked: true, registrar: 'Gandi' });
    const plain = await request('/api/domains', send('POST', { name: 'bare', tld: 'dev', fullDomain: 'bare.dev', status: 'active', locked: false }));
    expect(plain.status).toBe(201);
  });

  it('refuses an invalid domain', async () => {
    const request = domains();
    expect((await request('/api/domains', send('POST', { name: '', tld: 'io' }))).status).toBe(400);
    expect((await request('/api/domains', send('POST', { name: 'x', tld: 'io', fullDomain: 'x.io', status: 'gone' }))).status).toBe(400);
    expect((await request('/api/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' })).status).toBe(400);
  });

  it('updates every kind of field', async () => {
    const request = domains();
    const res = await request(
      `/api/domains/${D.plainZone}`,
      send('PATCH', {
        notes: 'moved',
        status: 'active',
        registrarStatus: 'ok',
        externalRegistrarId: null,
        registrarSyncedAt: '2026-03-04T05:06:07.123456Z',
        expiresAt: '2027-01-01T00:00:00Z',
        nameservers: ['ns1.example.com', 'ns2.example.com'],
        customNameservers: true,
        sslEnabled: true,
        emailForwardingEnabled: true,
        authCode: 'abc',
        authCodeExpiresAt: '2026-12-01T00:00:00.000Z',
        registrantContact: { firstName: 'Ada', country: 'NL' },
        adminContact: { email: 'a@example.com' },
        techContact: {},
        billingContact: { city: 'Delft' },
        metadata: { source: 'test', nested: { a: 1 } },
      }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { registrarSyncedAt: string; customNameservers: boolean } };
    expect(data.registrarSyncedAt).toBe('2026-03-04T05:06:07.123Z');
    expect(data.customNameservers).toBe(true);
  });

  it('refuses a bad update or an unknown domain', async () => {
    const request = domains();
    expect((await request(`/api/domains/${D.plainZone}`, send('PATCH', { expiresAt: 'tomorrow' }))).status).toBe(400);
    expect((await request(`/api/domains/${D.plainZone}`, send('PATCH', { metadata: ['x'] }))).status).toBe(400);
    expect((await request('/api/domains/dom_nope', send('PATCH', { notes: 'x' }))).status).toBe(404);
    expect((await request('/api/domains/dom_nope', send('PATCH', { nameservers: ['a.b'] }))).status).toBe(404);
  });

  it('deletes a domain once', async () => {
    const request = domains();
    expect((await request(`/api/domains/${D.doomed}`, send('DELETE'))).status).toBe(204);
    expect((await request(`/api/domains/${D.doomed}`, send('DELETE'))).status).toBe(404);
  });

  it('needs domains:create to create', async () => {
    const res = await domains({ keys: ['domains:read'] })('/api/domains', send('POST', { name: 'a', tld: 'b', fullDomain: 'a.b' }));
    expect(res.status).toBe(403);
  });
});

describe('domains: external domains', () => {
  it('adds one with its verification record, once', async () => {
    const request = domains();
    const res = await request('/api/domains/external', send('POST', { domain: '  Brand-New.Example  ', registrar: 'Gandi' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { fullDomain: string; status: string; registrar: string; verificationRecord: { name: string; type: string; value: string } };
    };
    expect(data).toMatchObject({ fullDomain: 'brand-new.example', status: 'pending', registrar: 'Gandi' });
    expect(data.verificationRecord.name).toBe('_weldhost-verify.brand-new.example');
    expect(data.verificationRecord.value).toMatch(/^weldhost-verify=[0-9a-f]{32}$/);
    const again = await request('/api/domains/external', send('POST', { domain: 'brand-new.example' }));
    expect(again.status).toBe(409);
  });

  it('defaults the registrar, and takes over a cancelled row', async () => {
    const res = await domains()('/api/domains/external', send('POST', { domain: 'delta-site.com', registrar: '' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { registrar: string } }).data.registrar).toBe('External');
  });

  it('refuses a name that is not a domain', async () => {
    const request = domains();
    for (const domain of ['no', 'nodot', '-bad.com', 'bad_char.com', 'a..b']) {
      expect((await request('/api/domains/external', send('POST', { domain }))).status, domain).toBe(400);
    }
    expect((await request('/api/domains/external', send('POST', { domain: 42 }))).status).toBe(400);
  });
});

describe('domains: checkout and renewal (billing is Stripe)', () => {
  it('validates the cart first', async () => {
    const request = domains({ env: RTR_ENV });
    for (const body of [
      {},
      { domain: '   ' },
      { domains: [] },
      { domain: 'ab' },
      { domains: ['ok-name.com'], years: 2 },
      { domains: ['ok-name.com'], years: 'abc' },
      { domains: ['ok-name.com'], contact: { firstName: 'A' } },
      { domains: ['ok-name.com'], contact: { firstName: 'A', lastName: 'B', email: 'bad', phone: '1', address1: 'x', city: 'y', postalCode: '1', country: 'NLD' } },
      { domains: ['x'.repeat(2), 'fine.com'] },
      { domains: Array.from({ length: 11 }, (_, i) => `name${i}.com`) },
      { domain: 5 },
    ]) {
      expect((await request('/api/domains/checkout', send('POST', body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('needs a workspace, then the registrar, then Stripe', async () => {
    const cart = { domains: ['shop-name.com'], stripePriceId: null };
    expect((await domains({ env: RTR_ENV, clerkOrgId: null })('/api/domains/checkout', send('POST', cart))).status).toBe(400);
    expect((await domains()('/api/domains/checkout', send('POST', cart))).status).toBe(503);
    const res = await domains({ env: RTR_ENV })('/api/domains/checkout', send('POST', { domain: 'shop-name.com', autoRenew: false }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Stripe is not configured');
  });

  it('renews only through Stripe', async () => {
    expect((await domains({ clerkOrgId: null })(`/api/domains/${D.rtr}/renew`, send('POST'))).status).toBe(400);
    expect((await domains()('/api/domains/dom_nope/renew', send('POST'))).status).toBe(404);
    expect((await domains()(`/api/domains/${D.cf}/renew`, send('POST'))).status).toBe(400);
    expect((await domains()(`/api/domains/${D.rtr}/renew`, send('POST'))).status).toBe(503);
    expect((await domains({ env: RTR_ENV })(`/api/domains/${D.rtr}/renew`, send('POST'))).status).toBe(500);
    expect((await domains()(`/api/domains/${D.expired}/renew`, send('POST'))).status).toBe(500);
  });

  it('abandons unpaid registrations only', async () => {
    const request = domains();
    const res = await request('/api/domains/checkout/abandon', send('POST', { registrationIds: [D.unpaid, D.cancelled, D.active, 'dom_nope'] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { abandoned: number } }).data.abandoned).toBe(2);
    const none = await request('/api/domains/checkout/abandon', send('POST', { registrationIds: ['dom_nope'] }));
    expect(((await none.json()) as { data: { abandoned: number } }).data.abandoned).toBe(0);
    expect((await request('/api/domains/checkout/abandon', send('POST', { registrationIds: [] }))).status).toBe(400);
  });
});

describe('domains: registrar actions without a registrar', () => {
  it('toggles an external domain locally', async () => {
    const request = domains();
    expect((await request(`/api/domains/${D.ext}/toggle-auto-renew`, send('POST', { enabled: false }))).status).toBe(200);
    expect((await request(`/api/domains/${D.ext}/toggle-privacy`, send('POST', { enabled: true }))).status).toBe(200);
    expect((await request(`/api/domains/${D.ext}/toggle-lock`, send('POST', { locked: false }))).status).toBe(200);
  });

  it('refuses an unknown domain or a bad body', async () => {
    const request = domains();
    expect((await request('/api/domains/dom_nope/toggle-auto-renew', send('POST', { enabled: true }))).status).toBe(404);
    expect((await request('/api/domains/dom_nope/toggle-privacy', send('POST', { enabled: true }))).status).toBe(404);
    expect((await request('/api/domains/dom_nope/toggle-lock', send('POST', { locked: true }))).status).toBe(404);
    expect((await request(`/api/domains/${D.ext}/toggle-lock`, send('POST', { locked: 'yes' }))).status).toBe(400);
  });

  it('fails when the registrar the domain is on is not configured', async () => {
    const request = domains();
    expect((await request(`/api/domains/${D.rtr}/toggle-auto-renew`, send('POST', { enabled: true }))).status).toBe(500);
    expect((await request(`/api/domains/${D.cf}/toggle-lock`, send('POST', { locked: true }))).status).toBe(500);
    // Cloudflare Registrar has no privacy API at all.
    expect((await request(`/api/domains/${D.cf}/toggle-privacy`, send('POST', { enabled: true }))).status).toBe(500);
  });

  it('marks a sync without registrar clients', async () => {
    const request = domains();
    const res = await request(`/api/domains/${D.ext}/sync`, send('POST'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe(D.ext);
    expect((await request('/api/domains/dom_nope/sync', send('POST'))).status).toBe(404);
  });

  it('refuses auth codes it cannot fetch', async () => {
    const request = domains();
    expect((await request(`/api/domains/${D.expired}/auth-code`, send('POST'))).status).toBe(400);
    expect((await request(`/api/domains/${D.cf}/auth-code`, send('POST'))).status).toBe(400);
    expect((await request(`/api/domains/${D.rtr}/auth-code`, send('POST'))).status).toBe(400);
    expect((await request('/api/domains/dom_nope/auth-code', send('POST'))).status).toBe(404);
  });

  it('answers 503 for search and availability without Realtime Register or ADAC', async () => {
    for (const env of [{}, RTR_ENV]) {
      const request = domains({ env });
      expect((await request('/api/domains/search?q=weld')).status).toBe(503);
      expect((await request('/api/domains/check', send('POST', { domains: ['weld.com'] }))).status).toBe(503);
    }
    const request = domains();
    expect((await request('/api/domains/search?q=w')).status).toBe(400);
    expect((await request('/api/domains/search?q=weld&limit=0')).status).toBe(400);
    expect((await request('/api/domains/check', send('POST', { domains: [] }))).status).toBe(400);
    expect((await request('/api/domains/check', send('POST', { domains: [''] }))).status).toBe(400);
  });
});

describe('domains: nameservers, ownership, zone status', () => {
  it('flags nameserver verification as pending', async () => {
    const request = domains();
    const res = await request(`/api/domains/${D.active}/verify-nameservers`, send('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, verified: false, currentNameservers: ['ns1.weldhost.com'] });
    const empty = (await (await request(`/api/domains/${D.expired}/verify-nameservers`, send('POST'))).json()) as { currentNameservers: string[] };
    expect(empty.currentNameservers).toEqual([]);
    expect((await request('/api/domains/dom_nope/verify-nameservers', send('POST'))).status).toBe(404);
  });

  it('answers a zone already on Cloudflare without a lookup', async () => {
    const request = domains();
    const res = await request(`/api/domains/${D.zoned}/verify-ownership`, send('POST'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { nameservers: string[] } }).data.nameservers).toEqual(['ada.ns.cloudflare.com']);
  });

  it('refuses a domain without a verification token, or none at all', async () => {
    const request = domains();
    expect((await request(`/api/domains/${D.active}/verify-ownership`, send('POST'))).status).toBe(400);
    expect((await request('/api/domains/dom_nope/verify-ownership', send('POST'))).status).toBe(404);
  });

  it('needs a Cloudflare zone and token to refresh its status', async () => {
    const request = domains();
    expect((await request(`/api/domains/${D.active}/refresh-zone-status`, send('POST'))).status).toBe(400);
    expect((await request(`/api/domains/${D.plainZone}/refresh-zone-status`, send('POST'))).status).toBe(400);
    expect((await request(`/api/domains/${D.zoned}/refresh-zone-status`, send('POST'))).status).toBe(500);
    expect((await request('/api/domains/dom_nope/refresh-zone-status', send('POST'))).status).toBe(404);
  });
});

describe('domains: registrations', () => {
  it('reports the stored status without a registrar', async () => {
    const request = domains();
    const pending = (await (await request(`/api/domains/registrations/${D.registering}/status`)).json()) as { data: { status: string } };
    expect(pending.data.status).toBe('registering');
    const failed = (await (await request(`/api/domains/registrations/${D.cancelled}/status`)).json()) as {
      data: { status: string; failureReason: string };
    };
    expect(failed.data).toMatchObject({ status: 'failed', failureReason: 'Card declined' });
    expect((await request(`/api/domains/registrations/${D.active}/status`)).status).toBe(200);
    expect((await request('/api/domains/registrations/dom_nope/status')).status).toBe(404);
  });

  it('completes a registration', async () => {
    const request = domains();
    const res = await request(
      `/api/domains/registrations/${D.registering}/complete`,
      send('POST', { contactInfo: { firstName: 'Ada', lastName: 'Lovelace' } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { domain: { status: string } } }).data.domain.status).toBe('active');
    expect((await request(`/api/domains/registrations/${D.ext}/complete`, send('POST', {}))).status).toBe(200);
    expect((await request(`/api/domains/registrations/${D.ext}/complete`, send('POST', { contactInfo: 'x' }))).status).toBe(400);
    expect((await request('/api/domains/registrations/dom_nope/complete', send('POST', {}))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DNS zones
// ---------------------------------------------------------------------------

describe('dns zones', () => {
  const zones = (keys?: string[]) => api('/api/dns-zones', dnsZonesRoutes, { keys }).request;

  it('lists with filters and a cursor', async () => {
    const request = zones();
    const first = (await (await request('/api/dns-zones?limit=1')).json()) as { data: Array<{ id: string }>; pagination: { cursor: string; hasMore: boolean; totalCount: number } };
    expect(first.data).toHaveLength(1);
    expect(first.pagination.hasMore).toBe(true);
    const next = await request(`/api/dns-zones?limit=1&cursor=${first.pagination.cursor}`);
    expect(next.status).toBe(200);
    for (const query of [`domainId=${D.zoned}`, 'status=pending', 'cursor=zone_missing&status=active', 'cursor=zone_missing', 'limit=100']) {
      expect((await request(`/api/dns-zones?${query}`)).status, query).toBe(200);
    }
    expect((await request('/api/dns-zones?status=bogus')).status).toBe(400);
    expect((await request('/api/dns-zones?limit=500')).status).toBe(400);
  });

  it('reads a zone by id or domain', async () => {
    const request = zones();
    expect((await request('/api/dns-zones/zone_hr_cf')).status).toBe(200);
    expect((await request(`/api/dns-zones/by-domain/${D.plainZone}`)).status).toBe(200);
    expect((await request('/api/dns-zones/zone_nope')).status).toBe(404);
    expect((await request('/api/dns-zones/by-domain/dom_nope')).status).toBe(404);
  });

  it('creates, updates and deletes a zone', async () => {
    const request = zones();
    const created = await request('/api/dns-zones', send('POST', { domainId: D.ext, name: 'outside-site.org', externalZoneId: null, externalNameservers: ['ns.example'] }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string; provider: string; status: string; defaultTtl: number } };
    expect(data).toMatchObject({ provider: 'hetzner', status: 'pending', defaultTtl: 3600 });
    const updated = await request(`/api/dns-zones/${data.id}`, send('PATCH', { syncedAt: '2026-05-05T05:05:05Z', defaultTtl: 900, externalZoneId: 'z9', status: 'active' }));
    expect(updated.status).toBe(200);
    expect((await request(`/api/dns-zones/${data.id}`, send('DELETE'))).status).toBe(204);
    expect((await request(`/api/dns-zones/${data.id}`, send('DELETE'))).status).toBe(404);
    expect((await request(`/api/dns-zones/${data.id}`, send('PATCH', { name: 'x.org' }))).status).toBe(404);
  });

  it('refuses invalid zones', async () => {
    const request = zones();
    expect((await request('/api/dns-zones', send('POST', { name: 'x.org' }))).status).toBe(400);
    expect((await request('/api/dns-zones', send('POST', { domainId: D.ext, name: 'x.org', defaultTtl: 10 }))).status).toBe(400);
    expect((await request('/api/dns-zones/zone_hr_hetzner', send('PATCH', { provider: 'godaddy' }))).status).toBe(400);
    expect((await request('/api/dns-zones/zone_hr_hetzner', send('PATCH', { syncedAt: 'later' }))).status).toBe(400);
    expect((await zones(['dns:read'])('/api/dns-zones', send('POST', { domainId: D.ext, name: 'x.org' }))).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Email forwards
// ---------------------------------------------------------------------------

describe('email forwards', () => {
  const forwards = () => api('/api/email-forwards', emailForwardsRoutes).request;

  it('lists with filters and a cursor', async () => {
    const request = forwards();
    for (const query of ['', `domainId=${D.active}`, 'enabled=true', 'enabled=', 'status=pending', 'limit=1', 'limit=1&cursor=efwd_hr_3', 'cursor=efwd_missing&status=active']) {
      expect((await request(`/api/email-forwards?${query}`)).status, query).toBe(200);
    }
    expect((await request('/api/email-forwards?limit=0')).status).toBe(400);
  });

  it('creates, reads, updates and deletes a forward', async () => {
    const request = forwards();
    const created = await request(
      '/api/email-forwards',
      send('POST', { domainId: D.active, source: 'support', destination: 'help@example.com', additionalDestinations: ['b@example.com'] }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string; enabled: boolean; catchAll: boolean; status: string } };
    expect(data).toMatchObject({ enabled: true, catchAll: false, status: 'active' });
    expect((await request(`/api/email-forwards/${data.id}`)).status).toBe(200);
    const updated = await request(`/api/email-forwards/${data.id}`, send('PATCH', { enabled: false, status: 'disabled', wildcard: true, additionalDestinations: [] }));
    expect(updated.status).toBe(200);
    expect((await request(`/api/email-forwards/${data.id}`, send('DELETE'))).status).toBe(204);
    expect((await request(`/api/email-forwards/${data.id}`)).status).toBe(404);
    expect((await request(`/api/email-forwards/${data.id}`, send('PATCH', { source: 'x' }))).status).toBe(404);
    expect((await request(`/api/email-forwards/${data.id}`, send('DELETE'))).status).toBe(404);
  });

  it('refuses invalid forwards', async () => {
    const request = forwards();
    expect((await request('/api/email-forwards', send('POST', { domainId: D.active, source: 'x', destination: 'not-an-email' }))).status).toBe(400);
    expect((await request('/api/email-forwards', send('POST', { domainId: D.active, source: 'x', destination: 'a@b.co', additionalDestinations: ['nope'] }))).status).toBe(400);
    expect((await request('/api/email-forwards/efwd_hr_1', send('PATCH', { status: 'gone' }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Domain transfers
// ---------------------------------------------------------------------------

describe('domain transfers', () => {
  const transfers = (env?: Record<string, unknown>) => api('/api/domain-transfers', domainTransfersRoutes, { env }).request;

  it('lists with filters and a cursor, and reads one', async () => {
    const request = transfers();
    for (const query of ['', 'type=incoming', 'status=pending', `domainId=${D.active}`, 'limit=1', 'limit=1&cursor=txfr_hr_fail', 'cursor=txfr_missing&type=outgoing', 'cursor=txfr_missing']) {
      expect((await request(`/api/domain-transfers?${query}`)).status, query).toBe(200);
    }
    expect((await request('/api/domain-transfers?type=sideways')).status).toBe(400);
    expect((await request('/api/domain-transfers/txfr_hr_in')).status).toBe(200);
    expect((await request('/api/domain-transfers/txfr_nope')).status).toBe(404);
  });

  it('records transfers without a registrar', async () => {
    const request = transfers();
    const outgoing = await request('/api/domain-transfers', send('POST', { domainId: D.expired, domainName: 'Beta-Site.net', type: 'outgoing', toRegistrar: 'Gandi' }));
    expect(outgoing.status).toBe(201);
    expect(((await outgoing.json()) as { data: { domainName: string } }).data.domainName).toBe('beta-site.net');
    const incoming = await request('/api/domain-transfers', send('POST', { domainName: 'coming-in.com', type: 'incoming', authCode: 'EPP' }));
    expect(incoming.status).toBe(201);
    expect(((await incoming.json()) as { data: { toRegistrar: string } }).data.toRegistrar).toBe('realtimeregister');
    expect((await request('/api/domain-transfers', send('POST', { domainName: '', type: 'incoming' }))).status).toBe(400);
    expect((await request('/api/domain-transfers', send('POST', { domainName: 'x.com', type: 'lateral' }))).status).toBe(400);
  });

  it('completes and fails transfers', async () => {
    const request = transfers();
    expect((await request('/api/domain-transfers/txfr_hr_out/complete', send('PATCH'))).status).toBe(200);
    expect((await request('/api/domain-transfers/txfr_nope/complete', send('PATCH'))).status).toBe(404);
    const failed = await request('/api/domain-transfers/txfr_hr_fail/fail', send('PATCH', { reason: 'Auth code rejected' }));
    expect(((await failed.json()) as { data: { failureReason: string } }).data.failureReason).toBe('Auth code rejected');
    const unknown = await request('/api/domain-transfers/txfr_hr_fail/fail', send('PATCH', {}));
    expect(((await unknown.json()) as { data: { failureReason: string } }).data.failureReason).toBe('Unknown error');
    expect((await request('/api/domain-transfers/txfr_nope/fail', send('PATCH', {}))).status).toBe(404);
    expect((await request('/api/domain-transfers/txfr_hr_fail/fail', send('PATCH', { reason: 'x'.repeat(2001) }))).status).toBe(400);
  });

  it('needs Realtime Register to sync', async () => {
    expect((await transfers()('/api/domain-transfers/txfr_hr_in/sync', send('PATCH'))).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// DNS records: everything short of Cloudflare
// ---------------------------------------------------------------------------

describe('dns records without Cloudflare', () => {
  const records = (env: Record<string, unknown> = {}, keys?: string[]) =>
    api('/api/dns-records', dnsRecordsRoutes, { env, keys }).request;
  const withToken = { CLOUDFLARE_API_TOKEN: 'cf-token' };

  it('lists the stored records of a zone', async () => {
    const request = records();
    const byZone = (await (await request('/api/dns-records/by-zone/zone_hr_hetzner')).json()) as { data: { records: unknown[]; zone: { id: string } } };
    expect(byZone.data.records).toHaveLength(1);
    expect((await request(`/api/dns-records/by-domain/${D.plainZone}`)).status).toBe(200);
    // a synced Cloudflare zone with records is read locally
    expect((await records(withToken)(`/api/dns-records/by-domain/${D.zoned}`)).status).toBe(200);
    const none = (await (await request(`/api/dns-records/by-domain/${D.expired}`)).json()) as { data: { records: unknown[]; zone: null } };
    expect(none.data).toEqual({ records: [], zone: null });
    expect((await request('/api/dns-records?zoneId=zone_hr_cf&type=A')).status).toBe(200);
    expect((await request('/api/dns-records')).status).toBe(400);
    expect((await request('/api/dns-records?type=MX')).status).toBe(400);
    expect((await request('/api/dns-records?zoneId=zone_hr_cf&type=NAPTR')).status).toBe(400);
    expect((await request('/api/dns-records?zoneId=zone_nope')).status).toBe(404);
    expect((await request('/api/dns-records/by-zone/zone_nope')).status).toBe(404);
    expect((await request('/api/dns-records/by-domain/dom_nope')).status).toBe(404);
  });

  it('refuses to sync, scan or import where Cloudflare is not set up', async () => {
    const request = records();
    expect((await request('/api/dns-records/by-zone/zone_hr_hetzner/sync', send('POST'))).status).toBe(400);
    expect((await request('/api/dns-records/by-zone/zone_hr_cf/sync', send('POST'))).status).toBe(500);
    expect((await request('/api/dns-records/by-zone/zone_nope/sync', send('POST'))).status).toBe(404);
    expect((await request(`/api/dns-records/by-domain/${D.plainZone}/scan`, send('POST'))).status).toBe(400);
    expect((await request('/api/dns-records/by-domain/dom_nope/scan', send('POST'))).status).toBe(404);
    const importBody = { records: [{ name: 'x.com', type: 'A', value: '1.2.3.4' }] };
    expect((await request(`/api/dns-records/by-domain/${D.zoned}/import`, send('POST', importBody))).status).toBe(500);
    const tokened = records(withToken);
    expect((await tokened(`/api/dns-records/by-domain/${D.plainZone}/import`, send('POST', importBody))).status).toBe(400);
    expect((await tokened('/api/dns-records/by-domain/dom_nope/import', send('POST', importBody))).status).toBe(404);
    expect((await tokened(`/api/dns-records/by-domain/${D.zoned}/import`, send('POST', { records: [] }))).status).toBe(400);
    expect((await tokened(`/api/dns-records/by-domain/${D.zoned}/import`, send('POST', { records: [{ name: 'x', type: 'NS', value: 'y' }] }))).status).toBe(400);
  });

  it('refuses record writes it cannot send', async () => {
    const request = records();
    const a = { type: 'A', name: 'api', value: '203.0.113.1', ttl: 300 };
    expect((await request(`/api/dns-records/by-domain/${D.plainZone}`, send('POST', a))).status).toBe(400);
    expect((await request(`/api/dns-records/by-domain/${D.zoned}`, send('POST', a))).status).toBe(500);
    expect((await request('/api/dns-records/by-domain/dom_nope', send('POST', a))).status).toBe(404);
    expect((await request(`/api/dns-records/by-domain/${D.zoned}`, send('POST', { ...a, ttl: 0 }))).status).toBe(400);
    expect((await request(`/api/dns-records/by-domain/${D.zoned}`, send('POST', { ...a, type: 'NAPTR' }))).status).toBe(400);
    expect((await request('/api/dns-records/dnsrec_hr_a', send('PATCH', a))).status).toBe(500);
    expect((await request('/api/dns-records/dnsrec_hr_a', send('DELETE'))).status).toBe(500);
    const tokened = records(withToken);
    expect((await tokened('/api/dns-records/dnsrec_nope', send('PATCH', a))).status).toBe(404);
    expect((await tokened('/api/dns-records/dnsrec_nope', send('DELETE'))).status).toBe(404);
    expect((await tokened('/api/dns-records/dnsrec_hr_hetzner', send('PATCH', a))).status).toBe(400);
    expect((await tokened('/api/dns-records/dnsrec_hr_hetzner', send('DELETE'))).status).toBe(400);
    expect((await tokened('/api/dns-records/dnsrec_hr_noext', send('PATCH', a))).status).toBe(400);
  });

  it('refuses locked records with their reasons', async () => {
    const tokened = records(withToken);
    const a = { type: 'TXT', name: '@', value: 'v=spf1 ~all' };
    const updated = await tokened('/api/dns-records/dnsrec_hr_locked', send('PATCH', a));
    expect(updated.status).toBe(423);
    expect(((await updated.json()) as { error: { message: string } }).error.message).toBe('Required by WeldMail (SPF)');
    expect((await tokened('/api/dns-records/dnsrec_hr_locked', send('DELETE'))).status).toBe(423);
  });

  it('locks and unlocks a record', async () => {
    const request = records();
    const locked = await request('/api/dns-records/dnsrec_hr_a/lock', send('POST', { locked: true, reason: '  ' }));
    expect(locked.status).toBe(200);
    const again = await request('/api/dns-records/dnsrec_hr_a/lock', send('POST', { locked: true, reason: 'Pinned for the launch' }));
    expect(again.status).toBe(200);
    expect((await request('/api/dns-records/dnsrec_hr_locked/lock', send('POST', { locked: false }))).status).toBe(200);
    expect((await request('/api/dns-records/dnsrec_hr_a/lock', send('POST', { locked: false }))).status).toBe(200);
    expect((await request('/api/dns-records/dnsrec_nope/lock', send('POST', { locked: true }))).status).toBe(404);
    expect((await request('/api/dns-records/dnsrec_hr_a/lock', send('POST', {}))).status).toBe(400);
  });

  it('needs the dns permissions', async () => {
    expect((await records({}, ['dns:read'])('/api/dns-records/dnsrec_hr_a/lock', send('POST', { locked: true }))).status).toBe(403);
  });
});
