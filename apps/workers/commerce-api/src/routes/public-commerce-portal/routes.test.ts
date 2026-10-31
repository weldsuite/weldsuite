/**
 * /public/commerce-portal: the routes integration.test.ts does not reach, on
 * a real tenant database (pglite): the portal config, logout, the company
 * picker, the catalogue, one order, invoices and their printable HTML, return
 * reasons and returns.
 *
 * Buyers sign in the way the portal does: a challenge is stored in the KV
 * stub with a fixed magic-link token, and `/auth/verify` turns it into a
 * session (the token read back from the response). Every id, token and
 * timestamp a request carries is fixed, so the requests are the same on
 * every run.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  kvPutJson,
  pickerKvKey,
  sessionKvKey,
  sha256Hex,
  storeChallenge,
  type PortalChallenge,
  type PortalPicker,
} from '@weldsuite/commerce-domain/portal-tokens';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createMemoryRateLimitNamespace } from '../../testing/memory-rate-limiter';
import type { Env } from '../../types';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

// The entity events still go out (the harness records them); the spy lets the
// tests see what the route published.
vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

import { publicCommercePortalRoutes } from './index';

const BASE = '/public/commerce-portal';
const WORKSPACE_ID = 'ws_test_default';

let db: Database;

class MemoryKV {
  private readonly store = new Map<string, string>();
  /** The portal's rate-limit counters (Durable Object stand-in) travel with the KV, one pair per test. */
  readonly limiter = createMemoryRateLimitNamespace();

  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw == null) return null;
    return type === 'json' ? (JSON.parse(raw) as unknown) : raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

let kv: MemoryKV;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  kv = new MemoryKV();
  vi.mocked(publishEntityEvent).mockClear();
});

function portal(workspaceId = WORKSPACE_ID) {
  return createTestApp(BASE, publicCommercePortalRoutes, {
    context: { tenantDb: db, workspaceId },
    env: {
      WORKSPACE_CACHE: kv as unknown as KVNamespace,
      PORTAL_RATE_LIMITER: kv.limiter as unknown as Env['PORTAL_RATE_LIMITER'],
    },
  });
}

interface CallInit {
  method?: string;
  body?: unknown;
  session?: string;
  headers?: Record<string, string>;
  workspaceId?: string;
}

