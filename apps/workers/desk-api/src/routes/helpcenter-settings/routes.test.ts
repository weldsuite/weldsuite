/**
 * Every /api/helpcenter-settings route on pglite, refusals included: the
 * singleton settings (defaults, insert, update), enabling the help center on
 * its `{slug}.welddesk.org` subdomain (master `helpcenter_domain_registry`),
 * the WeldHost domains eligible for a custom domain, and the custom domains
 * themselves: every refusal of POST /domains that comes before Cloudflare and
 * Vercel, verification (DNS-over-HTTPS answered by a stubbed `fetch`), and
 * removal (KV cache entry included).
 *
 * Not reached: POST /domains past the "Cloudflare is not configured" check,
 * which needs CLOUDFLARE_API_TOKEN, a Vercel project and the Cloudflare zone
 * API, and the Cloudflare / Vercel teardown in DELETE /domains/:id, skipped
 * here because neither is configured.
 *
 * Nothing is mocked but `getMasterDb` (through `conformanceMasterDb`) and the
 * global `fetch`, so the conformance suite runs these against Rust too.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import { helpcenterSettingsRoutes } from './index';

const BASE = '/api/helpcenter-settings';
const WORKSPACE = 'ws_test_default';
const ORG = 'org_test_default';
const { helpcenterDomainRegistry, workspaces } = masterSchema;
const { helpcenterDomains, helpcenterSettings, hostDomains, hostDnsZones } = schema;

/** A KV namespace over a map; conformance mode shares it with the Rust server. */
class FakeKv {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let db: Database;
const kv = new FakeKv();

const at = (second: number) => new Date(Date.UTC(2026, 1, 1, 9, 0, second));

function app(keys: string[], orgId: string = ORG) {
  return createTestApp(BASE, helpcenterSettingsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, masterDb: master, orgId },
    env: { WORKSPACE_CACHE: kv as unknown as KVNamespace },
  });
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const READ = () => app(['settings:read']);
const UPDATE = () => app(['settings:update', 'settings:read']);
const CREATE = (orgId?: string) => app(['settings:create'], orgId);

async function registryRow(domain: string) {
  const [row] = await master.select().from(helpcenterDomainRegistry).where(eq(helpcenterDomainRegistry.domain, domain));
  return row as typeof helpcenterDomainRegistry.$inferSelect | undefined;
}

async function liveSettings() {
  const rows = (await db.select().from(helpcenterSettings)).filter((r) => r.deletedAt === null);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  db = (await createPgliteDb()).db;
  await master.insert(workspaces).values([
    { id: WORKSPACE, clerkOrgId: ORG, name: 'Acme', slug: 'acme' },
    { id: 'ws_shared', clerkOrgId: 'org_shared', name: 'Shared', slug: 'shared' },
    { id: 'ws_owner', clerkOrgId: 'org_owner', name: 'Owner', slug: 'owner' },
  ]);
  await master.insert(helpcenterDomainRegistry).values([
    // Someone else holds the subdomain org_shared's slug maps to.
    { id: 'hcreg_shared', domain: 'shared.welddesk.org', domainType: 'subdomain', workspaceId: 'ws_owner', createdAt: at(1), updatedAt: at(1) },
    { id: 'hcreg_taken', domain: 'help.ok.test', domainType: 'custom', workspaceId: 'ws_owner', createdAt: at(2), updatedAt: at(2) },
  ]);

  await db.insert(hostDomains).values([
    { id: 'hd_ok', name: 'ok', tld: 'test', fullDomain: 'ok.test', status: 'active', createdAt: at(1), updatedAt: at(1) },
    { id: 'hd_pending', name: 'pending', tld: 'test', fullDomain: 'pending.test', status: 'pending', createdAt: at(2), updatedAt: at(2) },
    { id: 'hd_hetzner', name: 'hetzner', tld: 'test', fullDomain: 'hetzner.test', status: 'active', createdAt: at(3), updatedAt: at(3) },
    { id: 'hd_nozone', name: 'nozone', tld: 'test', fullDomain: 'nozone.test', status: 'active', createdAt: at(4), updatedAt: at(4) },
    { id: 'hd_noid', name: 'noid', tld: 'test', fullDomain: 'noid.test', status: 'active', createdAt: at(5), updatedAt: at(5) },
    { id: 'hd_gone', name: 'gone', tld: 'test', fullDomain: 'gone.test', status: 'active', deletedAt: at(6), createdAt: at(6), updatedAt: at(6) },
  ]);
  await db.insert(hostDnsZones).values([
    { id: 'dz_ok', domainId: 'hd_ok', name: 'ok.test', provider: 'cloudflare', externalZoneId: 'cfzone_ok', status: 'active' },
    { id: 'dz_pending', domainId: 'hd_pending', name: 'pending.test', provider: 'cloudflare', externalZoneId: 'cfzone_pending' },
    { id: 'dz_hetzner', domainId: 'hd_hetzner', name: 'hetzner.test', provider: 'hetzner', externalZoneId: 'hz_1' },
    { id: 'dz_noid', domainId: 'hd_noid', name: 'noid.test', provider: 'cloudflare' },
    { id: 'dz_gone', domainId: 'hd_gone', name: 'gone.test', provider: 'cloudflare', externalZoneId: 'cfzone_gone' },
  ]);
}, 60_000);

