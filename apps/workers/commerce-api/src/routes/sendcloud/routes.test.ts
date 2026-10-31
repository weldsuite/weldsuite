/**
 * Every /api/sendcloud route on pglite, refusals included: the public
 * settings (not connected and connected), the sender / method switches,
 * disconnect, the catalogue sync and the label PDF proxy, with Sendcloud's
 * API v3 as a `fetch` stub. `PUT /connect`'s success and 401 paths are in
 * ./integration.test.ts.
 *
 * The settings live on `workspace_settings.custom_settings.sendcloud` keyed by
 * the Clerk org id, so each scenario uses its own org id (its own row) and
 * the scenarios cannot disturb each other. Keys are stored in plain text: with
 * no `DATABASE_ENCRYPTION_KEY` the routes neither encrypt nor need to decrypt.
 *
 * Conformance-ready: the stub answers by method, URL and the Basic auth
 * header (revoked keys get a 401), never by call order.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { sendcloudRoutes } from './index';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const BASE = '/api/sendcloud';
const SENDCLOUD = 'https://panel.sendcloud.sc/api/v3';

const ORG_EMPTY = 'org_sc_empty';
const ORG_LIVE = 'org_sc_live';
const ORG_SYNC = 'org_sc_sync';
const ORG_REVOKED = 'org_sc_revoked';
const ORG_DROP = 'org_sc_drop';
const ORG_FRESH = 'org_sc_fresh';

let db: Database;

// ── Sendcloud, answered by method + URL + credentials ───────────────────────

const realFetch = globalThis.fetch;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const basicAuth = (publicKey: string, secretKey: string) => `Basic ${btoa(`${publicKey}:${secretKey}`)}`;

const PDF = '%PDF-1.4 sendcloud test label';

/** Parcel ids whose label Sendcloud refuses, with the status it answers. */
const REFUSED_PARCELS = new Set(['402', '404', '422', '429', '500']);

const SENDER_ACME = {
  id: 1,
  company_name: 'Acme BV',
  contact_name: 'Ann',
  email: 'ship@acme.example',
  phone_number: '+31 40 123',
  country: 'nl',
  postal_code: '5611EM',
  city: 'Eindhoven',
  address_line_1: 'Stadhuisplein',
  house_number: '10',
  is_default: true,
};

const SENDER_DEPOT = {
  id: 3,
  name: 'Depot',
  country_code: 'BE',
  postal_code: '2000',
  city: 'Antwerpen',
  street: 'Kaai',
  house_number: '1',
};

const SHIPPING_OPTIONS = [
  {
    code: 'postnl:standard',
    product: { name: 'PostNL Standard' },
    carrier: { code: 'postnl', name: 'PostNL' },
    weight: { min: { value: '0.001' }, max: { value: '23.000' } },
    requirements: { is_service_point_required: false },
    functionalities: { returns: false },
  },
  { code: 'dhl:servicepoint', name: 'DHL Service Point', requirements: { is_service_point_required: true } },
  { code: 'postnl:return', product: { name: 'PostNL Return' }, functionalities: { returns: true } },
  { code: 'dpd:home', name: 'DPD Home', carrier: { code: 'dpd' } },
];

function sendcloud(method: string, url: URL, init?: RequestInit): Response {
  if (new Headers(init?.headers).get('authorization') === basicAuth('pk_revoked', 'sk_revoked')) {
    return Response.json({ error: { message: 'Invalid credentials' } }, { status: 401 });
  }
  const path = url.pathname.slice('/api/v3'.length);
  if (path === '/addresses/sender-addresses' && method === 'GET') {
    if (url.searchParams.get('cursor') === 'page2') return Response.json({ data: [SENDER_DEPOT] });
    return Response.json(
      { data: [SENDER_ACME] },
      { headers: { Link: `<${SENDCLOUD}/addresses/sender-addresses?cursor=page2&page_size=100>; rel="next"` } },
    );
  }
  if (path === '/shipping-options' && method === 'POST') return Response.json({ data: SHIPPING_OPTIONS });
  const parcelId = /^\/parcels\/(\d+)\/documents\/label$/.exec(path)?.[1];
  if (parcelId && method === 'GET') {
    if (REFUSED_PARCELS.has(parcelId)) {
      return Response.json({ error: { message: `Parcel ${parcelId} refused` } }, { status: Number(parcelId) });
    }
    return new Response(PDF, { headers: { 'Content-Type': 'application/pdf' } });
  }
  return Response.json({ error: { message: 'Unknown endpoint' } }, { status: 404 });
}

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(urlOf(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  if (url.href.startsWith(SENDCLOUD)) return sendcloud(method, url, init);
  // The conformance harness's own calls (the Rust server, the bridges).
  return realFetch(input, init);
});