function call(path: string, init: CallInit = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.session) headers.Authorization = `Bearer ${init.session}`;
  return portal(init.workspaceId).request(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

/** A fixed point in time `minutes` after a base, for rows whose order matters. */
const at = (minutes: number) => new Date(Date.UTC(2030, 0, 1, 0, minutes));

// ── seeds ──────────────────────────────────────────────────────────────────

async function enablePortal(values: Partial<typeof schema.commercePortalSettings.$inferInsert> = {}) {
  await db.delete(schema.commercePortalSettings);
  await db.insert(schema.commercePortalSettings).values({
    id: 'cps_public',
    isEnabled: 1,
    displayName: 'Acme Orders',
    ...values,
  });
}

async function seedCompany(id: string, opts: { party?: boolean } = {}) {
  await db.insert(schema.companies).values({ id, name: `Company ${id}`, displayName: `Company ${id}` });
  const partyId = `pty_${id}`;
  if (opts.party !== false) {
    await db.insert(schema.parties).values({
      id: partyId,
      kind: 'company',
      companyId: id,
      displayName: `Company ${id}`,
      currency: 'EUR',
      paymentTerms: 'Net 30',
    });
  }
  return partyId;
}

interface Buyer {
  email: string;
  personId: string;
  companyId: string;
  partyId: string;
  accessId: string;
}

/** A person with portal access to one company (`co_<key>`). */
async function seedBuyer(key: string): Promise<Buyer> {
  const email = `${key.replace(/_/g, '.')}@example.com`;
  const personId = `pe_${key}`;
  const companyId = `co_${key}`;
  const accessId = `cpa_${key}`;
  const partyId = await seedCompany(companyId);
  await db.insert(schema.people).values({ id: personId, displayName: `Buyer ${key}`, email });
  await db.insert(schema.personCompanies).values({ id: `pc_${key}`, personId, companyId, startedAt: at(0) });
  await db.insert(schema.commercePortalAccess).values({
    id: accessId,
    personId,
    companyId,
    email,
    status: 'invited',
    invitedAt: at(0),
  });
  return { email, personId, companyId, partyId, accessId };
}

/** Store a challenge for `accessIds` under a fixed magic-link token and redeem it. */
async function verifyToken(key: string, email: string, accessIds: string[]): Promise<Response> {
  const token = `magic-${key}`;
  const challenge: PortalChallenge = {
    tokenHash: await sha256Hex(token),
    otpHash: await sha256Hex('123456'),
    email,
    workspaceId: WORKSPACE_ID,
    accessIds,
    attempts: 0,
  };
  await storeChallenge({ WORKSPACE_CACHE: kv as unknown as KVNamespace }, challenge, email);
  return call('/auth/verify', { method: 'POST', body: { token } });
}

/** A signed-in buyer's session token. */
async function signIn(buyer: Buyer): Promise<string> {
  const res = await verifyToken(buyer.accessId, buyer.email, [buyer.accessId]);
  expect(res.status).toBe(200);
  const { token } = await data<{ token: string }>(res);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  return token;
}

async function seedOrder(id: string, partyId: string, values: Partial<typeof schema.orders.$inferInsert> = {}) {
  await db.insert(schema.orders).values({
    id,
    orderNumber: `ORD-${id.toUpperCase()}`,
    counterpartyId: partyId,
    status: 'pending',
    currency: 'EUR',
    subtotal: '10.00',
    total: '10.00',
    source: 'b2b_portal',
    customerName: 'Order Customer',
    customerEmail: 'order.customer@example.com',
    createdAt: at(1),
    updatedAt: at(1),
    ...values,
  });
}

async function seedEntity(id: string, jurisdictionCode: string, locale: string, baseCurrency: string) {
  await db.insert(schema.entities).values({ id, name: `Books ${id}`, jurisdictionCode, baseCurrency, locale });
}

async function seedInvoice(
  id: string,
  values: { entityId: string; partyId: string; contactId: string; status?: string; currency?: string },
) {
  await db.insert(schema.invoices).values({
    id,
    entityId: values.entityId,
    contactId: values.contactId,
    counterpartyId: values.partyId,
    status: values.status ?? 'sent',
    invoiceNumber: id.toUpperCase().replace(/_/g, '-'),
    currency: values.currency ?? 'EUR',
    contactName: 'Invoice Contact',
    issueDate: at(0),
    dueDate: at(60 * 24 * 30),
    subtotal: '40.00',
    taxTotal: '0.00',
    total: '40.00',
    balanceDue: '40.00',
    createdAt: at(2),
    updatedAt: at(2),
  });
}

async function seedInvoiceItem(id: string, invoiceId: string, entityId: string, sortOrder: number, deleted = false) {
  await db.insert(schema.invoiceItems).values({
    id,
    invoiceId,
    entityId,
    description: `Line ${id}`,
    quantity: '2',
    unitPrice: '10.00',
    lineTotal: '20.00',
    sortOrder,
    ...(deleted ? { deletedAt: at(3) } : {}),
  });
}

// ── config ─────────────────────────────────────────────────────────────────

describe('GET /public/commerce-portal/config', () => {
  it('answers the branding of an enabled portal', async () => {
    await enablePortal({
      displayName: 'Acme Orders',
      logo: 'https://cdn.example.com/acme.png',
      primaryColor: '#112233',
      accentColor: null,
    });
    const res = await call('/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { displayName: 'Acme Orders', logo: 'https://cdn.example.com/acme.png', primaryColor: '#112233', accentColor: null },
    });
  });

  it('answers 404 when the portal is disabled or not set up', async () => {
    await enablePortal({ isEnabled: 0 });
    const disabled = await call('/config');
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Portal is not enabled' } });

    await db.delete(schema.commercePortalSettings);
    expect((await call('/config')).status).toBe(404);
  });
});

// ── sessions ───────────────────────────────────────────────────────────────

describe('POST /public/commerce-portal/auth/logout', () => {
  it('ends the session of the bearer token (204)', async () => {
    await enablePortal();
    const buyer = await seedBuyer('logout_buyer');
    const session = await signIn(buyer);
    const key = sessionKvKey(await sha256Hex(session));
    expect(kv.has(key)).toBe(true);
    expect((await call('/me', { session })).status).toBe(200);

    const res = await call('/auth/logout', { method: 'POST', session });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(kv.has(key)).toBe(false);

    const after = await call('/me', { session });
    expect(after.status).toBe(401);
    expect(await errorOf(after)).toEqual({ code: 'UNAUTHORIZED', message: 'Session expired' });
  });

  it('answers 204 without a bearer token, and for an unknown one', async () => {
    expect((await call('/auth/logout', { method: 'POST' })).status).toBe(204);
    expect((await call('/auth/logout', { method: 'POST', headers: { Authorization: 'Basic dXNlcjpwYXNz' } })).status).toBe(204);
    expect((await call('/auth/logout', { method: 'POST', session: 'not-a-session' })).status).toBe(204);
  });
});

