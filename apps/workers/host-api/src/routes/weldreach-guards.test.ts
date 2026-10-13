/**
 * WeldReach hooks in WeldHost, against a real (pglite) tenant database:
 * the "Used by WeldReach" flag, the 409 guards on delete / auth code /
 * nameserver changes / outgoing transfers, and the read-only mail records.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { __setZonesFetchForTests } from '@weldsuite/cloudflare-zones';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Hono } from 'hono';
import { dnsRecordsRoutes } from './dns-records';
import { dnsZonesRoutes } from './dns-zones';
import { domainTransfersRoutes } from './domain-transfers';
import { domainsRoutes } from './domains';
import type { Env, Variables } from '../types';

const { hostDomains, hostDnsZones, hostDnsRecords, reachDomains, hostDomainTransfers } = schema;

let db: Database;

// A connected domain, one that is plain WeldHost, and one whose disconnect is under way.
const CONNECTED = { id: 'dom_wr_connected', name: 'getacme.com', zone: 'zone_wr_connected' };
const PLAIN = { id: 'dom_wr_plain', name: 'plain-site.com', zone: 'zone_wr_plain' };
const LEAVING = { id: 'dom_wr_leaving', name: 'leaving-acme.com', zone: 'zone_wr_leaving' };
// Deleted by a test, so no other test depends on it.
const DEPARTING = { id: 'dom_wr_departing', name: 'departing-acme.com', zone: 'zone_wr_departing' };

const rec = {
  mx: 'dnsrec_wr_mx',
  spf: 'dnsrec_wr_spf',
  dkim: 'dnsrec_wr_dkim',
  dmarc: 'dnsrec_wr_dmarc',
  verification: 'dnsrec_wr_verify',
  www: 'dnsrec_wr_www',
  lockMe: 'dnsrec_wr_lock_me',
  plainMx: 'dnsrec_wr_plain_mx',
  plainSpf: 'dnsrec_wr_plain_spf',
  leavingMx: 'dnsrec_wr_leaving_mx',
};

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();

  await db.insert(hostDomains).values(
    [CONNECTED, PLAIN, LEAVING, DEPARTING].map((d, index) => ({
      id: d.id,
      name: d.name.split('.')[0]!,
      tld: 'com',
      fullDomain: d.name,
      status: 'active' as const,
      registrar: index === 1 ? 'GoDaddy' : 'realtimeregister',
      nameservers: ['ns1.weldhost.com', 'ns2.weldhost.com'],
      customNameservers: false,
      createdAt: now,
      updatedAt: now,
    })),
  );

  await db.insert(hostDnsZones).values(
    [CONNECTED, PLAIN, LEAVING, DEPARTING].map((d, index) => ({
      id: d.zone,
      domainId: d.id,
      name: d.name,
      status: 'active' as const,
      provider: 'cloudflare' as const,
      externalZoneId: `cfz_${index}`,
      externalNameservers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'],
      // synced, so listing the records does not go to Cloudflare to refresh them
      syncedAt: now,
    })),
  );

  const record = (
    id: string,
    zoneId: string,
    type: 'MX' | 'TXT' | 'A',
    name: string,
    value: string,
    externalRecordId: string | null,
  ) => ({ id, zoneId, type, name, value, externalRecordId, status: 'active' as const });

  await db.insert(hostDnsRecords).values([
    { ...record(rec.mx, CONNECTED.zone, 'MX', CONNECTED.name, 'mx.mailpool.io', 'cf_mx'), priority: 10 },
    record(rec.spf, CONNECTED.zone, 'TXT', CONNECTED.name, '"v=spf1 include:mailpool.io ~all"', 'cf_spf'),
    record(rec.dkim, CONNECTED.zone, 'TXT', `mailpool._domainkey.${CONNECTED.name}`, 'v=DKIM1; k=rsa; p=abc', 'cf_dkim'),
    record(rec.dmarc, CONNECTED.zone, 'TXT', `_dmarc.${CONNECTED.name}`, 'v=DMARC1; p=none', 'cf_dmarc'),
    record(rec.verification, CONNECTED.zone, 'TXT', CONNECTED.name, 'google-site-verification=abc', 'cf_verify'),
    // no Cloudflare id: stands in for "the guard let it through" without calling Cloudflare
    record(rec.www, CONNECTED.zone, 'A', `www.${CONNECTED.name}`, '203.0.113.7', null),
    record(rec.lockMe, CONNECTED.zone, 'A', `app.${CONNECTED.name}`, '203.0.113.9', null),
    { ...record(rec.plainMx, PLAIN.zone, 'MX', PLAIN.name, 'mx.example.net', null), priority: 10 },
    record(rec.plainSpf, PLAIN.zone, 'TXT', PLAIN.name, 'v=spf1 -all', null),
    { ...record(rec.leavingMx, LEAVING.zone, 'MX', LEAVING.name, 'mx.mailpool.io', null), priority: 10 },
  ]);

  await db.insert(reachDomains).values([
    { id: 'rdom_wr_connected', hostDomainId: CONNECTED.id, name: CONNECTED.name, status: 'active' },
    { id: 'rdom_wr_leaving', hostDomainId: LEAVING.id, name: LEAVING.name, status: 'disconnecting' },
    { id: 'rdom_wr_departing', hostDomainId: DEPARTING.id, name: DEPARTING.name, status: 'disconnecting' },
  ]);
}, 60_000);

// Nothing in this file may reach the real Cloudflare API: by default it answers 403 at once.
beforeEach(() => {
  stubCloudflare();
});

afterEach(() => {
  __setZonesFetchForTests(undefined);
  vi.restoreAllMocks();
});

type Routes = Hono<{ Bindings: Env; Variables: Variables }>;

function api(base: string, routes: Routes, ...keys: string[]) {
  return createTestApp(base, routes, {
    context: { permissions: permissions(...(keys.length ? keys : ['*'])), tenantDb: db },
    // the DNS record routes refuse to start without a Cloudflare token
    env: { CLOUDFLARE_API_TOKEN: 'cf_test_token' },
  });
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/**
 * Every Cloudflare call of the DNS client goes through this spy (the SDK keeps
 * its own fetch, so patching globalThis.fetch would not reach it) and is
 * answered with a quick 403. A request the guards refuse must never reach it.
 */
