/**
 * /api/onboarding against a real master database (pglite) with Clerk as a
 * fetch stub: every route, with its refusals. Conformance-ready
 * (rust/conformance/suites.json): Clerk's calls are compared between the
 * backends, so the stub answers by method and URL (and request body), never
 * by call order.
 *
 * There is no WORKSPACE_WORKER binding here (the Rust backend has none), so
 * the routes that create a workspace are tested for what they answer without
 * it; territory.test.ts covers them with the binding. The successful
 * /partner-request (it emails the reseller through a Cloudflare binding) is
 * there too.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { CLERK_API, clerkCalls, clerkError, stubClerk, type ClerkRoutes } from '../../test/fake-clerk';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  // /finalize installs the apps in the workspace's own database: the test's
  // tenant one (its copy, on the TypeScript side of a conformance write).
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
}));
// The session comes from the test context; the router's own Clerk check is skipped.
vi.mock('@weldsuite/worker-kit/middleware/clerk', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { onboardingRoutes } from './index';

const { appCatalog, partners, partnerTerritories, partnerWorkspaceRequests, workspaces } = masterSchema;
const { workspaceInstalledApps, userAppAssignments } = schema;

const USER = 'user_onb';
const PROVISIONED_AT = new Date('2026-01-02T03:04:05.000Z');

const PARTNER = {
  id: 'ptr_onb',
  name: 'Acme Reseller',
  logoUrl: null,
  websiteUrl: 'https://acme.test',
  supportEmail: 'help@acme.test',
  supportUrl: null,
};

const TERRITORY_CONFLICT = {
  error: {
    code: 'PARTNER_TERRITORY',
    message: 'WeldSuite in BR is provided by Acme Reseller.',
    details: { country: 'BR', partner: PARTNER },
  },
};

const NO_WORKSPACE_SERVICE = { error: { code: 'INTERNAL_ERROR', message: 'Workspace service not configured' } };

const CLERK_USER = {
  id: USER,
  first_name: 'Ana',
  last_name: 'Silva',
  email_addresses: [{ id: 'idn_onb', email_address: 'ana@customer.test' }],
  image_url: 'https://img.clerk.test/ana.png',
};

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = tenantDb;
}, 180_000);

/**
 * One workspace per provisioning state, and a reseller serving Brazil. The
 * catalog starts empty; the tests that need apps add them.
 */
async function seed(): Promise<void> {
  await master.delete(partnerWorkspaceRequests);
  await master.delete(partnerTerritories);
  await master.delete(partners);
  await master.delete(workspaces);
  await master.delete(appCatalog);
  await master.insert(partners).values({
    id: PARTNER.id,
    name: PARTNER.name,
    billingEmail: 'billing@acme.test',
    supportEmail: PARTNER.supportEmail,
    websiteUrl: PARTNER.websiteUrl,
  });
  await master.insert(partnerTerritories).values({ countryCode: 'BR', partnerId: PARTNER.id });
  const provisioned = { neonProjectId: 'np_onb', databaseProvisionedAt: PROVISIONED_AT };
  await master.insert(workspaces).values([
    {
      id: 'ws_onb_ready',
      clerkOrgId: 'org_onb_ready',
      name: 'Ready Co',
      slug: 'onb-ready',
      ...provisioned,
      provisioningStatus: 'ready',
      onboardingCompletedAt: PROVISIONED_AT,
    },
    // Provisioned after an earlier failure: the stale flag no longer counts.
    { id: 'ws_onb_stale', clerkOrgId: 'org_onb_stale', name: 'Stale Co', slug: 'onb-stale', ...provisioned, provisioningStatus: 'failed' },
    {
      id: 'ws_onb_failed',
      clerkOrgId: 'org_onb_failed',
      name: 'Failed Co',
      slug: 'onb-failed',
      provisioningStatus: 'failed',
      provisioningError: 'Neon is down',
    },
    {
      id: 'ws_onb_pending',
      clerkOrgId: 'org_onb_pending',
      name: 'Pending Co',
      slug: 'onb-pending',
      neonProjectId: 'np_onb_pending',
      provisioningStatus: 'provisioning',
    },
    // A provisioning date without a Neon project is not provisioned.
    { id: 'ws_onb_half', clerkOrgId: 'org_onb_half', name: 'Half Co', slug: 'onb-half', databaseProvisionedAt: PROVISIONED_AT },
    { id: 'ws_onb_fin', clerkOrgId: 'org_onb_fin', name: 'Fin Co', slug: 'onb-fin', ...provisioned, provisioningStatus: 'ready' },
  ]);
  await tenantDb.delete(workspaceInstalledApps);
  await tenantDb.delete(userAppAssignments);
}