describe('GET /public/commerce-portal/me', () => {
  it('answers 401 without a session', async () => {
    const res = await call('/me');
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toEqual({ code: 'UNAUTHORIZED', message: 'Sign in required' });
  });

  it('answers 401 for a session token that was never issued', async () => {
    const res = await call('/me', { session: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toEqual({ code: 'UNAUTHORIZED', message: 'Session expired' });
  });
});

describe('POST /public/commerce-portal/auth/select-company', () => {
  /** One buyer (one person, one email) with access to two companies. */
  async function seedTwoCompanyBuyer(key: string) {
    const email = `${key}@example.com`;
    const personId = `pe_${key}`;
    const first = `co_${key}_1`;
    const second = `co_${key}_2`;
    await seedCompany(first);
    const secondParty = await seedCompany(second);
    await db.insert(schema.people).values({ id: personId, displayName: `Buyer ${key}`, email });
    for (const [n, companyId] of [first, second].entries()) {
      await db.insert(schema.personCompanies).values({ id: `pc_${key}_${n}`, personId, companyId, startedAt: at(0) });
      await db.insert(schema.commercePortalAccess).values({
        id: `cpa_${key}_${n + 1}`,
        personId,
        companyId,
        email,
        status: 'invited',
        invitedAt: at(0),
      });
    }
    return { email, personId, first, second, secondParty, accessIds: [`cpa_${key}_1`, `cpa_${key}_2`] };
  }

  async function storePicker(token: string, picker: PortalPicker) {
    await kvPutJson({ WORKSPACE_CACHE: kv as unknown as KVNamespace }, pickerKvKey(await sha256Hex(token)), picker, 900);
  }

  it('hands a buyer of two companies a picker, then signs them in to the one they pick', async () => {
    await enablePortal();
    const buyer = await seedTwoCompanyBuyer('picker');

    const verified = await verifyToken('picker', buyer.email, buyer.accessIds);
    expect(verified.status).toBe(200);
    const picker = await data<{
      token: null;
      pickerToken: string;
      needsCompanyPicker: boolean;
      companies: Array<{ accessId: string; companyId: string; name: string }>;
    }>(verified);
    expect(picker.token).toBeNull();
    expect(picker.needsCompanyPicker).toBe(true);
    expect(picker.pickerToken).toMatch(/^[0-9a-f]{64}$/);
    expect([...picker.companies].sort((a, b) => a.accessId.localeCompare(b.accessId))).toEqual([
      { accessId: 'cpa_picker_1', companyId: buyer.first, name: `Company ${buyer.first}` },
      { accessId: 'cpa_picker_2', companyId: buyer.second, name: `Company ${buyer.second}` },
    ]);
    const pickerKey = pickerKvKey(await sha256Hex(picker.pickerToken));
    expect(kv.has(pickerKey)).toBe(true);
    // Nobody is signed in yet.
    expect((await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.personId, buyer.personId))).map((r) => r.status)).toEqual(['invited', 'invited']);

    const selected = await call('/auth/select-company', {
      method: 'POST',
      body: { pickerToken: picker.pickerToken, companyId: buyer.second },
    });
    expect(selected.status).toBe(200);
    const { token } = await data<{ token: string }>(selected);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(kv.has(pickerKey)).toBe(false);

    const [chosen] = await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.id, 'cpa_picker_2'));
    expect(chosen?.status).toBe('active');
    expect(chosen?.lastLoginAt).toBeInstanceOf(Date);
    const [other] = await db.select().from(schema.commercePortalAccess).where(eq(schema.commercePortalAccess.id, 'cpa_picker_1'));
    expect(other?.status).toBe('invited');

    const me = await call('/me', { session: token });
    expect(me.status).toBe(200);
    expect(await data(me)).toMatchObject({
      person: { id: buyer.personId, email: buyer.email },
      company: { id: buyer.second, displayName: `Company ${buyer.second}` },
      party: { id: buyer.secondParty, paymentTerms: 'Net 30', currency: 'EUR' },
    });

    // The picker is spent.
    const again = await call('/auth/select-company', {
      method: 'POST',
      body: { pickerToken: picker.pickerToken, companyId: buyer.first },
    });
    expect(again.status).toBe(401);
  });

  it('answers 401 for a picker token that was never issued (or has expired)', async () => {
    const res = await call('/auth/select-company', {
      method: 'POST',
      body: { pickerToken: 'picker-never-issued', companyId: 'co_any' },
    });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid or expired code' });
  });

  it("answers 401 for another workspace's picker", async () => {
    const buyer = await seedTwoCompanyBuyer('picker_ws');
    await storePicker('picker-ws-token', { workspaceId: WORKSPACE_ID, email: buyer.email, accessIds: buyer.accessIds });
    const res = await call('/auth/select-company', {
      method: 'POST',
      body: { pickerToken: 'picker-ws-token', companyId: buyer.first },
      workspaceId: 'ws_other',
    });
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid or expired code' });
    expect(kv.has(pickerKvKey(await sha256Hex('picker-ws-token')))).toBe(true);
  });

  it('answers 400 for a company the picker does not offer', async () => {
    const buyer = await seedTwoCompanyBuyer('picker_unknown');
    const stranger = await seedBuyer('picker_stranger');
    await storePicker('picker-unknown-token', { workspaceId: WORKSPACE_ID, email: buyer.email, accessIds: buyer.accessIds });
    for (const companyId of ['co_not_offered', stranger.companyId]) {
      const res = await call('/auth/select-company', {
        method: 'POST',
        body: { pickerToken: 'picker-unknown-token', companyId },
      });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Unknown company' });
    }
    // A refused pick leaves the picker usable.
    expect(kv.has(pickerKvKey(await sha256Hex('picker-unknown-token')))).toBe(true);
  });

  it('answers 400 for a revoked company access', async () => {
    const buyer = await seedTwoCompanyBuyer('picker_revoked');
    await db
      .update(schema.commercePortalAccess)
      .set({ status: 'revoked' })
      .where(eq(schema.commercePortalAccess.id, 'cpa_picker_revoked_2'));
    await storePicker('picker-revoked-token', { workspaceId: WORKSPACE_ID, email: buyer.email, accessIds: buyer.accessIds });
    const res = await call('/auth/select-company', {
      method: 'POST',
      body: { pickerToken: 'picker-revoked-token', companyId: buyer.second },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Unknown company' });
  });

  it('answers 400 when the picked company has no commercial party record', async () => {
    await seedCompany('co_picker_noparty', { party: false });
    await db.insert(schema.people).values({ id: 'pe_picker_noparty', displayName: 'No Party', email: 'noparty@example.com' });
    await db.insert(schema.commercePortalAccess).values({
      id: 'cpa_picker_noparty',
      personId: 'pe_picker_noparty',
      companyId: 'co_picker_noparty',
      email: 'noparty@example.com',
      status: 'invited',
    });
    await storePicker('picker-noparty-token', {
      workspaceId: WORKSPACE_ID,
      email: 'noparty@example.com',
      accessIds: ['cpa_picker_noparty'],
    });
    const res = await call('/auth/select-company', {
      method: 'POST',
      body: { pickerToken: 'picker-noparty-token', companyId: 'co_picker_noparty' },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Company has no commercial party record' });
  });

  it('refuses a body that does not validate (400)', async () => {
    expect((await call('/auth/select-company', { method: 'POST', body: { pickerToken: 'x' } })).status).toBe(400);
    expect((await call('/auth/select-company', { method: 'POST', body: { pickerToken: '', companyId: 'co_x' } })).status).toBe(400);
  });
});

// ── catalogue ──────────────────────────────────────────────────────────────

describe('GET /public/commerce-portal/products', () => {
  let session: string;
  let buyers = 0;

  beforeAll(async () => {
    // Only this block's products are live.
    await db.update(schema.products).set({ deletedAt: at(0) });
    const product = (id: string, name: string, minute: number, extra: Partial<typeof schema.products.$inferInsert> = {}) => ({
      id,
      name,
      slug: id.replace(/_/g, '-'),
      price: '12.50',
      currency: 'EUR',
      status: 'active',
      visibility: 'visible',
      createdAt: at(minute),
      updatedAt: at(minute),
      ...extra,
    });
    await db.insert(schema.products).values([
      product('prd_bolt_a', 'Hex Bolt A', 1),
      product('prd_bolt_b', 'Hex Bolt B', 2, { visibility: null }),
      product('prd_nut', 'Lock Nut', 3),
      product('prd_hidden', 'Hidden Bolt', 4, { visibility: 'hidden' }),
      product('prd_draft', 'Draft Bolt', 5, { status: 'draft' }),
      product('prd_gone', 'Deleted Bolt', 6, { deletedAt: at(7) }),
    ]);
  });

  beforeEach(async () => {
    await enablePortal();
    buyers += 1;
    const buyer = await seedBuyer(`catalogue_${buyers}`);
    session = await signIn(buyer);
  });

  it('lists active, visible (or unset visibility) products, newest first', async () => {
    const res = await call('/products', { session });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(ids(body.data)).toEqual(['prd_nut', 'prd_bolt_b', 'prd_bolt_a']);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
  });

  it('filters by name, with the unfiltered total', async () => {
    const res = await call('/products?search=Bolt', { session });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(ids(body.data)).toEqual(['prd_bolt_b', 'prd_bolt_a']);
    // The count ignores `search`: it is every product the buyer may see.
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });

    const none = await call('/products?search=Washer', { session });
    expect(ids(await data<Array<{ id: string }>>(none))).toEqual([]);
  });

  it('pages with a cursor', async () => {
    const first = await call('/products?limit=2', { session });
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { data: Array<{ id: string }>; pagination: { cursor: string | null } };
    expect(ids(page1.data)).toEqual(['prd_nut', 'prd_bolt_b']);
    expect(page1.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'prd_bolt_b' });

    const second = await call(`/products?limit=2&cursor=${page1.pagination.cursor}`, { session });
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(ids(page2.data)).toEqual(['prd_bolt_a']);
    expect(page2.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
  });

  it('answers one visible product', async () => {
    const res = await call('/products/prd_bolt_a', { session });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'prd_bolt_a', name: 'Hex Bolt A', price: '12.50', status: 'active' });
    expect((await call('/products/prd_bolt_b', { session })).status).toBe(200);
  });

  it('answers 404 for a hidden, draft, deleted or unknown product', async () => {
    for (const id of ['prd_hidden', 'prd_draft', 'prd_gone', 'prd_missing']) {
      const res = await call(`/products/${id}`, { session });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: `Product with ID '${id}' not found` });
    }
  });

  it('answers 401 without a session', async () => {
    expect((await call('/products')).status).toBe(401);
  });
});

