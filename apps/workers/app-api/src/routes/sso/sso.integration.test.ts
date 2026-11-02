/**
 * /api/sso against a real pglite master DB, with Clerk unreachable and
 * DNS-over-HTTPS as a fetch stub: the permission gates, the entitlement, the
 * domain claim and its DNS proof, what a connection on file shows and which
 * changes then need Clerk, switching it off, and billing-worker unreachable.
 *
 * Conformance-ready (rust/conformance/suites.json). Clerk's SAML connections
 * are Global-only (ADR SEC-010): the Rust backend answers every Clerk step as
 * the workers do when Clerk cannot be reached, which is what this file sets
 * up. The DNS lookups reach the same stub from both backends (the outbound
 * bridge), and the entity events are compared. The flows that need Clerk to
 * answer (creating, activating and removing a connection) are in
 * index.test.ts, outside the suite.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => ({
  ...(await orig<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));
// Clerk cannot be reached: every SAML connection call fails without a status.
vi.mock('@clerk/backend', () => {
  const unreachable = async () => {
    throw new TypeError('fetch failed');
  };
  return {
    createClerkClient: () => ({
      samlConnections: {
        createSamlConnection: unreachable,
        getSamlConnection: unreachable,
        updateSamlConnection: unreachable,
        deleteSamlConnection: unreachable,
      },
    }),
  };
});
// Nor can billing-worker.
vi.mock('@weldsuite/worker-kit/billing-worker', () => ({
  callBillingWorker: async () => {
    throw new TypeError('fetch failed');
  },
}));

import { ssoRoutes } from './index';

const { plans, workspaces, workspaceSso } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let db: any;
let tenant: Database;
let seq = 0;

const BUSINESS = 'plan_ssoc_business';
const ENTERPRISE = 'plan_ssoc_enterprise';

/** TXT `data` by record name, as Cloudflare's resolver answers it; `failure` 0 makes `fetch` throw. */
const dns = { records: {} as Record<string, string[]>, failure: null as number | null };

function resolver(url: URL): Response {
  if (dns.failure === 0) throw new TypeError('fetch failed');
  if (dns.failure !== null) return new Response('upstream error', { status: dns.failure });
  const name = url.searchParams.get('name') ?? '';
  const found = dns.records[name];
  const body = found
    ? {
        Status: 0,
        Answer: [
          // Another record type on the name is not a TXT value.
          { name: `${name}.`, type: 5, TTL: 300, data: 'target.example.' },
          ...found.map((data) => ({ name: `${name}.`, type: 16, TTL: 300, data })),
        ],
      }
    : { Status: 3 };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/dns-json' } });
}

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
  tenant = (await createPgliteDb()).db;
  holder.master = db;
  await db.insert(plans).values([
    { id: BUSINESS, name: 'Business', slug: 'ssoc-business', pricePerUser: '49' },
    { id: ENTERPRISE, name: 'Enterprise', slug: 'ssoc-enterprise', pricePerUser: '99', features: { sso: true } },
  ]);
}, 180_000);