function stubCloudflare() {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'blocked in test' }], result: null }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
  );
  __setZonesFetchForTests(spy as unknown as Parameters<typeof __setZonesFetchForTests>[0]);
  return spy;
}

const IN_USE = {
  error: { code: 'DOMAIN_IN_USE_BY_WELDREACH', message: 'Disconnect this domain in WeldReach first.' },
};

// ---------------------------------------------------------------------------
// Domains: the flag
// ---------------------------------------------------------------------------

describe('domains: usedByWeldReach', () => {
  it('flags connected domains on the list, and only those', async () => {
    const res = await api('/api/domains', domainsRoutes).request('/api/domains?page=1&pageSize=100');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { domains: Array<{ id: string; usedByWeldReach: boolean }> };
    const byId = new Map(body.domains.map((d) => [d.id, d.usedByWeldReach]));
    expect(byId.get(CONNECTED.id)).toBe(true);
    expect(byId.get(PLAIN.id)).toBe(false);
    // a domain on its way out of WeldReach is not "used" any more
    expect(byId.get(LEAVING.id)).toBe(false);
  });

  it('keeps the rest of the list response as it was', async () => {
    const res = await api('/api/domains', domainsRoutes).request('/api/domains?page=1&pageSize=100');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('pagination');
    expect(body).toHaveProperty('stats');
  });

  it('flags the domain on its detail', async () => {
    const { request } = api('/api/domains', domainsRoutes);

    const connected = (await (await request(`/api/domains/${CONNECTED.id}`)).json()) as {
      data: { usedByWeldReach: boolean; fullDomain: string; dnsZone: { id: string } | null };
    };
    expect(connected.data.usedByWeldReach).toBe(true);
    expect(connected.data.fullDomain).toBe(CONNECTED.name);
    expect(connected.data.dnsZone?.id).toBe(CONNECTED.zone);

    const plain = (await (await request(`/api/domains/${PLAIN.id}`)).json()) as { data: { usedByWeldReach: boolean } };
    expect(plain.data.usedByWeldReach).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Domains: guards
// ---------------------------------------------------------------------------

describe('domains: blocked while connected', () => {
  it('refuses to delete a connected domain', async () => {
    const res = await api('/api/domains', domainsRoutes).request(`/api/domains/${CONNECTED.id}`, send('DELETE'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(IN_USE);
    const [row] = await db.select().from(hostDomains).where(eq(hostDomains.id, CONNECTED.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('refuses to issue an auth code (transfer out) for a connected domain', async () => {
    const res = await api('/api/domains', domainsRoutes).request(`/api/domains/${CONNECTED.id}/auth-code`, json({}));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(IN_USE);
  });

  it('refuses a nameserver change', async () => {
    const { request } = api('/api/domains', domainsRoutes);

    const changed = await request(
      `/api/domains/${CONNECTED.id}`,
      send('PATCH', { nameservers: ['ns1.elsewhere.net', 'ns2.elsewhere.net'] }),
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual(IN_USE);

    const custom = await request(`/api/domains/${CONNECTED.id}`, send('PATCH', { customNameservers: true }));
    expect(custom.status).toBe(409);

    const [row] = await db.select().from(hostDomains).where(eq(hostDomains.id, CONNECTED.id));
    expect(row?.nameservers).toEqual(['ns1.weldhost.com', 'ns2.weldhost.com']);
    expect(row?.customNameservers).toBe(false);
  });

  it('still allows other edits, and a form that sends the nameservers back unchanged', async () => {
    const { request } = api('/api/domains', domainsRoutes);

    const notes = await request(`/api/domains/${CONNECTED.id}`, send('PATCH', { notes: 'outreach domain' }));
    expect(notes.status).toBe(200);

    const unchanged = await request(
      `/api/domains/${CONNECTED.id}`,
      send('PATCH', { nameservers: ['ns2.weldhost.com', 'ns1.weldhost.com'], customNameservers: false, notes: 'again' }),
    );
    expect(unchanged.status).toBe(200);
  });

  it('leaves a plain domain alone', async () => {
    const { request } = api('/api/domains', domainsRoutes);

    const patched = await request(`/api/domains/${PLAIN.id}`, send('PATCH', { nameservers: ['ns1.elsewhere.net'] }));
    expect(patched.status).toBe(200);

    // the registrar is not WeldHost's, so the auth code is refused for that reason, not with a 409
    const authCode = await request(`/api/domains/${PLAIN.id}/auth-code`, json({}));
    expect(authCode.status).toBe(400);
  });

  it('lets a domain that is being disconnected go', async () => {
    const res = await api('/api/domains', domainsRoutes).request(`/api/domains/${DEPARTING.id}`, send('DELETE'));
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Transfers out
// ---------------------------------------------------------------------------

describe('domain transfers: out of WeldHost', () => {
  const outgoing = (body: Record<string, unknown>) => json({ type: 'outgoing', ...body });

  it('refuses an outgoing transfer of a connected domain, by id or by name', async () => {
    const { request } = api('/api/domain-transfers', domainTransfersRoutes);

    const byId = await request('/api/domain-transfers', outgoing({ domainId: CONNECTED.id, domainName: CONNECTED.name }));
    expect(byId.status).toBe(409);
    expect(await byId.json()).toEqual(IN_USE);

    const byName = await request('/api/domain-transfers', outgoing({ domainName: CONNECTED.name.toUpperCase() }));
    expect(byName.status).toBe(409);

    expect(await db.select().from(hostDomainTransfers).where(eq(hostDomainTransfers.domainName, CONNECTED.name))).toEqual([]);
  });

  it('allows an outgoing transfer of a plain domain', async () => {
    const res = await api('/api/domain-transfers', domainTransfersRoutes).request(
      '/api/domain-transfers',
      outgoing({ domainId: PLAIN.id, domainName: PLAIN.name }),
    );
    expect(res.status).toBe(201);
  });

  it('is not about transfers into WeldHost', async () => {
    const res = await api('/api/domain-transfers', domainTransfersRoutes).request(
      '/api/domain-transfers',
      json({ type: 'incoming', domainName: CONNECTED.name }),
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// DNS zones
// ---------------------------------------------------------------------------

describe('dns zones: blocked while connected', () => {
  it('refuses to point the zone elsewhere or delete it', async () => {
    const { request } = api('/api/dns-zones', dnsZonesRoutes);

    const nameservers = await request(
      `/api/dns-zones/${CONNECTED.zone}`,
      send('PATCH', { externalNameservers: ['ns1.elsewhere.net'] }),
    );
    expect(nameservers.status).toBe(409);
    expect(await nameservers.json()).toEqual(IN_USE);

    const provider = await request(`/api/dns-zones/${CONNECTED.zone}`, send('PATCH', { provider: 'route53' }));
    expect(provider.status).toBe(409);

    const deleted = await request(`/api/dns-zones/${CONNECTED.zone}`, send('DELETE'));
    expect(deleted.status).toBe(409);
    const [zone] = await db.select().from(hostDnsZones).where(eq(hostDnsZones.id, CONNECTED.zone));
    expect(zone?.deletedAt).toBeNull();
  });

  it('allows other zone edits and zones of other domains', async () => {
    const { request } = api('/api/dns-zones', dnsZonesRoutes);

    expect((await request(`/api/dns-zones/${CONNECTED.zone}`, send('PATCH', { defaultTtl: 600 }))).status).toBe(200);
    expect(
      (await request(`/api/dns-zones/${PLAIN.zone}`, send('PATCH', { externalNameservers: ['ns1.elsewhere.net'] }))).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DNS records
// ---------------------------------------------------------------------------

interface ListedRecord {
  id: string;
  managedBy?: 'weldreach' | null;
}
const managedIds = (records: ListedRecord[]) =>
  records.filter((r) => r.managedBy === 'weldreach').map((r) => r.id).sort();

describe('dns records: marking', () => {
  it('marks the mail records of a connected domain on every list surface', async () => {
    const { request } = api('/api/dns-records', dnsRecordsRoutes);
    const expected = [rec.dkim, rec.dmarc, rec.mx, rec.spf].sort();

    const byDomain = (await (await request(`/api/dns-records/by-domain/${CONNECTED.id}`)).json()) as {
      data: { records: ListedRecord[] };
    };
    expect(managedIds(byDomain.data.records)).toEqual(expected);
    // every record carries the field, the others as null
    const verification = byDomain.data.records.find((r) => r.id === rec.verification);
    expect(verification).toHaveProperty('managedBy', null);
    expect(byDomain.data.records.find((r) => r.id === rec.www)).toHaveProperty('managedBy', null);

    const byZone = (await (await request(`/api/dns-records/by-zone/${CONNECTED.zone}`)).json()) as {
      data: { records: ListedRecord[] };
    };
    expect(managedIds(byZone.data.records)).toEqual(expected);

    const flat = (await (await request(`/api/dns-records?zoneId=${CONNECTED.zone}`)).json()) as {
      data: { records: ListedRecord[] };
    };
    expect(managedIds(flat.data.records)).toEqual(expected);
  });

  it('marks nothing for a plain domain or one that is being disconnected', async () => {
    const { request } = api('/api/dns-records', dnsRecordsRoutes);

    for (const domain of [PLAIN, LEAVING]) {
      const body = (await (await request(`/api/dns-records/by-domain/${domain.id}`)).json()) as {
        data: { records: ListedRecord[] };
      };
      expect(body.data.records.length).toBeGreaterThan(0);
      expect(managedIds(body.data.records)).toEqual([]);
    }
  });

  it('marks the records the lock endpoint returns too', async () => {
    const res = await api('/api/dns-records', dnsRecordsRoutes).request(
      `/api/dns-records/${rec.lockMe}/lock`,
      json({ locked: true, reason: 'mine' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { records: ListedRecord[] } };
    expect(managedIds(body.data.records)).toEqual([rec.dkim, rec.dmarc, rec.mx, rec.spf].sort());
  });
});

const MANAGED = {
  error: {
    code: 'DNS_RECORD_MANAGED_BY_WELDREACH',
    message: 'This record is managed by WeldReach. Disconnect the domain in WeldReach first.',
  },
};

describe('dns records: managed records are read-only', () => {
  it.each([
    ['MX', rec.mx, { type: 'MX', name: CONNECTED.name, value: 'mx.elsewhere.net', priority: 5 }],
    ['SPF', rec.spf, { type: 'TXT', name: CONNECTED.name, value: 'v=spf1 -all' }],
    ['DKIM', rec.dkim, { type: 'TXT', name: `mailpool._domainkey.${CONNECTED.name}`, value: 'v=DKIM1; p=other' }],
    ['DMARC', rec.dmarc, { type: 'TXT', name: `_dmarc.${CONNECTED.name}`, value: 'v=DMARC1; p=none' }],
  ])('refuses to update or delete the %s record', async (_label, id, body) => {
    const cloudflare = stubCloudflare();
    const { request } = api('/api/dns-records', dnsRecordsRoutes);

    const updated = await request(`/api/dns-records/${id}`, send('PATCH', body));
    expect(updated.status).toBe(409);
    expect(await updated.json()).toEqual(MANAGED);

    const deleted = await request(`/api/dns-records/${id}`, send('DELETE'));
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toEqual(MANAGED);

    expect(cloudflare).not.toHaveBeenCalled();
    const [row] = await db.select().from(hostDnsRecords).where(eq(hostDnsRecords.id, id));
    expect(row).toBeDefined();
  });

  it('refuses to turn another record into a second SPF', async () => {
    const cloudflare = stubCloudflare();
    const res = await api('/api/dns-records', dnsRecordsRoutes).request(
      `/api/dns-records/${rec.verification}`,
      send('PATCH', { type: 'TXT', name: CONNECTED.name, value: 'v=spf1 include:_spf.google.com ~all' }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(MANAGED);
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it('does not stop edits of the other records of a connected domain', async () => {
    // The record has no Cloudflare id, so the update ends at the 400 for that
    // instead of calling Cloudflare; what matters is that it got past the guard.
    const res = await api('/api/dns-records', dnsRecordsRoutes).request(
      `/api/dns-records/${rec.www}`,
      send('PATCH', { type: 'A', name: `www.${CONNECTED.name}`, value: '203.0.113.8' }),
    );
    expect(res.status).toBe(400);
  });

  it('does not stop the same records on a domain that is not connected', async () => {
    const { request } = api('/api/dns-records', dnsRecordsRoutes);

    const mx = await request(
      `/api/dns-records/${rec.plainMx}`,
      send('PATCH', { type: 'MX', name: PLAIN.name, value: 'mx.elsewhere.net', priority: 5 }),
    );
    expect(mx.status).toBe(400);

    const leaving = await request(
      `/api/dns-records/${rec.leavingMx}`,
      send('PATCH', { type: 'MX', name: LEAVING.name, value: 'mx.elsewhere.net', priority: 5 }),
    );
    expect(leaving.status).toBe(400);
  });
});

describe('dns records: a second SPF or DMARC', () => {
  const create = (domainId: string, body: Record<string, unknown>) =>
    api('/api/dns-records', dnsRecordsRoutes).request(`/api/dns-records/by-domain/${domainId}`, json(body));

  it.each([
    ['an SPF on the apex', { type: 'TXT', name: '@', value: 'v=spf1 include:_spf.google.com ~all' }],
    ['an SPF written with the domain name', { type: 'TXT', name: CONNECTED.name, value: '"v=spf1 -all"' }],
    ['a DMARC', { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=reject' }],
  ])('refuses to add %s while the domain is connected', async (_label, body) => {
    const cloudflare = stubCloudflare();
    const res = await create(CONNECTED.id, body);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(MANAGED);
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it('allows other records on a connected domain, and the same SPF on a plain one', async () => {
    // Cloudflare refuses everything in the test, so a request that got past the guard answers with its error.
    const cloudflare = stubCloudflare();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const verification = await create(CONNECTED.id, { type: 'TXT', name: '@', value: 'google-site-verification=xyz' });
    expect(verification.status).not.toBe(409);

    const selector = await create(CONNECTED.id, {
      type: 'TXT',
      name: `s2._domainkey.${CONNECTED.name}`,
      value: 'v=DKIM1; p=abc',
    });
    expect(selector.status).not.toBe(409);

    const plain = await create(PLAIN.id, { type: 'TXT', name: '@', value: 'v=spf1 -all' });
    expect(plain.status).not.toBe(409);

    // all three got as far as Cloudflare
    expect(cloudflare).toHaveBeenCalled();
  });
});