describe('GET /public/commerce-portal/categories', () => {
  it('lists active categories by depth, position and name', async () => {
    await enablePortal();
    const session = await signIn(await seedBuyer('categories_buyer'));
    const category = (id: string, name: string, depth: number, position: number, extra: Partial<typeof schema.categories.$inferInsert> = {}) => ({
      id,
      name,
      slug: id.replace(/_/g, '-'),
      depth,
      position,
      ...extra,
    });
    await db.insert(schema.categories).values([
      category('cat_bolts', 'Bolts', 0, 1),
      category('cat_nuts', 'Nuts', 0, 0),
      category('cat_hex', 'Hex bolts', 1, 0),
      category('cat_anchors', 'Anchors', 1, 0),
      category('cat_inactive', 'Inactive', 0, 0, { isActive: 0 }),
      category('cat_gone', 'Deleted', 0, 0, { deletedAt: at(1) }),
    ]);

    const res = await call('/categories', { session });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(ids(body.data)).toEqual(['cat_nuts', 'cat_bolts', 'cat_anchors', 'cat_hex']);
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
  });
});

// ── orders ─────────────────────────────────────────────────────────────────

describe('GET /public/commerce-portal/orders/:id', () => {
  it("answers the buyer's own order with its items", async () => {
    await enablePortal();
    const buyer = await seedBuyer('order_buyer');
    await seedOrder('ord_own', buyer.partyId, { personId: buyer.personId });
    await db.insert(schema.orderItems).values([
      { id: 'oi_own_b', orderId: 'ord_own', productId: 'prd_x', name: 'Widget', quantity: 2, unitPrice: '2.50', total: '5.00' },
      { id: 'oi_own_a', orderId: 'ord_own', name: 'Gift wrap', quantity: 1, unitPrice: '5.00', total: '5.00' },
    ]);
    const session = await signIn(buyer);

    const res = await call('/orders/ord_own', { session });
    expect(res.status).toBe(200);
    const order = await data<{ id: string; items: Array<{ id: string; name: string; quantity: number }> }>(res);
    expect(order).toMatchObject({ id: 'ord_own', orderNumber: 'ORD-ORD_OWN', counterpartyId: buyer.partyId, total: '10.00' });
    expect(order.items.map((item) => [item.id, item.name, item.quantity])).toEqual([
      ['oi_own_a', 'Gift wrap', 1],
      ['oi_own_b', 'Widget', 2],
    ]);
  });

  it('answers 404 for a deleted order', async () => {
    await enablePortal();
    const buyer = await seedBuyer('order_deleted');
    await seedOrder('ord_deleted', buyer.partyId, { deletedAt: at(5) });
    const session = await signIn(buyer);
    const res = await call('/orders/ord_deleted', { session });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: "Order with ID 'ord_deleted' not found" });
  });
});