beforeEach(async () => {
  await seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Session {
  userId?: string;
  orgId?: string | null;
}

function app(session: Session = {}) {
  return createTestApp('/api/onboarding', onboardingRoutes, {
    context: { userId: USER, orgId: null, tenantDb, masterDb: master, ...session },
  });
}

function get(path: string, session?: Session) {
  return app(session).request(`/api/onboarding${path}`);
}

/** POST `body` as JSON (no body when undefined), with the session and extra headers. */
function post(path: string, body?: unknown, options: { session?: Session; headers?: Record<string, string> } = {}) {
  return app(options.session).request(`/api/onboarding${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const fromBrazil = { 'CF-IPCountry': 'BR' };
/** No CF-IPCountry header: the request's country is unknown. */
const noCountry: Record<string, string> = {};

/** Clerk's GET /users/:id for the caller, answering `user`. */
function clerkUser(user: Record<string, unknown> = CLERK_USER): ClerkRoutes {
  return (method, path) => (method === 'GET' && path === `/users/${USER}` ? { status: 200, body: user } : undefined);
}

/** Every PATCH succeeds. */
const patchesOk: ClerkRoutes = (method) => (method === 'PATCH' ? { status: 200, body: {} } : undefined);

/** JSON with object keys sorted, so the same body sent by both backends counts once. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/** The distinct request bodies of one Clerk call (`'PATCH /users/user_onb'`). */
function clerkBodies(stub: Mock, call: string): unknown[] {
  const bodies = new Map<string, unknown>();
  for (const [input, init] of stub.mock.calls) {
    const url = String(input);
    const request = init as RequestInit | undefined;
    if (!url.startsWith(CLERK_API) || `${(request?.method ?? 'GET').toUpperCase()} ${url.slice(CLERK_API.length)}` !== call) {
      continue;
    }
    const body: unknown = typeof request?.body === 'string' && request.body !== '' ? JSON.parse(request.body) : null;
    bodies.set(canonical(body), body);
  }
  return [...bodies.values()];
}

const workspaceRow = async (clerkOrgId: string) =>
  (await master.select().from(workspaces).where(eq(workspaces.clerkOrgId, clerkOrgId)))[0] as typeof workspaces.$inferSelect;

const requestCount = async () =>
  ((await master.select().from(partnerWorkspaceRequests).where(eq(partnerWorkspaceRequests.requesterUserId, USER))) as unknown[]).length;

describe('POST /api/onboarding/create-workspace', () => {
  it('validates the body', async () => {
    const stub = stubClerk(() => undefined);
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(256) }, { name: 'Acme', selectedApps: [''] }, { name: 'Acme', country: 7 }]) {
      expect((await post('/create-workspace', body)).status).toBe(400);
    }
    expect(clerkCalls(stub)).toEqual([]);
  });

  it('answers 401 without a user, before looking at the name', async () => {
    const res = await post('/create-workspace', { name: '   ' }, { session: { userId: '' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
  });

  it('refuses a name of only spaces', async () => {
    const res = await post('/create-workspace', { name: '   ' }, { headers: fromBrazil });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Workspace name is required' } });
  });

  it('answers 409 PARTNER_TERRITORY for a country a reseller serves, whatever the body says', async () => {
    const stub = stubClerk(clerkUser());
    for (const [country, header] of [['NL', 'BR'], [undefined, 'br']] as const) {
      const res = await post('/create-workspace', { name: 'Acme', country }, { headers: { 'CF-IPCountry': header } });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(TERRITORY_CONFLICT);
    }
    expect(clerkCalls(stub)).toEqual([]);
  });

  it('gets past the territory in an open or unknown country, then needs the workspace service', async () => {
    const stub = stubClerk(clerkUser());
    for (const headers of [{ 'CF-IPCountry': 'NL' }, { 'CF-IPCountry': 'XX' }, noCountry]) {
      // A served country in the body never blocks.
      const res = await post('/create-workspace', { name: 'Acme', country: 'BR' }, { headers });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(NO_WORKSPACE_SERVICE);
    }
    expect(clerkCalls(stub)).toEqual([]);
  });
});

describe('POST /api/onboarding/partner-request', () => {
  const body = { companyName: 'Customer BV', country: 'br', selectedApps: ['welddesk'], message: 'Call me' };

  it('validates the body', async () => {
    stubClerk(clerkUser());
    for (const invalid of [
      { country: 'BR' },
      { companyName: ' ', country: 'BR' },
      { companyName: 'Customer BV', country: 'Brazil' },
      { companyName: 'Customer BV', country: 'BR', selectedApps: ['Bad App'] },
    ]) {
      expect((await post('/partner-request', invalid, { headers: fromBrazil })).status).toBe(400);
    }
  });

  it('answers 401 without a user', async () => {
    const res = await post('/partner-request', body, { session: { userId: '' }, headers: fromBrazil });
    expect(res.status).toBe(401);
  });

  it('answers 404 when the request country has no reseller, whatever the body says', async () => {
    const stub = stubClerk(clerkUser());
    for (const headers of [{ 'CF-IPCountry': 'DE' }, noCountry]) {
      const res = await post('/partner-request', body, { headers });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Partner for this country not found' } });
    }
    expect(clerkCalls(stub)).toEqual([]);
    expect(await requestCount()).toBe(0);
  });

  it('answers 400 when the caller has no email address, or Clerk does not know them', async () => {
    stubClerk(clerkUser({ ...CLERK_USER, email_addresses: [] }));
    const noEmail = await post('/partner-request', body, { headers: fromBrazil });
    expect(noEmail.status).toBe(400);
    expect(await noEmail.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Your account has no email address' } });

    stubClerk(() => clerkError(404, 'resource_not_found'));
    expect((await post('/partner-request', body, { headers: fromBrazil })).status).toBe(400);
    expect(await requestCount()).toBe(0);
  });

  it('answers 429 past the daily request cap', async () => {
    await master.insert(partnerWorkspaceRequests).values(
      Array.from({ length: 5 }, (_, i) => ({
        id: `pwr_onb_${i}`,
        partnerId: PARTNER.id,
        requesterUserId: USER,
        requesterEmail: 'ana@customer.test',
        companyName: 'Customer BV',
        countryCode: 'BR',
      })),
    );
    const stub = stubClerk(clerkUser());
    const res = await post('/partner-request', body, { headers: fromBrazil });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests today. Try again tomorrow.' },
    });
    expect(clerkCalls(stub)).toEqual([`GET /users/${USER}`]);
    expect(await requestCount()).toBe(5);
  });

  it('answers 500 when Clerk cannot be reached', async () => {
    stubClerk(() => 'throw');
    const res = await post('/partner-request', body, { headers: fromBrazil });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to send your request' } });
  });
});

describe('GET /api/onboarding/status', () => {
  it('has no organization without a user or an org', async () => {
    for (const session of [{ userId: '', orgId: 'org_onb_ready' }, { orgId: null }]) {
      const res = await get('/status', session);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { completed: false, hasOrganization: false } });
    }
  });

  it('reports whether the workspace finished onboarding', async () => {
    const cases: Array<[string, boolean]> = [
      ['org_onb_ready', true],
      ['org_onb_fin', false],
      // An org without a workspace row still counts as an organization.
      ['org_onb_unknown', false],
    ];
    for (const [orgId, completed] of cases) {
      const res = await get('/status', { orgId });
      expect(await res.json()).toEqual({ data: { completed, hasOrganization: true } });
    }
  });
});

describe('GET /api/onboarding/database-status', () => {
  const pending = { provisioned: false, migrated: false, status: 'pending', failed: false };

  it('is pending without an org or a workspace row', async () => {
    for (const orgId of [null, 'org_onb_unknown']) {
      const res = await get('/database-status', { orgId });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: pending });
    }
  });

  it('reports each provisioning state', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['org_onb_ready', { provisioned: true, migrated: true, status: 'ready', failed: false }],
      ['org_onb_stale', { provisioned: true, migrated: true, status: 'ready', failed: false }],
      ['org_onb_failed', { provisioned: false, migrated: false, status: 'failed', failed: true }],
      ['org_onb_pending', { provisioned: false, migrated: false, status: 'provisioning', failed: false }],
      ['org_onb_half', pending],
    ];
    for (const [orgId, data] of cases) {
      expect(await (await get('/database-status', { orgId })).json()).toEqual({ data });
    }
  });

  it('does not need a user', async () => {
    const res = await get('/database-status', { userId: '', orgId: 'org_onb_ready' });
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('ready');
  });
});

describe('GET /api/onboarding/user-info', () => {
  it('answers empty without a user, and asks Clerk nothing', async () => {
    const stub = stubClerk(clerkUser());
    const res = await get('/user-info', { userId: '', orgId: 'org_onb_ready' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { user: { firstName: '', lastName: '', email: '' }, organization: null } });
    expect(clerkCalls(stub)).toEqual([]);
  });

  it("names the user from Clerk and the session's workspace", async () => {
    const stub = stubClerk(clerkUser());
    const res = await get('/user-info', { orgId: 'org_onb_ready' });
    expect(await res.json()).toEqual({
      data: {
        user: { firstName: 'Ana', lastName: 'Silva', email: 'ana@customer.test', imageUrl: 'https://img.clerk.test/ana.png' },
        organization: { id: 'org_onb_ready', name: 'Ready Co' },
      },
    });
    expect(clerkCalls(stub)).toEqual([`GET /users/${USER}`]);
  });

  it('leaves out the image Clerk does not have, and the workspace that has no row', async () => {
    stubClerk(clerkUser({ id: USER, first_name: null, email_addresses: [] }));
    for (const orgId of [null, 'org_onb_unknown']) {
      const body = (await (await get('/user-info', { orgId })).json()) as { data: { user: object } };
      expect(body).toEqual({ data: { user: { firstName: '', lastName: '', email: '' }, organization: null } });
      expect(body.data.user).not.toHaveProperty('imageUrl');
    }
  });

  it('still names the workspace when Clerk refuses', async () => {
    stubClerk(() => clerkError(404, 'resource_not_found'));
    const res = await get('/user-info', { orgId: 'org_onb_ready' });
    expect(await res.json()).toEqual({
      data: { user: { firstName: '', lastName: '', email: '' }, organization: { id: 'org_onb_ready', name: 'Ready Co' } },
    });
  });

  it('answers empty, workspace included, when Clerk cannot be reached', async () => {
    stubClerk(() => 'throw');
    const res = await get('/user-info', { orgId: 'org_onb_ready' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { user: { firstName: '', lastName: '', email: '' }, organization: null } });
  });
});

describe('GET /api/onboarding/available-apps', () => {
  const catalogApp = (code: string, overrides: Record<string, unknown> = {}) => ({
    id: `app_onb_${code}`,
    code,
    name: code.toUpperCase(),
    description: `About ${code}`,
    icon: 'Box',
    category: 'Productivity',
    path: `/${code}`,
    isActive: true,
    isPublished: true,
    ...overrides,
  });

  it('falls back to the static catalog without an active, published app', async () => {
    await master
      .insert(appCatalog)
      .values([catalogApp('draft', { isPublished: false }), catalogApp('retired', { isActive: false })]);
    const res = await get('/available-apps');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data.map((a) => a.code)).toEqual([
      'commerce',
      'crm',
      'projects',
      'weldconnect',
      'helpdesk',
      'mail',
      'parcel',
      'host',
      'weldsheets',
      'welddocs',
      'weldpass',
      'weldhr',
    ]);
    expect(data[1]).toEqual({
      code: 'crm',
      name: 'CRM',
      description: 'Manage leads, contacts, and sales pipelines',
      icon: 'Users',
      category: 'Sales & Marketing',
      path: '/crm',
    });
    for (const item of data) expect(Object.keys(item)).toEqual(['code', 'name', 'description', 'icon', 'category', 'path']);
  });

  it('maps the active, published catalog rows', async () => {
    await master.insert(appCatalog).values([
      catalogApp('crm', {
        overview: 'All about CRM',
        features: ['Pipelines'],
        howItWorks: [{ title: 'Add', description: 'Add a lead' }],
        version: '2.1.0',
        provider: 'WeldSuite',
      }),
      catalogApp('helpdesk', { features: null, howItWorks: null, version: null, provider: null }),
      // An empty version falls back too; an empty provider does not.
      catalogApp('mail', { version: '', provider: '' }),
      catalogApp('draft', { isPublished: false }),
      catalogApp('retired', { isActive: false }),
    ]);
    const res = await get('/available-apps');
    const { data } = (await res.json()) as { data: Array<{ code: string }> };
    const base = (code: string) => ({
      code,
      name: code.toUpperCase(),
      description: `About ${code}`,
      icon: 'Box',
      category: 'Productivity',
      path: `/${code}`,
    });
    expect([...data].sort((a, b) => (a.code < b.code ? -1 : 1))).toEqual([
      {
        ...base('crm'),
        overview: 'All about CRM',
        features: ['Pipelines'],
        howItWorks: [{ title: 'Add', description: 'Add a lead' }],
        version: '2.1.0',
        provider: 'WeldSuite',
      },
      { ...base('helpdesk'), overview: null, features: null, howItWorks: null, version: '1.0.0', provider: null },
      { ...base('mail'), overview: null, features: [], howItWorks: [], version: '1.0.0', provider: '' },
    ]);
  });
});

describe('POST /api/onboarding/profile', () => {
  it('validates the body', async () => {
    stubClerk(patchesOk);
    for (const body of [{ firstName: 5 }, { productUpdates: 'yes' }]) {
      expect((await post('/profile', body)).status).toBe(400);
    }
  });

  it('answers 401 without a user', async () => {
    const stub = stubClerk(patchesOk);
    expect((await post('/profile', { firstName: 'Ana' }, { session: { userId: '' } })).status).toBe(401);
    expect(clerkCalls(stub)).toEqual([]);
  });

  it('saves the name, then the metadata', async () => {
    const stub = stubClerk(patchesOk);
    const res = await post('/profile', { firstName: 'Ana', lastName: 'Silva', phone: '+31 6 1234', jobTitle: 'CTO', productUpdates: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(clerkCalls(stub)).toEqual([`PATCH /users/${USER}`, `PATCH /users/${USER}/metadata`]);
    expect(clerkBodies(stub, `PATCH /users/${USER}`)).toEqual([{ first_name: 'Ana', last_name: 'Silva' }]);
    expect(clerkBodies(stub, `PATCH /users/${USER}/metadata`)).toEqual([
      { public_metadata: { productUpdates: false, phone: '+31 6 1234', jobTitle: 'CTO' } },
    ]);
  });

  it('sends no metadata when there is none to save', async () => {
    const stub = stubClerk(patchesOk);
    const res = await post('/profile', { phone: '', jobTitle: '' });
    expect(res.status).toBe(200);
    expect(clerkCalls(stub)).toEqual([`PATCH /users/${USER}`]);
    // Names that were not sent are left out of Clerk's body.
    expect(clerkBodies(stub, `PATCH /users/${USER}`)).toEqual([{}]);
  });

  it('answers 500 when Clerk refuses the name, and saves nothing else', async () => {
    const stub = stubClerk((method, path) => (path === `/users/${USER}` ? clerkError(422, 'form_param_invalid') : patchesOk(method, path, null)));
    const res = await post('/profile', { firstName: 'Ana', productUpdates: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update profile' } });
    expect(clerkCalls(stub)).toEqual([`PATCH /users/${USER}`]);
  });

  it('ignores a refused metadata update', async () => {
    stubClerk((method, path) => (path.endsWith('/metadata') ? clerkError(500, 'internal_error') : patchesOk(method, path, null)));
    const res = await post('/profile', { firstName: 'Ana', productUpdates: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
  });

  it('answers 500 when Clerk cannot be reached', async () => {
    stubClerk(() => 'throw');
    const res = await post('/profile', { firstName: 'Ana' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save profile' } });
  });
});

describe('POST /api/onboarding/workspace', () => {
  it('validates the body', async () => {
    for (const body of [{}, { name: '' }, { name: 'Acme', country: 7 }]) {
      expect((await post('/workspace', body)).status).toBe(400);
    }
  });

  it('answers 401 without a user', async () => {
    expect((await post('/workspace', { name: 'Acme' }, { session: { userId: '' } })).status).toBe(401);
  });

  it('needs the workspace service before it looks at the territory', async () => {
    const stub = stubClerk(clerkUser());
    for (const headers of [fromBrazil, { 'CF-IPCountry': 'NL' }]) {
      const res = await post('/workspace', { name: 'Acme', country: 'NL' }, { headers });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(NO_WORKSPACE_SERVICE);
    }
    expect(clerkCalls(stub)).toEqual([]);
  });
});

describe('POST /api/onboarding/role', () => {
  it('validates the body', async () => {
    for (const body of [{}, { role: '' }, { role: 7 }]) {
      expect((await post('/role', body)).status).toBe(400);
    }
  });

  it('answers 401 without a user', async () => {
    expect((await post('/role', { role: 'founder' }, { session: { userId: '' } })).status).toBe(401);
  });

  it("saves the role in the user's metadata", async () => {
    const stub = stubClerk(patchesOk);
    const res = await post('/role', { role: 'founder' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(clerkCalls(stub)).toEqual([`PATCH /users/${USER}/metadata`]);
    expect(clerkBodies(stub, `PATCH /users/${USER}/metadata`)).toEqual([{ public_metadata: { primaryRole: 'founder' } }]);
  });

  it('ignores a refusal from Clerk', async () => {
    stubClerk(() => clerkError(500, 'internal_error'));
    expect(await (await post('/role', { role: 'founder' })).json()).toEqual({ data: { success: true } });
  });

  it('answers 500 when Clerk cannot be reached', async () => {
    stubClerk(() => 'throw');
    const res = await post('/role', { role: 'founder' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save role' } });
  });
});

describe('POST /api/onboarding/invitations', () => {
  const ORG = 'org_onb_new';
  const INVITATIONS = `/organizations/${ORG}/invitations`;

  it('validates the body', async () => {
    for (const body of [{ invites: 'everyone' }, { organizationId: ORG, invites: [{ email: 'a@team.test' }] }]) {
      expect((await post('/invitations', body)).status).toBe(400);
    }
  });

  it('answers 401 without a user', async () => {
    expect((await post('/invitations', { organizationId: ORG, invites: [] }, { session: { userId: '' } })).status).toBe(401);
  });

  it('sends nothing without an org or invites', async () => {
    const stub = stubClerk(() => ({ status: 200, body: {} }));
    const invites = [{ email: 'a@team.test', role: 'member' }];
    for (const body of [{}, { organizationId: ORG }, { organizationId: ORG, invites: [] }, { organizationId: '', invites }, { invites }]) {
      const res = await post('/invitations', body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { success: true, sent: 0, failed: [] } });
    }
    expect(clerkCalls(stub)).toEqual([]);
  });

  it('invites each teammate and lists the ones that failed', async () => {
    const refusal = clerkError(422, 'form_param_format_invalid', 'is invalid');
    const stub = stubClerk((method, path, body) => {
      if (method !== 'POST' || path !== INVITATIONS) return undefined;
      const email = (body as { email_address: string }).email_address;
      if (email === 'not-an-email') return refusal;
      if (email === 'down@team.test') return 'throw';
      return { status: 200, body: { id: `orginv_${email}` } };
    });
    const res = await post('/invitations', {
      organizationId: ORG,
      invites: [
        { email: 'admin@team.test', role: 'admin' },
        { email: 'not-an-email', role: 'member' },
        { email: 'member@team.test', role: 'viewer' },
        { email: 'down@team.test', role: 'member' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        success: true,
        sent: 2,
        failed: [
          { email: 'not-an-email', error: JSON.stringify(refusal.body) },
          { email: 'down@team.test', error: 'Failed to send invitation' },
        ],
      },
    });
    expect(clerkCalls(stub)).toEqual([`POST ${INVITATIONS}`]);
    const redirect = `https://app-test.weldsuite.org/invite?org_id=${ORG}`;
    expect(clerkBodies(stub, `POST ${INVITATIONS}`)).toEqual([
      { email_address: 'admin@team.test', role: 'org:admin', inviter_user_id: USER, redirect_url: redirect },
      { email_address: 'not-an-email', role: 'org:member', inviter_user_id: USER, redirect_url: redirect },
      { email_address: 'member@team.test', role: 'org:member', inviter_user_id: USER, redirect_url: redirect },
      { email_address: 'down@team.test', role: 'org:member', inviter_user_id: USER, redirect_url: redirect },
    ]);
  });
});

