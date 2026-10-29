/**
 * /api/sso against a real pglite master DB with a fake Clerk, a stubbed DNS
 * lookup and a stubbed billing-worker: the flows that need Clerk (or
 * billing-worker) to answer. Creating the SAML connection, switching it on and
 * off, removing and recreating it, the races around those calls, and the
 * billing pass-through.
 *
 * Not in the conformance suite: Clerk's SAML connections and billing-worker
 * are Global-only, so the Rust backend never makes these calls. What it does
 * serve (the gates, the domain and its DNS proof, the entitlement, a
 * connection on file with Clerk unreachable) is in sso.integration.test.ts.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

interface FakeConnection {
  id: string;
  domain: string;
  organizationId: string | null;
  provider: string;
  active: boolean;
  idpMetadataUrl: string | null;
  idpMetadata: string | null;
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  idpCertificate: string | null;
  acsUrl: string;
  spEntityId: string;
  spMetadataUrl: string;
  userCount: number;
}

const state = vi.hoisted(() => ({
  db: null as unknown,
  txt: [] as string[],
  connections: new Map<string, FakeConnection>(),
  seq: 0,
  /** Runs inside Clerk's create call, to change things while it is in flight. */
  beforeCreate: null as null | (() => Promise<void>),
}));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.db };
});
vi.mock('@weldsuite/worker-kit/dns-lookup', () => ({ lookupTxt: vi.fn(async () => state.txt) }));
vi.mock('@weldsuite/worker-kit/billing-worker', () => ({ callBillingWorker: vi.fn() }));
vi.mock('@weldsuite/entity-events', () => ({ publishEntityEvent: vi.fn() }));
vi.mock('@clerk/backend', () => {
  const notFound = () => Object.assign(new Error('not found'), { status: 404 });
  const clean = (params: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value === '' ? null : value]));
  return {
    createClerkClient: () => ({
      samlConnections: {
        createSamlConnection: async (params: Record<string, unknown>) => {
          await state.beforeCreate?.();
          state.seq += 1;
          const id = `samlc_${state.seq}`;
          const connection = {
            id,
            active: false,
            idpMetadataUrl: null,
            idpMetadata: null,
            idpEntityId: null,
            idpSsoUrl: null,
            idpCertificate: null,
            acsUrl: `https://clerk.example/v1/saml/acs/${id}`,
            spEntityId: `https://clerk.example/saml/${id}`,
            spMetadataUrl: `https://clerk.example/v1/saml/metadata/${id}`,
            userCount: 0,
            ...clean(params),
          } as FakeConnection;
          state.connections.set(id, connection);
          return connection;
        },
        getSamlConnection: async (id: string) => {
          const connection = state.connections.get(id);
          if (!connection) throw notFound();
          return connection;
        },
        updateSamlConnection: async (id: string, params: Record<string, unknown>) => {
          const connection = state.connections.get(id);
          if (!connection) throw notFound();
          Object.assign(connection, clean(params));
          return connection;
        },
        deleteSamlConnection: async (id: string) => {
          if (!state.connections.delete(id)) throw notFound();
          return {};
        },
      },
    }),
  };
});

import { ssoRoutes } from './index';
import { callBillingWorker } from '@weldsuite/worker-kit/billing-worker';
import { lookupTxt } from '@weldsuite/worker-kit/dns-lookup';
import { publishEntityEvent } from '@weldsuite/entity-events';

const { plans, workspaces, workspaceSso } = masterSchema;
const mockedBilling = vi.mocked(callBillingWorker);
const mockedLookupTxt = vi.mocked(lookupTxt);
const mockedPublish = vi.mocked(publishEntityEvent);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let db: any;
let seq = 0;

const BUSINESS = 'plan_ssor_business';
const ENTERPRISE = 'plan_ssor_enterprise';

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
  state.db = db;
  await db
    .insert(plans)
    .values([
      { id: BUSINESS, name: 'Business', slug: 'ssor-business', pricePerUser: '49' },
      { id: ENTERPRISE, name: 'Enterprise', slug: 'ssor-enterprise', pricePerUser: '99', features: { sso: true } },
    ])
    .onConflictDoNothing();
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  state.txt = [];
  state.connections.clear();
  state.beforeCreate = null;
});

interface Ws {
  id: string;
  orgId: string;
}