// ── invoices ───────────────────────────────────────────────────────────────

describe('GET /public/commerce-portal/invoices/:id', () => {
  it("answers the buyer's own sent invoice with its live items in order", async () => {
    await enablePortal();
    const buyer = await seedBuyer('invoice_buyer');
    await seedEntity('ent_inv_be', 'BE', 'nl-BE', 'EUR');
    await seedInvoice('inv_own', { entityId: 'ent_inv_be', partyId: buyer.partyId, contactId: buyer.personId });
    await seedInvoiceItem('ii_own_second', 'inv_own', 'ent_inv_be', 2);
    await seedInvoiceItem('ii_own_first', 'inv_own', 'ent_inv_be', 1);
    await seedInvoiceItem('ii_own_deleted', 'inv_own', 'ent_inv_be', 0, true);
    const session = await signIn(buyer);

    const res = await call('/invoices/inv_own', { session });
    expect(res.status).toBe(200);
    const invoice = await data<{ id: string; items: Array<{ id: string }> }>(res);
    expect(invoice).toMatchObject({ id: 'inv_own', invoiceNumber: 'INV-OWN', status: 'sent', counterpartyId: buyer.partyId, total: '40.00' });
    expect(ids(invoice.items)).toEqual(['ii_own_first', 'ii_own_second']);
  });

  it("answers 404 for another company's invoice, an own draft and an unknown id", async () => {
    await enablePortal();
    const buyer = await seedBuyer('invoice_scope');
    const otherParty = await seedCompany('co_invoice_other');
    await seedEntity('ent_inv_scope', 'BE', 'nl-BE', 'EUR');
    await seedInvoice('inv_foreign', { entityId: 'ent_inv_scope', partyId: otherParty, contactId: buyer.personId });
    await seedInvoice('inv_own_draft', { entityId: 'ent_inv_scope', partyId: buyer.partyId, contactId: buyer.personId, status: 'draft' });
    const session = await signIn(buyer);

    for (const id of ['inv_foreign', 'inv_own_draft', 'inv_missing']) {
      const res = await call(`/invoices/${id}`, { session });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: `Invoice with ID '${id}' not found` });
    }
  });
});