beforeEach(() => {
  dns.records = {};
  dns.failure = null;
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      // Anything but the resolver (the harness talking to the Rust server) goes out as usual.
      if (url.hostname !== 'cloudflare-dns.com') return realFetch(input, init);
      return resolver(url);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Ws {
  id: string;
  orgId: string;
}

async function seedWorkspace(planId = ENTERPRISE, extra: Partial<typeof workspaces.$inferInsert> = {}): Promise<Ws> {
  seq += 1;
  const id = `ws_ssoc_${seq}`;
  const orgId = `org_ssoc_${seq}`;
  await db.insert(workspaces).values({ id, clerkOrgId: orgId, name: `Acme ${seq}`, slug: `ssoc-${seq}`, planId, ...extra });
  return { id, orgId };
}

/** A workspace with a connection on file, as one set up in the Global edition left it. */
async function seedConnection(ws: Ws, row: Partial<typeof workspaceSso.$inferInsert> = {}): Promise<void> {
  await db.insert(workspaceSso).values({
    id: `wsso_ssoc_${seq}`,
    workspaceId: ws.id,
    clerkOrgId: ws.orgId,
    domain: `conn${seq}.example`,
    domainVerificationToken: 'a'.repeat(32),
    domainVerifiedAt: new Date('2026-10-01T10:00:00.000Z'),
    clerkConnectionId: `samlc_ssoc_${seq}`,
    provider: 'saml_okta',
    enabled: true,
    clerkActive: false,
    acsUrl: `https://clerk.example/v1/saml/acs/samlc_ssoc_${seq}`,
    spEntityId: `https://clerk.example/saml/samlc_ssoc_${seq}`,
    spMetadataUrl: null,
    connectionUpdatedBy: 'user_setup',
    connectionUpdatedAt: new Date('2026-10-02T10:00:00.000Z'),
    ...row,
  });
}

async function rowOf(ws: Ws) {
  const [row] = await db.select().from(workspaceSso).where(eq(workspaceSso.workspaceId, ws.id));
  return row as typeof workspaceSso.$inferSelect | undefined;
}

const MANAGER = permissions('sso:read', 'sso:manage');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read deep into the view
type Answer = { data?: any; error?: { code: string; message: string }; success?: boolean };

function api(ws: Ws, granted = MANAGER) {
  const { request } = createTestApp('/api/sso', ssoRoutes, {
    context: { tenantDb: tenant, masterDb: db, orgId: ws.orgId, workspaceId: ws.id, userId: 'user_admin', permissions: granted },
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await request(`/api/sso${path === '/' ? '' : path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Answer };
  };
}

/** Claim `domain` and publish its TXT record at the stub resolver; the record's value. */
async function claim(ws: Ws, domain: string): Promise<string> {
  const claimed = await api(ws)('PUT', '/domain', { domain });
  const value = claimed.json.data.domain.dnsRecord.value as string;
  dns.records[`_weldsuite-sso.${domain}`] = [`"${value}"`];
  return value;
}

describe('access', () => {
  it('needs sso:read to look and sso:manage to change', async () => {
    const ws = await seedWorkspace();
    expect((await api(ws, permissions('general:read'))('GET', '/')).status).toBe(403);

    const reader = api(ws, permissions('sso:read'));
    const view = await reader('GET', '/');
    expect(view.status).toBe(200);
    expect(view.json.data).toEqual({
      entitlement: { entitled: true, source: 'plan' },
      domain: null,
      connection: null,
      canManage: false,
    });
    expect((await reader('PUT', '/domain', { domain: 'acme.com' })).status).toBe(403);
    expect((await reader('POST', '/domain/verify')).status).toBe(403);
    expect((await reader('DELETE', '/connection')).status).toBe(403);
    expect((await reader('POST', '/connection/deactivate')).status).toBe(403);
  });

  it('is a 404 for an organization without a workspace', async () => {
    const { status, json } = await api({ id: 'ws_ssoc_missing', orgId: 'org_ssoc_missing' })('GET', '/');

    expect(status).toBe(404);
    expect(json).toEqual({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' } });
  });
});

describe('entitlement', () => {
  it('comes from the plan, a free staff grant or a live add-on', async () => {
    const ws = await seedWorkspace(BUSINESS);
    const call = api(ws);
    expect((await call('GET', '/')).json.data.entitlement).toEqual({ entitled: false, source: null });

    await claim(ws, 'grant.example');
    await db.update(workspaceSso).set({ priceOverrideCents: 0 }).where(eq(workspaceSso.workspaceId, ws.id));
    expect((await call('GET', '/')).json.data.entitlement).toEqual({ entitled: true, source: 'free' });

    await db
      .update(workspaceSso)
      .set({ priceOverrideCents: 5000, subscriptionStatus: 'past_due' })
      .where(eq(workspaceSso.workspaceId, ws.id));
    expect((await call('GET', '/')).json.data.entitlement).toEqual({ entitled: true, source: 'subscription' });

    await db.update(workspaceSso).set({ subscriptionStatus: 'unpaid' }).where(eq(workspaceSso.workspaceId, ws.id));
    expect((await call('GET', '/')).json.data.entitlement).toEqual({ entitled: false, source: null });
  });

  it('ends with the workspace, whatever the plan', async () => {
    const suspended = await seedWorkspace(ENTERPRISE, { isActive: false });
    expect((await api(suspended)('GET', '/')).json.data.entitlement).toEqual({ entitled: false, source: null });

    const deleted = await seedWorkspace(ENTERPRISE, { deletedAt: new Date('2026-10-20T08:00:00.000Z') });
    expect((await api(deleted)('GET', '/')).json.data.entitlement).toEqual({ entitled: false, source: null });
  });
});

describe('domain', () => {
  it('normalises what was typed and hands out the TXT record', async () => {
    const ws = await seedWorkspace();

    const { status, json } = await api(ws)('PUT', '/domain', { domain: ' https://www.Acme-Corp.com/login ' });

    expect(status).toBe(200);
    expect(json.data.domain).toMatchObject({ name: 'acme-corp.com', verified: false, verifiedAt: null });
    expect(json.data.domain.dnsRecord).toMatchObject({ type: 'TXT', name: '_weldsuite-sso.acme-corp.com' });
    expect(json.data.domain.dnsRecord.value).toMatch(/^weldsuite-sso-verification=[0-9a-f]{32}$/);
    expect(await rowOf(ws)).toMatchObject({ domain: 'acme-corp.com', connectionUpdatedBy: 'user_admin' });
  });

  it('keeps the token for the same domain, and starts over for another', async () => {
    const ws = await seedWorkspace();
    const call = api(ws);
    const first = await claim(ws, 'same.example');

    const again = await call('PUT', '/domain', { domain: 'jane@Same.example' });
    expect(again.json.data.domain.dnsRecord.value).toBe(first);

    await call('POST', '/domain/verify');
    const other = await call('PUT', '/domain', { domain: 'other-one.example' });
    expect(other.json.data.domain).toMatchObject({ name: 'other-one.example', verified: false });
    expect(other.json.data.domain.dnsRecord.value).not.toBe(first);
  });

  it('refuses junk, public mailbox domains and bodies without a domain', async () => {
    const call = api(await seedWorkspace());
    expect((await call('PUT', '/domain', { domain: 'localhost' })).json.error).toEqual({
      code: 'SSO_DOMAIN_INVALID',
      message: 'Enter a domain like acme.com.',
    });
    expect((await call('PUT', '/domain', { domain: '10.0.0.1' })).json.error?.code).toBe('SSO_DOMAIN_INVALID');
    expect((await call('PUT', '/domain', { domain: '-acme.com' })).json.error?.code).toBe('SSO_DOMAIN_INVALID');
    expect((await call('PUT', '/domain', { domain: 'Gmail.com' })).json.error).toEqual({
      code: 'SSO_DOMAIN_PUBLIC',
      message: 'Use your company domain, not a public email provider.',
    });

    const blank = await call('PUT', '/domain', { domain: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.json.success).toBe(false);
    expect((await call('PUT', '/domain', {})).status).toBe(400);
    expect((await call('PUT', '/domain', { domain: 42 })).status).toBe(400);
  });

  it('verifies only with the right TXT record', async () => {
    const ws = await seedWorkspace();
    const call = api(ws);
    const value = await claim(ws, 'verify.example');

    dns.records['_weldsuite-sso.verify.example'] = ['"v=spf1 -all"', '"weldsuite-sso-verification=wrong"'];
    const missing = await call('POST', '/domain/verify');
    expect(missing.status).toBe(422);
    expect(missing.json.error).toEqual({
      code: 'SSO_DOMAIN_NOT_VERIFIED',
      message: 'The TXT record was not found yet. DNS changes can take a while to show up; try again later.',
    });

    // A long record comes back in quoted chunks.
    const half = Math.floor(value.length / 2);
    dns.records['_weldsuite-sso.verify.example'] = [`"${value.slice(0, half)}" "${value.slice(half)}"`];
    const verified = await call('POST', '/domain/verify');
    expect(verified.status).toBe(200);
    expect(verified.json.data.domain).toMatchObject({ name: 'verify.example', verified: true });
    expect(verified.json.data.domain.verifiedAt).toEqual(expect.any(String));

    // Verified stays verified, without asking DNS again.
    dns.failure = 0;
    expect((await call('POST', '/domain/verify')).status).toBe(200);
  });

  it('a name without records is not verified yet', async () => {
    const ws = await seedWorkspace();
    await api(ws)('PUT', '/domain', { domain: 'nothing-yet.example' });

    const { status, json } = await api(ws)('POST', '/domain/verify');

    expect(status).toBe(422);
    expect(json.error?.code).toBe('SSO_DOMAIN_NOT_VERIFIED');
  });

  it('answers 502 when the DNS lookup fails', async () => {
    const ws = await seedWorkspace();
    await claim(ws, 'dns-down.example');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    dns.failure = 503;
    const refused = await api(ws)('POST', '/domain/verify');
    expect(refused.status).toBe(502);
    expect(refused.json.error).toEqual({
      code: 'SSO_DNS_LOOKUP_FAILED',
      message: 'The DNS lookup failed. Try again in a minute.',
    });

    dns.failure = 0;
    expect((await api(ws)('POST', '/domain/verify')).json.error?.code).toBe('SSO_DNS_LOOKUP_FAILED');
  });

  it('needs a domain to verify', async () => {
    const { status, json } = await api(await seedWorkspace())('POST', '/domain/verify');

    expect(status).toBe(409);
    expect(json.error).toEqual({ code: 'SSO_DOMAIN_MISSING', message: 'Add your domain first.' });
  });

  it('keeps a verified domain to one workspace', async () => {
    const owner = await seedWorkspace();
    const rival = await seedWorkspace();
    // Both publish their record; the owner proves it first.
    const rivalValue = await claim(rival, 'taken.example');
    const ownerValue = await claim(owner, 'taken.example');
    dns.records['_weldsuite-sso.taken.example'] = [`"${ownerValue}"`, `"${rivalValue}"`];
    expect((await api(owner)('POST', '/domain/verify')).status).toBe(200);

    const late = await api(rival)('POST', '/domain/verify');
    expect(late.status).toBe(409);
    expect(late.json.error).toEqual({
      code: 'SSO_DOMAIN_IN_USE',
      message: 'Another workspace already uses this domain for single sign-on.',
    });

    const newcomer = await api(await seedWorkspace())('PUT', '/domain', { domain: 'taken.example' });
    expect(newcomer.status).toBe(409);
    expect(newcomer.json.error?.code).toBe('SSO_DOMAIN_IN_USE');
  });

  it('removes the domain, and removing none is fine', async () => {
    const ws = await seedWorkspace();
    const call = api(ws);
    expect((await call('DELETE', '/domain')).json.data.domain).toBeNull();

    await claim(ws, 'removed.example');
    const removed = await call('DELETE', '/domain');
    expect(removed.status).toBe(200);
    expect(removed.json.data.domain).toBeNull();
    expect(await rowOf(ws)).toMatchObject({ domain: null, domainVerificationToken: null, domainVerifiedAt: null });
  });
});

describe('connection, with Clerk unreachable', () => {
  it('needs the workspace to be entitled and the domain verified before asking Clerk', async () => {
    const business = await seedWorkspace(BUSINESS);
    await claim(business, 'unpaid.example');
    await api(business)('POST', '/domain/verify');
    const unpaid = await api(business)('PUT', '/connection', { provider: 'saml_okta' });
    expect(unpaid.status).toBe(402);
    expect(unpaid.json.error).toEqual({ code: 'SSO_NOT_ENTITLED', message: 'Add single sign-on to your workspace first.' });

    const enterprise = await seedWorkspace();
    await api(enterprise)('PUT', '/domain', { domain: 'unverified.example' });
    const unverified = await api(enterprise)('PUT', '/connection', { provider: 'saml_okta' });
    expect(unverified.status).toBe(409);
    expect(unverified.json.error).toEqual({ code: 'SSO_DOMAIN_NOT_VERIFIED', message: 'Verify your domain first.' });
  });

  it('cannot create one without Clerk', async () => {
    const ws = await seedWorkspace();
    await claim(ws, 'no-clerk.example');
    await api(ws)('POST', '/domain/verify');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { status, json } = await api(ws)('PUT', '/connection', {
      provider: 'saml_okta',
      idpMetadataUrl: ' https://acme.okta.com/app/metadata ',
      idpCertificate: null,
    });

    expect(status).toBe(502);
    expect(json.error).toEqual({
      code: 'SSO_PROVIDER_UNAVAILABLE',
      message: 'Single sign-on could not be updated right now. Try again later.',
    });
    expect(await rowOf(ws)).toMatchObject({ clerkConnectionId: null });
  });

  it('validates the IdP details', async () => {
    const call = api(await seedWorkspace());
    const provider = await call('PUT', '/connection', { provider: 'saml_ping' });
    expect(provider.status).toBe(400);
    expect(provider.json.success).toBe(false);

    const insecure = await call('PUT', '/connection', { provider: 'saml_okta', idpMetadataUrl: 'http://acme.example/metadata' });
    expect(insecure.status).toBe(400);

    const junk = await call('PUT', '/connection', {
      provider: 'saml_custom',
      idpMetadataUrl: 'not a url',
      idpEntityId: 7,
      idpSsoUrl: 'ftp://acme.example/sso',
    });
    expect(junk.status).toBe(400);
  });

  it('shows a connection on file without the live IdP details or user count', async () => {
    const ws = await seedWorkspace();
    await seedConnection(ws, { spMetadataUrl: 'https://clerk.example/v1/saml/metadata/x' });

    const { status, json } = await api(ws)('GET', '/');

    expect(status).toBe(200);
    expect(json.data.connection).toEqual({
      provider: 'saml_okta',
      enabled: true,
      active: false,
      idp: { metadataUrl: null, hasMetadata: false, entityId: null, ssoUrl: null, hasCertificate: false },
      idpConfigured: false,
      sp: {
        acsUrl: `https://clerk.example/v1/saml/acs/samlc_ssoc_${seq}`,
        entityId: `https://clerk.example/saml/samlc_ssoc_${seq}`,
        metadataUrl: 'https://clerk.example/v1/saml/metadata/x',
      },
      userCount: null,
      updatedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(json.data.domain).toMatchObject({ verified: true, verifiedAt: '2026-10-01T10:00:00.000Z' });
  });

  it('locks the domain while a connection uses it', async () => {
    const ws = await seedConnectionWorkspace();
    const call = api(ws);

    const changed = await call('PUT', '/domain', { domain: 'elsewhere.example' });
    expect(changed.status).toBe(409);
    expect(changed.json.error).toEqual({
      code: 'SSO_DOMAIN_LOCKED',
      message: 'Remove the identity provider connection before changing the domain.',
    });
    const removed = await call('DELETE', '/domain');
    expect(removed.status).toBe(409);
    expect(removed.json.error).toEqual({
      code: 'SSO_DOMAIN_LOCKED',
      message: 'Remove the identity provider connection before removing the domain.',
    });
  });

  it('cannot update, remove or switch on a connection without Clerk', async () => {
    const ws = await seedConnectionWorkspace({ enabled: false });
    const call = api(ws);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    for (const [method, path, body] of [
      ['PUT', '/connection', { provider: 'saml_microsoft' }],
      ['DELETE', '/connection', undefined],
      ['POST', '/connection/activate', undefined],
    ] as const) {
      const { status, json } = await call(method, path, body);
      expect(status, `${method} ${path}`).toBe(502);
      expect(json.error?.code).toBe('SSO_PROVIDER_UNAVAILABLE');
    }
    expect(await rowOf(ws)).toMatchObject({ clerkConnectionId: `samlc_ssoc_${seq}`, provider: 'saml_okta', enabled: false });
  });

  it('switching on needs the entitlement and a verified domain first', async () => {
    const business = await seedWorkspace(BUSINESS);
    await seedConnection(business);
    const unpaid = await api(business)('POST', '/connection/activate');
    expect(unpaid.status).toBe(402);
    expect(unpaid.json.error?.code).toBe('SSO_NOT_ENTITLED');

    const unverified = await seedWorkspace();
    await seedConnection(unverified, { domainVerifiedAt: null });
    const refused = await api(unverified)('POST', '/connection/activate');
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code).toBe('SSO_DOMAIN_NOT_VERIFIED');
  });

  it('switches off without Clerk while Clerk has it off already', async () => {
    const ws = await seedConnectionWorkspace({ enabled: true, clerkActive: false });

    const { status, json } = await api(ws)('POST', '/connection/deactivate');

    expect(status).toBe(200);
    expect(json.data.connection).toMatchObject({ enabled: false, active: false });
    expect(json.data.connection.updatedAt).not.toBe('2026-10-02T10:00:00.000Z');
    expect(await rowOf(ws)).toMatchObject({ enabled: false, connectionUpdatedBy: 'user_admin' });
  });

  it('keeps it on when Clerk, which has it on, cannot be told', async () => {
    const ws = await seedConnectionWorkspace({ enabled: true, clerkActive: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { status, json } = await api(ws)('POST', '/connection/deactivate');

    expect(status).toBe(502);
    expect(json.error?.code).toBe('SSO_PROVIDER_UNAVAILABLE');
    expect(await rowOf(ws)).toMatchObject({ enabled: true, clerkActive: true });
  });

  it('without a connection: nothing to remove, nothing to switch', async () => {
    const ws = await seedWorkspace();
    const call = api(ws);

    const removed = await call('DELETE', '/connection');
    expect(removed.status).toBe(200);
    expect(removed.json.data.connection).toBeNull();

    for (const path of ['/connection/activate', '/connection/deactivate']) {
      const { status, json } = await call('POST', path);
      expect(status, path).toBe(409);
      expect(json.error).toEqual({ code: 'SSO_CONNECTION_MISSING', message: 'Connect your identity provider first.' });
    }
  });
});

describe('add-on billing, with billing-worker unreachable', () => {
  it('needs billing:manage to change the add-on', async () => {
    const ws = await seedWorkspace(BUSINESS);
    for (const path of ['/billing/subscribe', '/billing/cancel', '/billing/resume']) {
      expect((await api(ws)('POST', path)).status, path).toBe(403);
    }
  });

  it('answers 502 BILLING_UNAVAILABLE', async () => {
    const ws = await seedWorkspace(BUSINESS);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unavailable = { code: 'BILLING_UNAVAILABLE', message: 'Billing is unavailable right now. Try again later.' };

    const status = await api(ws, permissions('sso:read'))('GET', '/billing');
    expect(status.status).toBe(502);
    expect(status.json.error).toEqual(unavailable);

    const buyer = api(ws, permissions('sso:read', 'billing:manage'));
    for (const path of ['/billing/subscribe', '/billing/cancel', '/billing/resume']) {
      const { status: code, json } = await buyer('POST', path);
      expect(code, path).toBe(502);
      expect(json.error).toEqual(unavailable);
    }
  });
});

/** A workspace with a verified domain and a connection on file. */
async function seedConnectionWorkspace(row: Partial<typeof workspaceSso.$inferInsert> = {}): Promise<Ws> {
  const ws = await seedWorkspace();
  await seedConnection(ws, row);
  return ws;
}
