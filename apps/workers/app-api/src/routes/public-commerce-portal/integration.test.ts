/**
 * DB-backed isolation tests for /public/commerce-portal.
 *
 * Portal tables have no drizzle migration yet (pending approval), so this
 * file applies CREATE TABLE IF NOT EXISTS — the same pattern as the Nango
 * pglite tests. KV is an in-memory stub because the harness WORKSPACE_CACHE
 * is an empty object.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { publicCommercePortalRoutes } from './index';
import { createTestApp } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import {
  otpKvKey,
  sha256Hex,
  storeChallenge,
  type PortalChallenge,
} from '../../lib/commerce-portal-tokens';
import type { Env } from '../../types';

let db: Database;

const DDL = `
CREATE TABLE IF NOT EXISTS commerce_portal_settings (
  id varchar(30) PRIMARY KEY,
  is_enabled integer NOT NULL DEFAULT 0,
  display_name varchar(255),
  logo varchar(500),
  primary_color varchar(20),
  accent_color varchar(20),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp
);
CREATE TABLE IF NOT EXISTS commerce_portal_access (
  id varchar(30) PRIMARY KEY,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  person_id varchar(30) NOT NULL,
  company_id varchar(30) NOT NULL,
  email varchar(255) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'invited',
  invited_by varchar(255),
  invited_at timestamp,
  last_login_at timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_portal_access_person_company_uidx
  ON commerce_portal_access (person_id, company_id);
`;

class MemoryKV {
  private store = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw == null) return null;
    if (type === 'json') return JSON.parse(raw);
    return raw;
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

  keys(): string[] {
    return [...this.store.keys()];
  }
}

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function portalApp(kv: MemoryKV) {
  return createTestApp('/public/commerce-portal', publicCommercePortalRoutes, {
    context: { tenantDb: db, workspaceId: 'org_test_default' },
    env: { WORKSPACE_CACHE: kv as unknown as KVNamespace },
  });
}

async function enablePortal() {
  await db.delete(schema.commercePortalSettings);
  await db.insert(schema.commercePortalSettings).values({
    id: uid('cps'),
    isEnabled: 1,
    displayName: 'Acme Orders',
  });
}

async function seedCompany(label: string) {
  const companyId = uid('co');
  const partyId = uid('pty');
  await db.insert(schema.companies).values({
    id: companyId,
    name: label,
    displayName: label,
  });
  await db.insert(schema.parties).values({
    id: partyId,
    kind: 'company',
    companyId,
    displayName: label,
    currency: 'EUR',
    paymentTerms: 'Net 30',
  });
  return { companyId, partyId };
}

async function seedPerson(email: string, name: string) {
  const personId = uid('pe');
  await db.insert(schema.people).values({
    id: personId,
    displayName: name,
    email,
  });
  return personId;
}

async function linkPerson(personId: string, companyId: string) {
  await db.insert(schema.personCompanies).values({
    id: uid('pc'),
    personId,
    companyId,
    startedAt: new Date(),
  });
}

async function seedAccess(opts: {
  personId: string;
  companyId: string;
  email: string;
  status?: 'invited' | 'active' | 'revoked';
}) {
  const id = uid('cpa');
  await db.insert(schema.commercePortalAccess).values({
    id,
    personId: opts.personId,
    companyId: opts.companyId,
    email: opts.email,
    status: opts.status ?? 'invited',
    invitedAt: new Date(),
  });
  return id;
}

async function seedProduct(opts: {
  name: string;
  price: string;
  status?: string;
  visibility?: string | null;
}) {
  const id = uid('prd');
  await db.insert(schema.products).values({
    id,
    name: opts.name,
    slug: uid('sl'),
    price: opts.price,
    status: opts.status ?? 'active',
    visibility: opts.visibility === undefined ? 'visible' : opts.visibility,
    currency: 'EUR',
  });
  return id;
}

async function seedOrder(partyId: string, personId?: string) {
  const id = uid('ord');
  await db.insert(schema.orders).values({
    id,
    orderNumber: `ORD-${id.slice(-6).toUpperCase()}`,
    counterpartyId: partyId,
    personId,
    status: 'pending',
    currency: 'EUR',
    subtotal: '10.00',
    total: '10.00',
    source: 'b2b_portal',
  });
  return id;
}

async function verifySession(
  kv: MemoryKV,
  access: { id: string; email: string },
): Promise<string> {
  const env = { WORKSPACE_CACHE: kv } as unknown as Env;
  const token = `magic_${uid('tok')}`;
  const challenge: PortalChallenge = {
    tokenHash: await sha256Hex(token),
    otpHash: await sha256Hex('123456'),
    email: access.email,
    workspaceId: 'org_test_default',
    accessIds: [access.id],
    attempts: 0,
  };
  await storeChallenge(env, challenge, access.email);

  const { request } = portalApp(kv);
  const res = await request('/public/commerce-portal/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { token: string } };
  expect(body.data.token).toBeTruthy();
  return body.data.token;
}

function authHeaders(session: string): HeadersInit {
  return {
    Authorization: `Bearer ${session}`,
    'Content-Type': 'application/json',
  };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  for (const statement of DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }
}, 60_000);

describe('/public/commerce-portal · auth', () => {
  it('returns 200 for an uninvited email and does not issue a challenge', async () => {
    await enablePortal();
    const kv = new MemoryKV();
    const { request } = portalApp(kv);
    const email = `nobody.${uid('e')}@example.com`;

    const res = await request('/public/commerce-portal/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, slug: 'acme' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(body.data.ok).toBe(true);
    expect(kv.has(otpKvKey('org_test_default', email))).toBe(false);
    expect(kv.keys().some((k) => k.startsWith('cportal:tok:'))).toBe(false);
  });

  it('issues a challenge for an invited email', async () => {
    await enablePortal();
    const kv = new MemoryKV();
    const email = `buyer.${uid('e')}@example.com`;
    const { companyId } = await seedCompany('Invited Co');
    const personId = await seedPerson(email, 'Invited Buyer');
    await linkPerson(personId, companyId);
    await seedAccess({ personId, companyId, email, status: 'invited' });

    const { request } = portalApp(kv);
    const res = await request('/public/commerce-portal/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, slug: 'acme' }),
    });
    expect(res.status).toBe(200);
    expect(kv.has(otpKvKey('org_test_default', email))).toBe(true);
  });

  it('returns 401 after access is revoked', async () => {
    await enablePortal();
    const kv = new MemoryKV();
    const email = `revoked.${uid('e')}@example.com`;
    const { companyId } = await seedCompany('Revoke Co');
    const personId = await seedPerson(email, 'Soon Revoked');
    await linkPerson(personId, companyId);
    const accessId = await seedAccess({ personId, companyId, email, status: 'invited' });
    const session = await verifySession(kv, { id: accessId, email });

    await db
      .update(schema.commercePortalAccess)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(schema.commercePortalAccess.id, accessId));

    const { request } = portalApp(kv);
    const res = await request('/public/commerce-portal/me', {
      headers: { Authorization: `Bearer ${session}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('/public/commerce-portal · orders', () => {
  it('cannot list another company’s orders after verify', async () => {
    await enablePortal();
    const kv = new MemoryKV();
    const email = `iso.${uid('e')}@example.com`;
    const a = await seedCompany('Alpha Co');
    const b = await seedCompany('Beta Co');
    const personId = await seedPerson(email, 'Alpha Buyer');
    await linkPerson(personId, a.companyId);
    const accessId = await seedAccess({ personId, companyId: a.companyId, email, status: 'invited' });
    const foreignOrderId = await seedOrder(b.partyId);
    const ownOrderId = await seedOrder(a.partyId, personId);

    const session = await verifySession(kv, { id: accessId, email });
    const { request } = portalApp(kv);
    const listRes = await request('/public/commerce-portal/orders', {
      headers: authHeaders(session),
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const ids = list.data.map((row) => row.id);
    expect(ids).toContain(ownOrderId);
    expect(ids).not.toContain(foreignOrderId);

    const foreignGet = await request(`/public/commerce-portal/orders/${foreignOrderId}`, {
      headers: authHeaders(session),
    });
    expect(foreignGet.status).toBe(404);
  });

  it('places an order using catalog price, ignoring client-supplied prices', async () => {
    await enablePortal();
    const kv = new MemoryKV();
    const email = `price.${uid('e')}@example.com`;
    const { companyId, partyId } = await seedCompany('Price Co');
    const personId = await seedPerson(email, 'Pricer');
    await linkPerson(personId, companyId);
    const accessId = await seedAccess({ personId, companyId, email, status: 'invited' });
    const productId = await seedProduct({ name: 'Widget', price: '12.50' });
    const session = await verifySession(kv, { id: accessId, email });

    const { request } = portalApp(kv);
    const res = await request('/public/commerce-portal/orders', {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({
        items: [{ productId, quantity: 2, unitPrice: '0.01', price: 0.01 }],
        purchaseOrderNumber: 'PO-99',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; total: string; source: string; paymentReference: string | null; items: Array<{ unitPrice: string; total: string; productId: string }> };
    };
    expect(body.data.source).toBe('b2b_portal');
    expect(body.data.paymentReference).toBe('PO-99');
    expect(Number(body.data.total)).toBe(25);
    expect(body.data.items).toHaveLength(1);
    expect(Number(body.data.items[0]!.unitPrice)).toBe(12.5);
    expect(Number(body.data.items[0]!.total)).toBe(25);
    expect(body.data.items[0]!.productId).toBe(productId);

    const persisted = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, body.data.id));
    expect(persisted).toHaveLength(1);
    expect(Number(persisted[0]!.unitPrice)).toBe(12.5);

    const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, body.data.id)).limit(1);
    expect(order?.counterpartyId).toBe(partyId);
    expect(order?.paymentMethod).toBe('account');
  });

  it('rejects inactive or hidden products with 400', async () => {
    await enablePortal();
    const kv = new MemoryKV();
    const email = `badprd.${uid('e')}@example.com`;
    const { companyId } = await seedCompany('Hidden Co');
    const personId = await seedPerson(email, 'Hidden Buyer');
    await linkPerson(personId, companyId);
    const accessId = await seedAccess({ personId, companyId, email, status: 'invited' });
    const draftId = await seedProduct({ name: 'Draft', price: '5.00', status: 'draft' });
    const hiddenId = await seedProduct({ name: 'Hidden', price: '5.00', visibility: 'hidden' });
    const session = await verifySession(kv, { id: accessId, email });

    const { request } = portalApp(kv);
    const draftRes = await request('/public/commerce-portal/orders', {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ items: [{ productId: draftId, quantity: 1 }] }),
    });
    expect(draftRes.status).toBe(400);

    const hiddenRes = await request('/public/commerce-portal/orders', {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ items: [{ productId: hiddenId, quantity: 1 }] }),
    });
    expect(hiddenRes.status).toBe(400);
  });
});

describe('/public/commerce-portal · invoices and returns', () => {
  it('omits draft invoices and 404s PDF for another party', async () => {
    await enablePortal();
    const kv = new MemoryKV();
    const email = `inv.${uid('e')}@example.com`;
    const a = await seedCompany('Invoice Co');
    const b = await seedCompany('Other Invoice Co');
    const personId = await seedPerson(email, 'Invoiced');
    await linkPerson(personId, a.companyId);
    const accessId = await seedAccess({ personId, companyId: a.companyId, email, status: 'invited' });

    const entityId = uid('ent');
    await db.insert(schema.entities).values({
      id: entityId,
      name: 'Books Co',
      jurisdictionCode: 'BE',
      baseCurrency: 'EUR',
      locale: 'nl-BE',
    });

    const draftId = uid('inv');
    const sentId = uid('inv');
    const foreignId = uid('inv');
    const now = new Date();
    await db.insert(schema.invoices).values([
      {
        id: draftId,
        entityId,
        contactId: personId,
        counterpartyId: a.partyId,
        status: 'draft',
        invoiceNumber: 'DRAFT-1',
        issueDate: now,
        dueDate: now,
        total: '10.00',
        balanceDue: '10.00',
      },
      {
        id: sentId,
        entityId,
        contactId: personId,
        counterpartyId: a.partyId,
        status: 'sent',
        invoiceNumber: 'INV-1',
        issueDate: now,
        dueDate: now,
        total: '40.00',
        balanceDue: '40.00',
      },
      {
        id: foreignId,
        entityId,
        contactId: personId,
        counterpartyId: b.partyId,
        status: 'sent',
        invoiceNumber: 'INV-OTHER',
        issueDate: now,
        dueDate: now,
        total: '99.00',
        balanceDue: '99.00',
      },
    ]);

    const session = await verifySession(kv, { id: accessId, email });
    const { request } = portalApp(kv);
    const listRes = await request('/public/commerce-portal/invoices', {
      headers: authHeaders(session),
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: Array<{ id: string }> };
    const ids = list.data.map((row) => row.id);
    expect(ids).toContain(sentId);
    expect(ids).not.toContain(draftId);
    expect(ids).not.toContain(foreignId);

    const pdfRes = await request(`/public/commerce-portal/invoices/${foreignId}/pdf`, {
      headers: { Authorization: `Bearer ${session}` },
    });
    expect(pdfRes.status).toBe(404);
  });

  it('returns 404 when requesting a return against another company’s order', async () => {
    await enablePortal();
    const kv = new MemoryKV();
    const email = `ret.${uid('e')}@example.com`;
    const a = await seedCompany('Return Co');
    const b = await seedCompany('Foreign Return Co');
    const personId = await seedPerson(email, 'Returner');
    await linkPerson(personId, a.companyId);
    const accessId = await seedAccess({ personId, companyId: a.companyId, email, status: 'invited' });
    const foreignOrderId = await seedOrder(b.partyId);

    const session = await verifySession(kv, { id: accessId, email });
    const { request } = portalApp(kv);
    const res = await request('/public/commerce-portal/returns', {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({
        originalOrderId: foreignOrderId,
        items: [{ productName: 'Widget', quantity: 1 }],
      }),
    });
    expect(res.status).toBe(404);
  });
});