describe('GET /public/commerce-portal/invoices/:id/pdf', () => {
  it('renders an own invoice as printable HTML in the entity’s language', async () => {
    await enablePortal();
    const buyer = await seedBuyer('invoice_html');
    await seedEntity('ent_html_nl', 'NL', 'nl-NL', 'EUR');
    await seedEntity('ent_html_us', 'US', 'en-US', 'USD');
    await seedInvoice('inv_html_nl', { entityId: 'ent_html_nl', partyId: buyer.partyId, contactId: buyer.personId });
    await seedInvoiceItem('ii_html_nl', 'inv_html_nl', 'ent_html_nl', 0);
    await seedInvoice('inv_html_us', { entityId: 'ent_html_us', partyId: buyer.partyId, contactId: buyer.personId, currency: 'USD' });
    await seedInvoiceItem('ii_html_us', 'inv_html_us', 'ent_html_us', 0);
    const session = await signIn(buyer);

    const nl = await call('/invoices/inv_html_nl/pdf', { session });
    expect(nl.status).toBe(200);
    expect(nl.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(nl.headers.get('content-disposition')).toBe('inline; filename="INV-HTML-NL.html"');
    const nlHtml = await nl.text();
    expect(nlHtml).toContain('<html lang="nl">');
    expect(nlHtml).toContain('INV-HTML-NL');
    expect(nlHtml).toContain('Factuur');
    expect(nlHtml).toContain('Line ii_html_nl');

    const us = await call('/invoices/inv_html_us/pdf', { session });
    expect(us.status).toBe(200);
    expect(us.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(us.headers.get('content-disposition')).toBe('inline; filename="INV-HTML-US.html"');
    const usHtml = await us.text();
    expect(usHtml).toContain('<html lang="en">');
    expect(usHtml).toContain('INV-HTML-US');
    expect(usHtml).toContain('Invoice');
    expect(usHtml).toContain('Line ii_html_us');
  });

  it('answers 500 for an entity in a jurisdiction without an invoice adapter (BE)', async () => {
    // Pins current behaviour: books-domain registers adapters for NL, IN, US
    // and BR only, so a Belgian entity's invoice cannot be rendered.
    await enablePortal();
    const buyer = await seedBuyer('invoice_html_be');
    await seedEntity('ent_html_be', 'BE', 'nl-BE', 'EUR');
    await seedInvoice('inv_html_be', { entityId: 'ent_html_be', partyId: buyer.partyId, contactId: buyer.personId });
    await seedInvoiceItem('ii_html_be', 'inv_html_be', 'ent_html_be', 0);
    const session = await signIn(buyer);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call('/invoices/inv_html_be/pdf', { session });
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toEqual({ code: 'INTERNAL_ERROR', message: 'Failed to generate invoice document' });
    quiet.mockRestore();
  });

  it('answers 404 for an own draft and for an invoice whose entity is gone', async () => {
    await enablePortal();
    const buyer = await seedBuyer('invoice_html_404');
    await seedEntity('ent_html_404', 'BE', 'nl-BE', 'EUR');
    await seedInvoice('inv_html_draft', { entityId: 'ent_html_404', partyId: buyer.partyId, contactId: buyer.personId, status: 'draft' });
    await seedInvoice('inv_html_orphan', { entityId: 'ent_html_missing', partyId: buyer.partyId, contactId: buyer.personId });
    const session = await signIn(buyer);

    for (const id of ['inv_html_draft', 'inv_html_orphan']) {
      const res = await call(`/invoices/${id}/pdf`, { session });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: `Invoice with ID '${id}' not found` });
    }
  });
});

