/**
 * /api/helpcenter-settings on pglite, refusals included: the singleton
 * settings (defaults, insert, update), enabling the help center on its
 * `{slug}.welddesk.org` subdomain (master `helpcenter_domain_registry`),
 * the WeldHost domains eligible for a custom domain, and the list of custom
 * domains.
 *
 * Attaching, verifying and removing a custom domain (Cloudflare, Vercel)
 * are in domains.test.ts: the Rust backend does not serve them, so they are
 * not in the conformance suite this file belongs to.
 *
 * Nothing is mocked but `getMasterDb` (through `conformanceMasterDb`), so
 * the conformance suite runs these against Rust too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let db: Database;

const at = (second: number) => new Date(Date.UTC(2026, 1, 1, 9, 0, second));

function app(keys: string[], orgId: string = ORG) {
  return createTestApp(BASE, helpcenterSettingsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, masterDb: master, orgId },
  });
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const READ = () => app(['settings:read']);
const UPDATE = () => app(['settings:update', 'settings:read']);

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

describe('GET /api/helpcenter-settings/domains', () => {
  beforeAll(async () => {
    const settingsId = (await liveSettings()).id;
    const row = (id: string, n: number, domain: string, overrides: Partial<typeof helpcenterDomains.$inferInsert> = {}) => ({
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
    await db.insert(helpcenterDomains).values([
      row('hcd_live', 40, 'help.live.test', { isVerified: 1, isActive: 1, verifiedAt: at(41), dnsStatus: 'active', sslStatus: 'provisioning' }),
      row('hcd_pending', 42, 'docs.pending.test'),
      row('hcd_gone', 44, 'help.gone.test', { deletedAt: at(45) }),
    ]);
  });

  it('needs settings:read', async () => {
    expect((await app(['settings:update']).request(`${BASE}/domains`)).status).toBe(403);
  });

  it('lists the live domains', async () => {
    const res = await READ().request(`${BASE}/domains`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; createdAt: string; verifiedAt: string | null }> };
    expect(data.map((d) => d.id).sort()).toEqual(['hcd_live', 'hcd_pending']);
    expect(data.find((d) => d.id === 'hcd_live')).toMatchObject({
      createdAt: at(40).toISOString(),
      verifiedAt: at(41).toISOString(),
      dnsConfig: [{ type: 'CNAME', name: 'help.live.test', value: 'cname.vercel-dns.com' }],
    });
    expect(data.find((d) => d.id === 'hcd_pending')).toMatchObject({ verifiedAt: null, isVerified: 0, dnsStatus: 'pending' });
  });
});