describe('POST /api/onboarding/complete', () => {
  it('answers 401 without a user', async () => {
    const stub = stubClerk(patchesOk);
    expect((await post('/complete', { role: 'founder' }, { session: { userId: '' } })).status).toBe(401);
    expect(clerkCalls(stub)).toEqual([]);
  });

  it("patches the user's and the org's metadata when the session has an org", async () => {
    const stub = stubClerk(patchesOk);
    const res = await post(
      '/complete',
      {
        role: 'cto',
        productUpdates: false,
        country: 'NL',
        referralSource: '',
        organizationSize: '11-50',
        region: 'eu',
        selectedApps: [],
        organizationName: 'Ignored BV',
      },
      { session: { orgId: 'org_onb_fin' } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true, clerkOrgId: 'org_onb_fin' } });
    expect(clerkCalls(stub)).toEqual([`PATCH /users/${USER}/metadata`, 'PATCH /organizations/org_onb_fin/metadata']);
    expect(clerkBodies(stub, `PATCH /users/${USER}/metadata`)).toEqual([
      { public_metadata: { productUpdates: false, primaryRole: 'cto' } },
    ]);
    // Only the fields that were sent and are not empty; an empty list counts.
    expect(clerkBodies(stub, 'PATCH /organizations/org_onb_fin/metadata')).toEqual([
      { public_metadata: { country: 'NL', organizationSize: '11-50', region: 'eu', selectedApps: [] } },
    ]);
  });

  it('asks Clerk nothing for an empty body, and ignores a refused org update', async () => {
    const empty = stubClerk(patchesOk);
    const res = await post('/complete', undefined, { session: { orgId: 'org_onb_fin' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true, clerkOrgId: 'org_onb_fin' } });
    expect(clerkCalls(empty)).toEqual([]);

    stubClerk(() => clerkError(500, 'internal_error'));
    const refused = await post('/complete', { role: 'cto', country: 'NL' }, { session: { orgId: 'org_onb_fin' } });
    expect(await refused.json()).toEqual({ data: { success: true, clerkOrgId: 'org_onb_fin' } });
  });

  it('without an org, answers 409 in a reseller country after saving the user metadata', async () => {
    const stub = stubClerk(patchesOk);
    const res = await post('/complete', { organizationName: 'Acme', country: 'NL', role: 'founder' }, { headers: fromBrazil });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(TERRITORY_CONFLICT);
    expect(clerkCalls(stub)).toEqual([`PATCH /users/${USER}/metadata`]);
  });

  it('without an org, needs the workspace service outside a reseller country', async () => {
    const stub = stubClerk(clerkUser());
    for (const headers of [{ 'CF-IPCountry': 'NL' }, noCountry]) {
      const res = await post('/complete', { organizationName: 'Acme', country: 'BR' }, { headers });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(NO_WORKSPACE_SERVICE);
    }
    expect(clerkCalls(stub)).toEqual([]);
  });

  it('answers 500 when Clerk cannot be reached, or the body is JSON null', async () => {
    stubClerk(() => 'throw');
    const unreachable = await post('/complete', { role: 'cto' }, { session: { orgId: 'org_onb_fin' } });
    expect(unreachable.status).toBe(500);
    expect(await unreachable.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to complete onboarding' } });

    const stub = stubClerk(patchesOk);
    const nullBody = await post('/complete', null, { session: { orgId: 'org_onb_fin' } });
    expect(nullBody.status).toBe(500);
    expect(await nullBody.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to complete onboarding' } });
    expect(clerkCalls(stub)).toEqual([]);
  });
});

describe('POST /api/onboarding/retry', () => {
  it('answers 401 without a user or an org', async () => {
    for (const session of [{ userId: '', orgId: 'org_onb_failed' }, { orgId: null }]) {
      const res = await post('/retry', undefined, { session });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }
  });

  it('has nothing to do once the database has a provisioning date', async () => {
    const stub = stubClerk(clerkUser());
    // Only the date counts here, unlike /database-status: a row without a Neon project short-circuits too.
    for (const orgId of ['org_onb_stale', 'org_onb_half']) {
      const res = await post('/retry', undefined, { session: { orgId } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { success: true } });
    }
    expect(clerkCalls(stub)).toEqual([]);
    expect((await workspaceRow('org_onb_stale')).provisioningStatus).toBe('failed');
  });

  it('needs the workspace service before it resets a failed provisioning', async () => {
    const stub = stubClerk(clerkUser());
    for (const orgId of ['org_onb_failed', 'org_onb_unknown']) {
      const res = await post('/retry', undefined, { session: { orgId } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(NO_WORKSPACE_SERVICE);
    }
    expect(clerkCalls(stub)).toEqual([]);
    expect(await workspaceRow('org_onb_failed')).toMatchObject({ provisioningStatus: 'failed', provisioningError: 'Neon is down' });
  });
});

describe('POST /api/onboarding/finalize', () => {
  const FIN_ORG = 'org_onb_fin';

  /** Clerk's org, with `selectedApps` in its public metadata. */
  function clerkOrg(selectedApps?: unknown): ClerkRoutes {
    return (method, path) =>
      method === 'GET' && path === `/organizations/${FIN_ORG}`
        ? { status: 200, body: { id: FIN_ORG, name: 'Fin Co', public_metadata: selectedApps === undefined ? {} : { selectedApps } } }
        : undefined;
  }

  const installed = async () =>
    (
      await tenantDb
        .select({
          id: workspaceInstalledApps.id,
          appCode: workspaceInstalledApps.appCode,
          installedBy: workspaceInstalledApps.installedBy,
          isActive: workspaceInstalledApps.isActive,
        })
        .from(workspaceInstalledApps)
    ).sort((a, b) => (a.appCode < b.appCode ? -1 : 1));

  const assigned = async () =>
    (
      await tenantDb
        .select({ userId: userAppAssignments.userId, appCode: userAppAssignments.appCode, isActive: userAppAssignments.isActive })
        .from(userAppAssignments)
    ).sort((a, b) => (a.appCode < b.appCode ? -1 : 1));

  it('answers 401 without a user', async () => {
    const res = await post('/finalize', undefined, { session: { userId: '', orgId: FIN_ORG } });
    expect(res.status).toBe(401);
  });

  it('needs an org', async () => {
    const stub = stubClerk(clerkOrg(['crm']));
    const res = await post('/finalize');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'ORG_REQUIRED', message: 'Organization context required' } });
    expect(clerkCalls(stub)).toEqual([]);
  });

  it('marks onboarding complete and installs the picked apps, except those on request', async () => {
    await master.insert(appCatalog).values({
      id: 'app_onb_reach',
      code: 'weldreach',
      name: 'WeldReach',
      description: 'Outreach',
      icon: 'Send',
      category: 'Sales & Marketing',
      path: '/weldreach',
      requiresApproval: true,
    });
    // Installed before: left as it is.
    await tenantDb.insert(workspaceInstalledApps).values({ id: 'wia_onb_crm', appCode: 'crm', installedBy: 'user_other' });
    const stub = stubClerk(clerkOrg(['crm', 'helpdesk', 'weldreach']));

    const res = await post('/finalize', undefined, { session: { orgId: FIN_ORG } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(clerkCalls(stub)).toEqual([`GET /organizations/${FIN_ORG}`]);

    expect((await workspaceRow(FIN_ORG)).onboardingCompletedAt).toBeInstanceOf(Date);
    expect((await workspaceRow('org_onb_pending')).onboardingCompletedAt).toBeNull();
    expect(await installed()).toEqual([
      { id: 'wia_onb_crm', appCode: 'crm', installedBy: 'user_other', isActive: true },
      { id: expect.stringMatching(/^wia_/), appCode: 'helpdesk', installedBy: USER, isActive: true },
    ]);
    expect(await assigned()).toEqual([
      { userId: USER, appCode: 'crm', isActive: true },
      { userId: USER, appCode: 'helpdesk', isActive: true },
    ]);
  });

  it('still completes onboarding, installing nothing, when Clerk refuses or no apps were picked', async () => {
    for (const routes of [() => clerkError(404, 'resource_not_found'), clerkOrg(), clerkOrg([])]) {
      await master.update(workspaces).set({ onboardingCompletedAt: null }).where(eq(workspaces.clerkOrgId, FIN_ORG));
      stubClerk(routes);
      const res = await post('/finalize', undefined, { session: { orgId: FIN_ORG } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { success: true } });
      expect((await workspaceRow(FIN_ORG)).onboardingCompletedAt).toBeInstanceOf(Date);
    }
    expect(await installed()).toEqual([]);
    expect(await assigned()).toEqual([]);
  });

  it('answers 500, completing nothing, when Clerk cannot be reached', async () => {
    stubClerk(() => 'throw');
    const res = await post('/finalize', undefined, { session: { orgId: FIN_ORG } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to finalize onboarding' } });
    expect((await workspaceRow(FIN_ORG)).onboardingCompletedAt).toBeNull();
  });
});