// ── returns ────────────────────────────────────────────────────────────────

describe('GET /public/commerce-portal/return-reasons', () => {
  it('lists the reasons that are not deleted, by display order and label', async () => {
    await enablePortal();
    const session = await signIn(await seedBuyer('reasons_buyer'));
    await db.insert(schema.returnReasons).values([
      { id: 'rr_damaged', code: 'damaged', label: 'Damaged', displayOrder: 2 },
      { id: 'rr_wrong_size', code: 'wrong_size', label: 'Wrong size', displayOrder: 1 },
      { id: 'rr_late', code: 'late', label: 'Arrived late', displayOrder: 1 },
      // Inactive reasons are listed too: only deleted ones are left out.
      { id: 'rr_inactive', code: 'inactive', label: 'Changed mind', displayOrder: 3, isActive: false },
      { id: 'rr_gone', code: 'gone', label: 'Deleted', displayOrder: 0, deletedAt: at(1) },
    ]);

    const res = await call('/return-reasons', { session });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(ids(body.data)).toEqual(['rr_late', 'rr_wrong_size', 'rr_damaged', 'rr_inactive']);
    expect(body.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });
  });
});

describe('GET /public/commerce-portal/returns', () => {
  it('answers an empty list for a buyer without orders', async () => {
    await enablePortal();
    const session = await signIn(await seedBuyer('returns_none'));
    const res = await call('/returns', { session });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  });

  it("lists the returns on the buyer's orders, newest first, with a cursor", async () => {
    await enablePortal();
    const buyer = await seedBuyer('returns_list');
    const otherParty = await seedCompany('co_returns_other');
    await seedOrder('ord_ret_1', buyer.partyId);
    await seedOrder('ord_ret_2', buyer.partyId);
    await seedOrder('ord_ret_foreign', otherParty);
    const ret = (id: string, orderId: string, minute: number, extra: Partial<typeof schema.returns.$inferInsert> = {}) => ({
      id,
      returnNumber: `RMA-${id.toUpperCase()}`,
      originalOrderId: orderId,
      createdAt: at(minute),
      updatedAt: at(minute),
      ...extra,
    });
    await db.insert(schema.returns).values([
      ret('ret_list_1', 'ord_ret_1', 10),
      ret('ret_list_2', 'ord_ret_2', 11),
      ret('ret_list_3', 'ord_ret_1', 12),
      ret('ret_list_foreign', 'ord_ret_foreign', 13),
      ret('ret_list_gone', 'ord_ret_2', 14, { deletedAt: at(15) }),
    ]);
    const session = await signIn(buyer);

    const all = await call('/returns', { session });
    expect(all.status).toBe(200);
    expect(ids(await data<Array<{ id: string }>>(all))).toEqual(['ret_list_3', 'ret_list_2', 'ret_list_1']);

    const first = await call('/returns?limit=2', { session });
    const page1 = (await first.json()) as { data: Array<{ id: string }>; pagination: { cursor: string | null } };
    expect(ids(page1.data)).toEqual(['ret_list_3', 'ret_list_2']);
    // totalCount is the page's length here, not the number of returns.
    expect(page1.pagination).toEqual({ totalCount: 2, hasMore: true, cursor: 'ret_list_2' });

    const second = await call(`/returns?limit=2&cursor=${page1.pagination.cursor}`, { session });
    const page2 = (await second.json()) as { data: Array<{ id: string }>; pagination: unknown };
    expect(ids(page2.data)).toEqual(['ret_list_1']);
    expect(page2.pagination).toEqual({ totalCount: 1, hasMore: false, cursor: null });
  });
});

describe('GET /public/commerce-portal/returns/:id', () => {
  it("answers a return on the buyer's own order, and 404 for anyone else's", async () => {
    await enablePortal();
    const buyer = await seedBuyer('return_get');
    const otherParty = await seedCompany('co_return_get_other');
    await seedOrder('ord_get_own', buyer.partyId);
    await seedOrder('ord_get_foreign', otherParty);
    await db.insert(schema.returns).values([
      { id: 'ret_get_own', returnNumber: 'RMA-GET-OWN', originalOrderId: 'ord_get_own', reason: 'damaged' },
      { id: 'ret_get_foreign', returnNumber: 'RMA-GET-FOREIGN', originalOrderId: 'ord_get_foreign' },
      { id: 'ret_get_orphan', returnNumber: 'RMA-GET-ORPHAN' },
    ]);
    const session = await signIn(buyer);

    const own = await call('/returns/ret_get_own', { session });
    expect(own.status).toBe(200);
    expect(await data(own)).toMatchObject({
      id: 'ret_get_own',
      returnNumber: 'RMA-GET-OWN',
      originalOrderId: 'ord_get_own',
      reason: 'damaged',
      status: 'requested',
    });

    for (const id of ['ret_get_foreign', 'ret_get_orphan', 'ret_get_missing']) {
      const res = await call(`/returns/${id}`, { session });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: `Return with ID '${id}' not found` });
    }
  });
});