describe('GET /api/helpcenter-settings', () => {
  it('needs settings:read', async () => {
    expect((await app(['settings:update']).request(BASE)).status).toBe(403);
  });

  it('answers the defaults before anything was saved', async () => {
    const res = await READ().request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        isEnabled: 0,
        siteName: null,
        logo: null,
        logoDark: null,
        favicon: null,
        primaryColor: null,
        accentColor: null,
        heroTitle: null,
        heroSubtitle: null,
        showSearch: 1,
        showCategories: 1,
        metaTitle: null,
        metaDescription: null,
        ogImage: null,
        footerText: null,
        socialLinks: null,
        customCss: null,
        googleAnalyticsId: null,
        defaultSubdomain: null,
        customDomain: null,
      },
    });
  });
});

describe('POST /api/helpcenter-settings/domains before the help center exists', () => {
  it('needs the help center enabled first', async () => {
    const res = await CREATE().request(`${BASE}/domains`, send('POST', { hostDomainId: 'hd_ok' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Help center must be enabled first' } });
  });
});

describe('PUT /api/helpcenter-settings', () => {
  it('needs settings:update', async () => {
    expect((await READ().request(BASE, send('PUT', { siteName: 'Docs' }))).status).toBe(403);
  });

  it('validates lengths, the 0/1 toggles and the social links', async () => {
    for (const body of [
      { siteName: 'x'.repeat(256) },
      { primaryColor: '#'.repeat(21) },
      { googleAnalyticsId: 'G'.repeat(51) },
      { showSearch: 2 },
      { showCategories: -1 },
      { socialLinks: { twitter: 5 } },
      { heroTitle: 7 },
    ]) {
      const res = await UPDATE().request(BASE, send('PUT', body));
      expect(res.status).toBe(400);
    }
  });

  it('creates the settings row on the first save', async () => {
    const res = await UPDATE().request(
      BASE,
      send('PUT', { siteName: 'Acme Help', primaryColor: '#112233', showSearch: 0, socialLinks: { twitter: 'https://x.test/acme' } }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      siteName: 'Acme Help',
      primaryColor: '#112233',
      showSearch: 0,
      showCategories: 1,
      isEnabled: 0,
      socialLinks: { twitter: 'https://x.test/acme' },
      heroTitle: null,
      deletedAt: null,
    });
    expect(data.id).toMatch(/^hcs_/);
  });

  it('updates it afterwards, null clearing a field', async () => {
    const before = await liveSettings();
    const res = await UPDATE().request(BASE, send('PUT', { siteName: null, heroTitle: 'Ask us', footerText: '(c) Acme' }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ id: before.id, siteName: null, heroTitle: 'Ask us', footerText: '(c) Acme', primaryColor: '#112233' });

    const read = await READ().request(BASE);
    expect(((await read.json()) as { data: Record<string, unknown> }).data).toMatchObject({ id: before.id, heroTitle: 'Ask us' });
  });
});

describe('POST /api/helpcenter-settings/enable', () => {
  it('needs settings:update', async () => {
    expect((await READ().request(`${BASE}/enable`, send('POST'))).status).toBe(403);
  });

  it('is a 404 for a workspace the master database does not know', async () => {
    const res = await app(['settings:update'], 'org_unknown').request(`${BASE}/enable`, send('POST'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
  });

  it("refuses a subdomain another workspace holds", async () => {
    const res = await app(['settings:update'], 'org_shared').request(`${BASE}/enable`, send('POST'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'This subdomain is already taken' } });
  });

  it('registers the subdomain and switches the existing settings on', async () => {
    const before = await liveSettings();
    const res = await UPDATE().request(`${BASE}/enable`, send('POST'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { domain: 'acme.welddesk.org', slug: 'acme', enabled: true } });
    expect(await registryRow('acme.welddesk.org')).toMatchObject({
      domainType: 'subdomain',
      workspaceId: WORKSPACE,
      isVerified: 1,
      isActive: 1,
    });
    expect(await liveSettings()).toMatchObject({ id: before.id, isEnabled: 1, defaultSubdomain: 'acme.welddesk.org', siteName: null });
  });

  it('reactivates its own registry entry', async () => {
    await master.update(helpcenterDomainRegistry).set({ isActive: 0 }).where(eq(helpcenterDomainRegistry.domain, 'acme.welddesk.org'));
    const res = await UPDATE().request(`${BASE}/enable`, send('POST'));
    expect(res.status).toBe(201);
    expect(await registryRow('acme.welddesk.org')).toMatchObject({ isActive: 1 });
    const all = await master.select().from(helpcenterDomainRegistry).where(eq(helpcenterDomainRegistry.domain, 'acme.welddesk.org'));
    expect(all).toHaveLength(1);
  });

  it('creates the settings with a starter hero when there are none', async () => {
    await db.update(helpcenterSettings).set({ deletedAt: at(30) });
    const res = await UPDATE().request(`${BASE}/enable`, send('POST'));
    expect(res.status).toBe(201);
    const created = await liveSettings();
    expect(created).toMatchObject({
      isEnabled: 1,
      defaultSubdomain: 'acme.welddesk.org',
      heroTitle: 'How can we help?',
      heroSubtitle: 'Search our knowledge base or browse categories below.',
      showSearch: 1,
      siteName: null,
    });
    expect(created.id).toMatch(/^hcs_/);
  });
});

describe('GET /api/helpcenter-settings/host-domains', () => {
  it('needs settings:read', async () => {
    expect((await app(['settings:update']).request(`${BASE}/host-domains`)).status).toBe(403);
  });

  it('lists only active WeldHost domains with a Cloudflare zone', async () => {
    const res = await READ().request(`${BASE}/host-domains`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'hd_ok', fullDomain: 'ok.test', hasZone: true }] });
  });
});

describe('POST /api/helpcenter-settings/domains', () => {
  it('needs settings:create', async () => {
    expect((await UPDATE().request(`${BASE}/domains`, send('POST', { hostDomainId: 'hd_ok' }))).status).toBe(403);
  });

  it('validates the WeldHost domain id and the subdomain label', async () => {
    for (const body of [
      {},
      { hostDomainId: '' },
      { hostDomainId: 'hd_ok', subdomain: 'bad_label' },
      { hostDomainId: 'hd_ok', subdomain: '-help' },
      { hostDomainId: 'hd_ok', subdomain: 'a'.repeat(64) },
      { domain: 'help.example.com' },
    ]) {
      const res = await CREATE().request(`${BASE}/domains`, send('POST', body));
      expect(res.status).toBe(400);
    }
  });

  it('is a 404 for a workspace the master database does not know', async () => {
    const res = await CREATE('org_unknown').request(`${BASE}/domains`, send('POST', { hostDomainId: 'hd_ok' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
  });

  it('is a 404 for an unknown or deleted WeldHost domain', async () => {
    for (const id of ['hd_missing', 'hd_gone']) {
      const res = await CREATE().request(`${BASE}/domains`, send('POST', { hostDomainId: id }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `WeldHost domain with ID '${id}' not found` } });
    }
  });

  it('refuses a domain that is not active yet', async () => {
    const res = await CREATE().request(`${BASE}/domains`, send('POST', { hostDomainId: 'hd_pending' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Domain is not active yet' } });
  });

  it('refuses a domain without a Cloudflare zone WeldSuite can write to', async () => {
    for (const id of ['hd_hetzner', 'hd_nozone', 'hd_noid']) {
      const res = await CREATE().request(`${BASE}/domains`, send('POST', { hostDomainId: id }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: 'This domain has no Cloudflare DNS zone WeldSuite can manage' },
      });
    }
  });

  it("refuses a hostname that is already registered ('help' by default, labels lower-cased)", async () => {
    for (const body of [{ hostDomainId: 'hd_ok' }, { hostDomainId: 'hd_ok', subdomain: 'HELP' }]) {
      const res = await CREATE().request(`${BASE}/domains`, send('POST', body));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'This domain is already registered' } });
    }
  });

  it('stops before provisioning when Cloudflare is not configured', async () => {
    const res = await CREATE().request(`${BASE}/domains`, send('POST', { hostDomainId: 'hd_ok', subdomain: 'docs' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Cloudflare is not configured' } });
    expect(await registryRow('docs.ok.test')).toBeUndefined();
  });
});

describe('custom domains: list, verify, delete', () => {
  const doh = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'cloudflare-dns.com') return Response.json({}, { status: 404 });
    const name = url.searchParams.get('name');
    if (name === 'docs.cname.test') {
      return Response.json({ Status: 0, Answer: [{ name, type: 5, TTL: 300, data: 'CNAME.Vercel-DNS.com.' }] });
    }
    if (name === 'help.wrong.test') {
      return Response.json({
        Status: 0,
        Answer: [
          { name, type: 1, TTL: 300, data: 'cname.vercel-dns.com' },
          { name, type: 5, TTL: 300, data: 'elsewhere.example.' },
        ],
      });
    }
    if (name === 'help.down.test') return new Response('unavailable', { status: 503 });
    return Response.json({ Status: 3 });
  });

  let settingsId: string;

  const domainRow = (id: string, n: number, domain: string, overrides: Partial<typeof helpcenterDomains.$inferInsert> = {}) => ({
    id,
    helpcenterSettingsId: settingsId,
    domain,
    subdomain: domain.split('.')[0],
    rootDomain: domain.split('.').slice(1).join('.'),
    domainType: 'custom',
    verificationMethod: 'dns_cname',
    verificationToken: `welddesk-verify-${id}`,
    dnsConfig: [{ type: 'CNAME', name: domain, value: 'cname.vercel-dns.com' }],
    createdAt: at(n),
    updatedAt: at(n),
    ...overrides,
  });

  beforeAll(async () => {
    vi.stubGlobal('fetch', doh);
    settingsId = (await liveSettings()).id;
    await db.insert(helpcenterDomains).values([
      domainRow('hcd_self', 40, 'help.self.test', {
        dnsConfig: [
          { type: 'CNAME', name: 'help.self.test', value: 'cname.vercel-dns.com', zoneId: 'cfzone_self', recordId: 'rec_self' },
        ] as unknown as Array<{ type: string; name: string; value: string }>,
      }),
      domainRow('hcd_cname', 41, 'docs.cname.test'),
      domainRow('hcd_wrong', 42, 'help.wrong.test', { isVerified: 1, isActive: 1, dnsStatus: 'active' }),
      domainRow('hcd_down', 43, 'help.down.test'),
      domainRow('hcd_gone', 44, 'help.gone.test', { deletedAt: at(45) }),
    ]);
    await master.insert(helpcenterDomainRegistry).values([
      { id: 'hcreg_self', domain: 'help.self.test', domainType: 'custom', workspaceId: WORKSPACE, isVerified: 0, isActive: 0, createdAt: at(40), updatedAt: at(40) },
      { id: 'hcreg_cname', domain: 'docs.cname.test', domainType: 'custom', workspaceId: WORKSPACE, isVerified: 0, isActive: 0, createdAt: at(41), updatedAt: at(41) },
      { id: 'hcreg_wrong', domain: 'help.wrong.test', domainType: 'custom', workspaceId: WORKSPACE, isVerified: 1, isActive: 1, createdAt: at(42), updatedAt: at(42) },
    ]);
    kv.store.set('hc:docs.cname.test', JSON.stringify({ workspaceId: WORKSPACE }));
    kv.store.set('hc:help.wrong.test', JSON.stringify({ workspaceId: WORKSPACE }));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('lists the live domains (settings:read)', async () => {
    expect((await app(['settings:update']).request(`${BASE}/domains`)).status).toBe(403);
    const res = await READ().request(`${BASE}/domains`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; createdAt: string; verifiedAt: string | null }> };
    expect(data.map((d) => d.id).sort()).toEqual(['hcd_cname', 'hcd_down', 'hcd_self', 'hcd_wrong']);
    expect(data.find((d) => d.id === 'hcd_self')).toMatchObject({ createdAt: at(40).toISOString(), verifiedAt: null });
  });

  it('verify needs settings:update and a live domain', async () => {
    expect((await READ().request(`${BASE}/domains/hcd_self/verify`, send('POST'))).status).toBe(403);
    for (const id of ['hcd_missing', 'hcd_gone']) {
      const res = await UPDATE().request(`${BASE}/domains/${id}/verify`, send('POST'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Domain with ID '${id}' not found` } });
    }
  });

  it('verifies a record WeldSuite created itself even before DNS answers', async () => {
    const res = await UPDATE().request(`${BASE}/domains/hcd_self/verify`, send('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { verified: true, domain: 'help.self.test' } });
    const [row] = await db.select().from(helpcenterDomains).where(eq(helpcenterDomains.id, 'hcd_self'));
    expect(row).toMatchObject({
      isVerified: 1,
      isActive: 1,
      verificationError: null,
      dnsStatus: 'active',
      sslStatus: 'provisioning',
    });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(row?.lastVerificationAttempt).toBeInstanceOf(Date);
    expect(await registryRow('help.self.test')).toMatchObject({ isVerified: 1, isActive: 1 });
    expect((await liveSettings()).customDomain).toBe('help.self.test');
  });

  it('verifies a CNAME that resolves to the help center host (case and trailing dot aside)', async () => {
    const res = await UPDATE().request(`${BASE}/domains/hcd_cname/verify`, send('POST'));
    expect(await res.json()).toEqual({ data: { verified: true, domain: 'docs.cname.test' } });
    expect(await registryRow('docs.cname.test')).toMatchObject({ isVerified: 1, isActive: 1 });
    expect((await liveSettings()).customDomain).toBe('docs.cname.test');
  });

  it('marks a CNAME that points elsewhere unverified, keeping the custom domain', async () => {
    const res = await UPDATE().request(`${BASE}/domains/hcd_wrong/verify`, send('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { verified: false, domain: 'help.wrong.test' } });
    const [row] = await db.select().from(helpcenterDomains).where(eq(helpcenterDomains.id, 'hcd_wrong'));
    expect(row).toMatchObject({
      isVerified: 0,
      isActive: 0,
      verifiedAt: null,
      verificationError: 'CNAME for help.wrong.test does not point to cname.vercel-dns.com yet',
      dnsStatus: 'pending',
      sslStatus: 'pending',
    });
    expect(await registryRow('help.wrong.test')).toMatchObject({ isVerified: 0, isActive: 0, verifiedAt: null });
    expect((await liveSettings()).customDomain).toBe('docs.cname.test');
  });

  it('treats a resolver that is down as not verified', async () => {
    const res = await UPDATE().request(`${BASE}/domains/hcd_down/verify`, send('POST'));
    expect(await res.json()).toEqual({ data: { verified: false, domain: 'help.down.test' } });
  });

  it('delete needs settings:delete and a live domain', async () => {
    expect((await UPDATE().request(`${BASE}/domains/hcd_cname`, send('DELETE'))).status).toBe(403);
    for (const id of ['hcd_missing', 'hcd_gone']) {
      const res = await app(['settings:delete']).request(`${BASE}/domains/${id}`, send('DELETE'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Domain with ID '${id}' not found` } });
    }
  });

  it('removes the custom domain: soft delete, registry entry, settings and cache', async () => {
    const res = await app(['settings:delete']).request(`${BASE}/domains/hcd_cname`, send('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'hcd_cname' } });
    const [row] = await db.select().from(helpcenterDomains).where(eq(helpcenterDomains.id, 'hcd_cname'));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await registryRow('docs.cname.test')).toBeUndefined();
    expect((await liveSettings()).customDomain).toBeNull();
    expect(kv.store.has('hc:docs.cname.test')).toBe(false);
  });

  it('removes a self-provisioned domain without touching Cloudflare when no token is set', async () => {
    const res = await app(['settings:delete']).request(`${BASE}/domains/hcd_self`, send('DELETE'));
    expect(res.status).toBe(200);
    expect(await registryRow('help.self.test')).toBeUndefined();
    const calls = doh.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    expect(calls.some((url) => url.includes('api.cloudflare.com') || url.includes('vercel.com'))).toBe(false);
  });

  it('no longer lists them', async () => {
    const res = await READ().request(`${BASE}/domains`);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((d) => d.id).sort()).toEqual(['hcd_down', 'hcd_wrong']);
    expect(kv.store.has('hc:help.wrong.test')).toBe(true);
  });
});