async function seedWorkspace(planId = ENTERPRISE): Promise<Ws> {
  seq += 1;
  const id = `ws_ssor_${seq}`;
  const orgId = `org_ssor_${seq}`;
  await db.insert(workspaces).values({ id, clerkOrgId: orgId, name: `Acme ${seq}`, slug: `ssor-${seq}`, planId });
  return { id, orgId };
}

async function rowOf(ws: Ws) {
  const [row] = await db.select().from(workspaceSso).where(eq(workspaceSso.workspaceId, ws.id));
  return row as typeof workspaceSso.$inferSelect | undefined;
}

const MANAGER = permissions('sso:read', 'sso:manage');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read deep into the view
type Answer = { data?: any; error?: { code: string; message: string } };

function api(ws: Ws, granted = MANAGER) {
  const { request } = createTestApp('/api/sso', ssoRoutes, {
    context: { orgId: ws.orgId, workspaceId: ws.id, userId: 'user_admin', permissions: granted },
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

/** Claim and verify `domain` for the workspace. */
async function verifiedDomain(ws: Ws, domain: string) {
  const call = api(ws);
  const claimed = await call('PUT', '/domain', { domain });
  state.txt = [claimed.json.data.domain.dnsRecord.value];
  await call('POST', '/domain/verify');
  state.txt = [];
}

describe('domain', () => {
  it('does not verify a domain that was swapped during the DNS lookup', async () => {
    const ws = await seedWorkspace();
    const call = api(ws);
    const claimed = await call('PUT', '/domain', { domain: 'mine.example' });
    mockedLookupTxt.mockImplementationOnce(async () => {
      await call('PUT', '/domain', { domain: 'victim.example' });
      return [claimed.json.data.domain.dnsRecord.value];
    });

    const { status, json } = await call('POST', '/domain/verify');

    expect(status).toBe(409);
    expect(json.error?.code).toBe('SSO_CHANGED_MEANWHILE');
    expect(await rowOf(ws)).toMatchObject({ domain: 'victim.example', domainVerifiedAt: null });
  });
});

describe('connection', () => {
  it('drops a connection whose domain was swapped while Clerk created it', async () => {
    const ws = await seedWorkspace();
    await verifiedDomain(ws, 'first.example');
    const call = api(ws);
    state.beforeCreate = async () => {
      state.beforeCreate = null;
      await call('PUT', '/domain', { domain: 'second.example' });
    };

    const { status, json } = await call('PUT', '/connection', { provider: 'saml_okta' });

    expect(status).toBe(409);
    expect(json.error?.code).toBe('SSO_CHANGED_MEANWHILE');
    expect(state.connections.size).toBe(0);
    expect(await rowOf(ws)).toMatchObject({ domain: 'second.example', domainVerifiedAt: null, clerkConnectionId: null });
  });

  it('creates the Clerk connection on the workspace organization, off until switched on', async () => {
    const ws = await seedWorkspace();
    await verifiedDomain(ws, 'okta.example');

    const { status, json } = await api(ws)('PUT', '/connection', { provider: 'saml_okta' });

    expect(status).toBe(200);
    const [connection] = [...state.connections.values()];
    expect(connection).toMatchObject({ domain: 'okta.example', organizationId: ws.orgId, provider: 'saml_okta', active: false });
    expect(json.data.connection).toMatchObject({
      provider: 'saml_okta',
      enabled: false,
      active: false,
      idpConfigured: false,
      sp: { acsUrl: connection!.acsUrl, entityId: connection!.spEntityId },
    });
  });

  it('switches on only with complete IdP details, and off again', async () => {
    const ws = await seedWorkspace();
    await verifiedDomain(ws, 'entra.example');
    const call = api(ws);
    await call('PUT', '/connection', { provider: 'saml_microsoft' });

    const incomplete = await call('POST', '/connection/activate');
    expect(incomplete.status).toBe(409);
    expect(incomplete.json.error?.code).toBe('SSO_IDP_INCOMPLETE');

    const saved = await call('PUT', '/connection', {
      provider: 'saml_microsoft',
      idpMetadataUrl: 'https://login.microsoftonline.com/tenant/federationmetadata.xml',
    });
    expect(saved.json.data.connection).toMatchObject({ idpConfigured: true, idp: { metadataUrl: expect.stringContaining('microsoftonline') } });

    const on = await call('POST', '/connection/activate');
    expect(on.status).toBe(200);
    expect(on.json.data.connection).toMatchObject({ enabled: true, active: true });
    expect([...state.connections.values()][0]!.active).toBe(true);
    expect(await rowOf(ws)).toMatchObject({ enabled: true, clerkActive: true, connectionUpdatedBy: 'user_admin' });

    const off = await call('POST', '/connection/deactivate');
    expect(off.json.data.connection).toMatchObject({ enabled: false, active: false });
    expect([...state.connections.values()][0]!.active).toBe(false);
  });

  it('records every change as workspace_settings.updated, without IdP details', async () => {
    const ws = await seedWorkspace();
    await verifiedDomain(ws, 'audit.example');
    const call = api(ws);
    await call('PUT', '/connection', {
      provider: 'saml_okta',
      idpMetadataUrl: 'https://acme.okta.com/app/metadata',
    });
    await call('POST', '/connection/activate');

    const events = mockedPublish.mock.calls.map(([event]) => event);
    expect(events.map((event) => (event.data as { change: string }).change)).toEqual([
      'domain_claimed',
      'domain_verified',
      'connection_saved',
      'enabled',
    ]);
    expect(events.at(-1)).toMatchObject({
      entityType: 'workspace_settings',
      action: 'updated',
      entityId: ws.id,
      data: { field: 'sso', change: 'enabled', domain: 'audit.example', provider: 'saml_okta', enabled: true },
    });
    expect(JSON.stringify(events.map((event) => event.data))).not.toMatch(/okta\.com|metadata|certificate|acs/i);
  });

  it('a free staff grant entitles a Business workspace', async () => {
    const ws = await seedWorkspace(BUSINESS);
    await verifiedDomain(ws, 'free.example');
    await db.update(workspaceSso).set({ priceOverrideCents: 0 }).where(eq(workspaceSso.workspaceId, ws.id));

    const { status, json } = await api(ws)('PUT', '/connection', { provider: 'saml_google' });

    expect(status).toBe(200);
    expect(json.data.entitlement).toEqual({ entitled: true, source: 'free' });
  });

  it('locks the domain while a connection uses it, and removes the connection from Clerk', async () => {
    const ws = await seedWorkspace();
    await verifiedDomain(ws, 'locked.example');
    const call = api(ws);
    await call('PUT', '/connection', { provider: 'saml_custom' });

    const locked = await call('PUT', '/domain', { domain: 'other.example' });
    expect(locked.status).toBe(409);
    expect(locked.json.error?.code).toBe('SSO_DOMAIN_LOCKED');

    const removed = await call('DELETE', '/connection');
    expect(removed.json.data.connection).toBeNull();
    expect(state.connections.size).toBe(0);
    expect(await rowOf(ws)).toMatchObject({ clerkConnectionId: null, enabled: false, domain: 'locked.example' });
  });

  it('recreates a connection deleted in the Clerk dashboard', async () => {
    const ws = await seedWorkspace();
    await verifiedDomain(ws, 'recreate.example');
    const call = api(ws);
    await call('PUT', '/connection', { provider: 'saml_okta' });
    const firstId = (await rowOf(ws))!.clerkConnectionId;
    state.connections.clear();

    const { status } = await call('PUT', '/connection', { provider: 'saml_okta', idpMetadataUrl: 'https://acme.okta.com/metadata' });

    expect(status).toBe(200);
    const row = await rowOf(ws);
    expect(row!.clerkConnectionId).not.toBe(firstId);
    expect(state.connections.get(row!.clerkConnectionId!)).toMatchObject({ idpMetadataUrl: 'https://acme.okta.com/metadata' });
  });
});

describe('billing pass-through', () => {
  it('needs billing:manage to buy, and forwards to billing-worker as is', async () => {
    const ws = await seedWorkspace(BUSINESS);
    expect((await api(ws)('POST', '/billing/subscribe')).status).toBe(403);
    expect(mockedBilling).not.toHaveBeenCalled();

    mockedBilling.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'PAYMENT_METHOD_REQUIRED', message: 'Add a card' } }), { status: 402 }),
    );
    const { status, json } = await api(ws, permissions('sso:read', 'billing:manage'))('POST', '/billing/subscribe');

    expect(status).toBe(402);
    expect(json.error?.code).toBe('PAYMENT_METHOD_REQUIRED');
    expect(mockedBilling).toHaveBeenCalledWith(expect.anything(), '/api/billing/sso/subscribe', { method: 'POST', body: {} });
  });
});