function sendcloudCalls(method: string, prefix: string) {
  return fetchStub.mock.calls
    .map(([input, init]) => ({ url: urlOf(input), method: (init?.method ?? 'GET').toUpperCase(), body: init?.body }))
    .filter((call) => call.method === method && call.url.startsWith(`${SENDCLOUD}${prefix}`));
}

// ── the app ──────────────────────────────────────────────────────────────────

function api(clerkOrgId: string, ...keys: string[]) {
  return createTestApp(BASE, sendcloudRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, clerkOrgId },
  }).request;
}

const reader = (org: string) => api(org, 'integrations:read');
const writer = (org: string) => api(org, 'integrations:update');

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function dataOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response): Promise<{ code: string; message: string; details?: unknown }> {
  return ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;
}

interface PublicSettings {
  connected: boolean;
  publicKeyMasked: string | null;
  accountName: string | null;
  lastSyncedAt: string | null;
  senders: Array<{ id: number; name: string; enabled: boolean; isDefault: boolean }>;
  methods: Array<{ code: string; name: string; enabled: boolean; isDefault: boolean }>;
}

const senderRow = (id: number, name: string, enabled: boolean, isDefault: boolean) => ({
  id,
  name,
  companyName: name,
  contactName: null,
  email: null,
  phone: null,
  addressLine1: 'Street',
  addressLine2: null,
  houseNumber: '1',
  postalCode: '1000AA',
  city: 'Amsterdam',
  countryCode: 'NL',
  enabled,
  isDefault,
});

const methodRow = (code: string, name: string, enabled: boolean, isDefault: boolean) => ({
  code,
  name,
  carrierCode: code.split(':')[0],
  carrierName: null,
  minWeightKg: null,
  maxWeightKg: null,
  enabled,
  isDefault,
});

async function seedSettings(id: string, customSettings: Record<string, unknown>) {
  await db.insert(schema.workspaceSettings).values({
    id,
    customSettings,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
  });
}

async function storedCustom(id: string): Promise<Record<string, unknown> | null | undefined> {
  const [row] = await db
    .select({ customSettings: schema.workspaceSettings.customSettings })
    .from(schema.workspaceSettings)
    .where(eq(schema.workspaceSettings.id, id))
    .limit(1);
  return row?.customSettings;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  db = (await createPgliteDb()).db;

  await seedSettings(ORG_LIVE, {
    sendcloud: {
      publicKey: 'pk_live_12345678',
      secretKey: 'sk_live_secret',
      accountName: 'Acme',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      senders: [senderRow(1, 'Acme', true, true), senderRow(2, 'Depot', false, false)],
      methods: [methodRow('postnl:standard', 'PostNL Standard', true, true), methodRow('dhl:express', 'DHL Express', false, false)],
    },
  });
  await seedSettings(ORG_SYNC, {
    sendcloud: {
      publicKey: 'pk_sync_key',
      secretKey: 'sk_sync',
      senders: [senderRow(3, 'Depot', true, false)],
      methods: [methodRow('dpd:home', 'DPD Home', true, true)],
    },
  });
  await seedSettings(ORG_REVOKED, {
    sendcloud: { publicKey: 'pk_revoked', secretKey: 'sk_revoked', senders: [], methods: [] },
  });
  await seedSettings(ORG_DROP, {
    printnode: { apiKey: 'pn_key' },
    sendcloud: { publicKey: 'pk_drop', secretKey: 'sk_drop', senders: [senderRow(1, 'Acme', true, true)], methods: [] },
  });
}, 60_000);