describe('POST /public/commerce-portal/returns', () => {
  async function seedReturnableOrder(key: string) {
    await enablePortal();
    const buyer = await seedBuyer(key);
    const orderId = `ord_${key}`;
    await seedOrder(orderId, buyer.partyId);
    await db.insert(schema.orderItems).values([
      { id: `oi_${key}_w`, orderId, productId: 'prd_widget', name: 'Widget', quantity: 2, unitPrice: '2.50', total: '5.00' },
      { id: `oi_${key}_g`, orderId, name: 'Gift wrap', quantity: 1, unitPrice: '5.00', total: '5.00' },
    ]);
    return { buyer, orderId, session: await signIn(buyer) };
  }

  it('requests a return on an own order (201) and publishes return.created', async () => {
    const { buyer, orderId, session } = await seedReturnableOrder('return_create');
    const items = [
      { productId: 'prd_widget', productName: 'Widget', quantity: 2, condition: 'damaged' },
      { productName: 'Gift wrap', quantity: 1 },
    ];
    const res = await call('/returns', {
      method: 'POST',
      session,
      body: { originalOrderId: orderId, reason: 'damaged', reasonDetails: 'Crushed box', items, customerNotes: 'Please collect' },
    });
    expect(res.status).toBe(201);
    const created = await data<{ id: string; returnNumber: string }>(res);
    expect(created).toMatchObject({
      id: expect.stringMatching(/^ret_/),
      returnNumber: expect.stringMatching(/^RMA-[0-9A-Z]+-[0-9A-Z]{4}$/),
      status: 'requested',
      originalOrderId: orderId,
      customerId: buyer.partyId,
      customerName: 'Buyer return_create',
      customerEmail: buyer.email,
      reason: 'damaged',
      reasonDetails: 'Crushed box',
      customerNotes: 'Please collect',
      approvalStatus: 'pending',
      items,
    });
    const [row] = await db.select().from(schema.returns).where(eq(schema.returns.id, created.id));
    expect(row).toMatchObject({ originalOrderId: orderId, status: 'requested', items });

    expect(publishEntityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'return',
        action: 'created',
        data: expect.objectContaining({ originalOrderId: orderId, status: 'requested' }),
      }),
    );
  });

  it('checks each line on its own against the ordered quantity', async () => {
    const { orderId, session } = await seedReturnableOrder('return_lines');
    // Two lines of 2 for a product ordered twice: each fits on its own.
    const res = await call('/returns', {
      method: 'POST',
      session,
      body: {
        originalOrderId: orderId,
        items: [
          { productId: 'prd_widget', productName: 'Widget', quantity: 2 },
          { productId: 'prd_widget', productName: 'Widget', quantity: 2 },
        ],
      },
    });
    expect(res.status).toBe(201);
  });

  it('answers 400 when the items are not a subset of the order', async () => {
    const { orderId, session } = await seedReturnableOrder('return_subset');
    const cases = [
      [{ productId: 'prd_widget', productName: 'Widget', quantity: 3 }],
      [{ productName: 'Gift wrap', quantity: 2 }],
      [{ productName: 'Never ordered', quantity: 1 }],
      [{ productId: 'prd_other', productName: 'Widget', quantity: 1 }],
    ];
    for (const items of cases) {
      const res = await call('/returns', { method: 'POST', session, body: { originalOrderId: orderId, items } });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Return items must be a subset of the original order' });
    }
    expect(await db.select().from(schema.returns).where(eq(schema.returns.originalOrderId, orderId))).toHaveLength(0);
    expect(publishEntityEvent).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown order', async () => {
    const { session } = await seedReturnableOrder('return_missing');
    const res = await call('/returns', {
      method: 'POST',
      session,
      body: { originalOrderId: 'ord_never', items: [{ productName: 'Widget', quantity: 1 }] },
    });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: "Order with ID 'ord_never' not found" });
  });

  it('refuses a body that does not validate (400)', async () => {
    const { orderId, session } = await seedReturnableOrder('return_invalid');
    const bodies = [
      { originalOrderId: orderId, items: [] },
      { originalOrderId: orderId, items: [{ productName: 'Widget', quantity: 0 }] },
      { originalOrderId: orderId, items: [{ productName: 'Widget', quantity: 1, condition: 'used' }] },
      { items: [{ productName: 'Widget', quantity: 1 }] },
    ];
    for (const body of bodies) {
      expect((await call('/returns', { method: 'POST', session, body })).status).toBe(400);
    }
  });
});