beforeEach(() => {
  fetchStub.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── GET / ────────────────────────────────────────────────────────────────────

describe('GET /api/sendcloud', () => {
  it('answers a disconnected shape when nothing is stored', async () => {
    const res = await reader(ORG_EMPTY)(BASE);
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({
      connected: false,
      publicKeyMasked: null,
      accountName: null,
      lastSyncedAt: null,
      senders: [],
      methods: [],
    });
  });

  it('answers the stored connection with the public key masked and no secret', async () => {
    // picklists:read alone is enough: either permission opens the route.
    const res = await api(ORG_LIVE, 'picklists:read')(BASE);
    expect(res.status).toBe(200);
    const data = await dataOf<PublicSettings>(res);
    expect(data).toMatchObject({
      connected: true,
      publicKeyMasked: 'pk_l…5678',
      accountName: 'Acme',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(data.senders).toEqual([senderRow(1, 'Acme', true, true), senderRow(2, 'Depot', false, false)]);
    expect(data.methods.map((m) => m.code)).toEqual(['postnl:standard', 'dhl:express']);
    expect(JSON.stringify(data)).not.toContain('sk_live_secret');
  });

  it('is gated on integrations:read or picklists:read', async () => {
    expect((await api(ORG_LIVE, 'integrations:update')(BASE)).status).toBe(403);
  });
});

// ── PATCH / ──────────────────────────────────────────────────────────────────

describe('PATCH /api/sendcloud', () => {
  it('switches senders and methods on, and moves the default', async () => {
    const res = await writer(ORG_LIVE)(
      BASE,
      json({ senders: [{ id: 2, isDefault: true }], methods: [{ code: 'dhl:express', enabled: true }] }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const data = await dataOf<PublicSettings>(res);
    expect(data.connected).toBe(true);
    expect(data.senders.map(({ id, enabled, isDefault }) => ({ id, enabled, isDefault }))).toEqual([
      { id: 1, enabled: true, isDefault: false },
      { id: 2, enabled: false, isDefault: true },
    ]);
    expect(data.methods.map(({ code, enabled, isDefault }) => ({ code, enabled, isDefault }))).toEqual([
      { code: 'postnl:standard', enabled: true, isDefault: true },
      { code: 'dhl:express', enabled: true, isDefault: false },
    ]);

    const stored = (await storedCustom(ORG_LIVE))?.sendcloud as { secretKey?: string; senders: Array<{ isDefault: boolean }> };
    expect(stored.secretKey).toBe('sk_live_secret');
    expect(stored.senders.map((s) => s.isDefault)).toEqual([false, true]);
  });

  it('refuses when Sendcloud is not connected, and a bad body (400)', async () => {
    const notConnected = await writer(ORG_EMPTY)(BASE, json({ methods: [] }, 'PATCH'));
    expect(notConnected.status).toBe(400);
    expect(await errorOf(notConnected)).toEqual({ code: 'BAD_REQUEST', message: 'Sendcloud is not connected' });
    expect((await writer(ORG_LIVE)(BASE, json({ senders: [{ id: 'one' }] }, 'PATCH'))).status).toBe(400);
    expect((await writer(ORG_LIVE)(BASE, json({ methods: [{ code: '' }] }, 'PATCH'))).status).toBe(400);
  });

  it('is gated on integrations:create or integrations:update', async () => {
    expect((await reader(ORG_LIVE)(BASE, json({ methods: [] }, 'PATCH'))).status).toBe(403);
    expect((await api(ORG_LIVE, 'integrations:create')(BASE, json({ methods: [] }, 'PATCH'))).status).toBe(200);
  });
});

// ── DELETE / ─────────────────────────────────────────────────────────────────

describe('DELETE /api/sendcloud', () => {
  it('forgets the keys and the catalogue, keeping the other custom settings', async () => {
    const res = await writer(ORG_DROP)(BASE, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await storedCustom(ORG_DROP)).toEqual({
      printnode: { apiKey: 'pn_key' },
      sendcloud: { senders: [], methods: [] },
    });
    expect(await dataOf(await reader(ORG_DROP)(BASE))).toMatchObject({ connected: false, senders: [], methods: [] });
  });

  it('creates the settings row when the workspace has none', async () => {
    expect((await writer(ORG_FRESH)(BASE, { method: 'DELETE' })).status).toBe(204);
    expect(await storedCustom(ORG_FRESH)).toEqual({ sendcloud: { senders: [], methods: [] } });
  });

  it('is gated on integrations:create or integrations:update', async () => {
    expect((await reader(ORG_LIVE)(BASE, { method: 'DELETE' })).status).toBe(403);
  });
});

// ── POST /sync ───────────────────────────────────────────────────────────────

describe('POST /api/sendcloud/sync', () => {
  it('pulls every sender page and the usable shipping options, keeping earlier switches', async () => {
    const res = await writer(ORG_SYNC)(`${BASE}/sync`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await dataOf<PublicSettings>(res);
    expect(data).toMatchObject({ connected: true, publicKeyMasked: 'pk_s…_key', accountName: 'Acme BV' });
    expect(typeof data.lastSyncedAt).toBe('string');
    expect(data.senders).toEqual([
      {
        id: 1,
        name: 'Acme BV',
        companyName: 'Acme BV',
        contactName: 'Ann',
        email: 'ship@acme.example',
        phone: '+31 40 123',
        addressLine1: 'Stadhuisplein',
        addressLine2: null,
        houseNumber: '10',
        postalCode: '5611EM',
        city: 'Eindhoven',
        countryCode: 'NL',
        enabled: false,
        isDefault: true,
      },
      {
        id: 3,
        name: 'Depot',
        companyName: null,
        contactName: 'Depot',
        email: null,
        phone: null,
        addressLine1: 'Kaai',
        addressLine2: null,
        houseNumber: '1',
        postalCode: '2000',
        city: 'Antwerpen',
        countryCode: 'BE',
        enabled: true,
        isDefault: false,
      },
    ]);
    expect(data.methods).toEqual([
      {
        code: 'postnl:standard',
        name: 'PostNL Standard',
        carrierCode: 'postnl',
        carrierName: 'PostNL',
        minWeightKg: 0.001,
        maxWeightKg: 23,
        enabled: false,
        isDefault: false,
      },
      {
        code: 'dpd:home',
        name: 'DPD Home',
        carrierCode: 'dpd',
        carrierName: null,
        minWeightKg: null,
        maxWeightKg: null,
        enabled: true,
        isDefault: true,
      },
    ]);

    const pages = sendcloudCalls('GET', '/addresses/sender-addresses').map((c) => c.url);
    expect(pages).toContain(`${SENDCLOUD}/addresses/sender-addresses?page_size=100`);
    expect(pages).toContain(`${SENDCLOUD}/addresses/sender-addresses?cursor=page2&page_size=100`);
    const [quote] = sendcloudCalls('POST', '/shipping-options');
    const from = {
      country_code: 'NL',
      postal_code: '5611EM',
      city: 'Eindhoven',
      address_line_1: 'Stadhuisplein',
      house_number: '10',
    };
    expect(JSON.parse(String(quote?.body))).toEqual({
      from_address: from,
      to_address: from,
      parcels: [{ weight: { value: '1', unit: 'kg' } }],
      calculate_quotes: false,
    });

    const stored = (await storedCustom(ORG_SYNC))?.sendcloud as { secretKey?: string; accountName?: string };
    expect(stored).toMatchObject({ secretKey: 'sk_sync', accountName: 'Acme BV' });
  });

  it('refuses when Sendcloud is not connected (400)', async () => {
    const res = await writer(ORG_EMPTY)(`${BASE}/sync`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Sendcloud is not connected' });
  });

  it("passes Sendcloud's 401 on, and keeps the stored settings", async () => {
    const res = await writer(ORG_REVOKED)(`${BASE}/sync`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    expect(await storedCustom(ORG_REVOKED)).toEqual({
      sendcloud: { publicKey: 'pk_revoked', secretKey: 'sk_revoked', senders: [], methods: [] },
    });
  });

  it('is gated on integrations:create or integrations:update', async () => {
    expect((await reader(ORG_SYNC)(`${BASE}/sync`, { method: 'POST' })).status).toBe(403);
  });
});

// ── PUT /connect (refusals; the success path is in integration.test.ts) ─────

describe('PUT /api/sendcloud/connect', () => {
  it('refuses a bad body (400) and a missing permission (403)', async () => {
    expect((await writer(ORG_EMPTY)(`${BASE}/connect`, json({ publicKey: 'pk' }, 'PUT'))).status).toBe(400);
    expect((await writer(ORG_EMPTY)(`${BASE}/connect`, json({ publicKey: '', secretKey: 'sk' }, 'PUT'))).status).toBe(400);
    expect((await reader(ORG_EMPTY)(`${BASE}/connect`, json({ publicKey: 'pk', secretKey: 'sk' }, 'PUT'))).status).toBe(403);
    expect(sendcloudCalls('GET', '/addresses')).toEqual([]);
  });
});

// ── GET /labels/:parcelId ────────────────────────────────────────────────────

describe('GET /api/sendcloud/labels/:parcelId', () => {
  it('streams the label PDF inline', async () => {
    const res = await reader(ORG_LIVE)(`${BASE}/labels/123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="sendcloud-label-123.pdf"');
    expect(await res.text()).toBe(PDF);
    expect(sendcloudCalls('GET', '/parcels/123/documents/label').length).toBeGreaterThan(0);
  });

  it('reads the id as a JS number, so 1e2 is parcel 100', async () => {
    const res = await api(ORG_LIVE, 'picklists:read')(`${BASE}/labels/1e2`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('inline; filename="sendcloud-label-100.pdf"');
    expect(sendcloudCalls('GET', '/parcels/100/documents/label').length).toBeGreaterThan(0);
  });

  it('refuses a non-numeric id and a workspace without Sendcloud (400)', async () => {
    const bad = await reader(ORG_LIVE)(`${BASE}/labels/abc`);
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toEqual({ code: 'BAD_REQUEST', message: 'Invalid parcel id' });
    const notConnected = await reader(ORG_EMPTY)(`${BASE}/labels/123`);
    expect(notConnected.status).toBe(400);
    expect(await errorOf(notConnected)).toEqual({ code: 'BAD_REQUEST', message: 'Sendcloud is not connected' });
  });

  it("maps Sendcloud's refusals: 404, 402, 422, 429 and 5xx", async () => {
    const request = reader(ORG_LIVE);
    const notFound = await request(`${BASE}/labels/404`);
    expect(notFound.status).toBe(404);
    expect(await errorOf(notFound)).toEqual({ code: 'NOT_FOUND', message: 'Sendcloud resource not found' });

    const payment = await request(`${BASE}/labels/402`);
    expect(payment.status).toBe(402);
    expect(await errorOf(payment)).toEqual({
      code: 'PAYMENT_REQUIRED',
      message: 'Parcel 402 refused',
      details: { error: { message: 'Parcel 402 refused' } },
    });

    const invalid = await request(`${BASE}/labels/422`);
    expect(invalid.status).toBe(400);
    expect(await errorOf(invalid)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Parcel 422 refused',
      details: { error: { message: 'Parcel 422 refused' } },
    });

    for (const parcelId of ['429', '500']) {
      const res = await request(`${BASE}/labels/${parcelId}`);
      expect(res.status).toBe(500);
      expect(await errorOf(res)).toEqual({ code: 'INTERNAL_ERROR', message: `Parcel ${parcelId} refused` });
    }
  });

  it('is gated on integrations:read or picklists:read', async () => {
    expect((await writer(ORG_LIVE)(`${BASE}/labels/123`)).status).toBe(403);
  });
});
