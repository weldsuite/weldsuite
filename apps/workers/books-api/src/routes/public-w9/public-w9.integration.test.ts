/**
 * The public W-9 form (pglite, a fake KV): request -> public GET/POST -> the
 * vendor is updated, the request completes and the link stops working.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createModuleApi } from '@weldsuite/worker-kit';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingContactsRoutes } from '../accounting-contacts';
import { w9RequestsRoutes } from '../w9-requests';
import { createPublicW9Routes, W9_MAX_BODY_BYTES } from './index';
import { ENCRYPTION_KEY, events, fakeKv, seedEntityAndVendors, type Fixture } from '../../services/form-1099/test-fixtures';
import type { Env, Variables } from '../../types';

let db: Database;
let fx: Fixture;
const kv = fakeKv();

const env = {
  DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  WORKSPACE_CACHE: kv.kv,
  ENTITY_EVENTS: { send: async (message: (typeof events)[number]) => void events.push(message) },
};

const publicApp = new Hono<{ Bindings: Env; Variables: Variables }>();
publicApp.route(
  '/public/w9',
  createPublicW9Routes({ openTenant: async () => ({ db, workspaceId: 'ws_test', suspended: false }) }),
);

async function publicCall(token: string, method: 'GET' | 'POST', body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await publicApp.request(
    `/public/w9/${token}`,
    { method, headers: { 'Content-Type': 'application/json', ...headers }, body: raw },
    env as unknown as Record<string, unknown>,
  );
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : {}, headers: res.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function newParty(name: string, extra: Partial<typeof schema.parties.$inferInsert> = {}) {
  const id = `pty_${name.toLowerCase().replace(/\W+/g, '')}`;
  await db.insert(schema.parties).values({ id, displayName: name, role: 'supplier', ...extra });
  return id;
}

async function requestFor(partyId: string): Promise<{ token: string; requestId: string }> {
  const { request } = createTestApp('/api/w9-requests', w9RequestsRoutes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: env as any,
    context: { permissions: permissions('*'), tenantDb: db },
  });
  const res = await request('/api/w9-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': fx.entityId },
    body: JSON.stringify({ partyId }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { url: string; request: { id: string } } };
  return { token: body.data.url.slice(body.data.url.lastIndexOf('/') + 1), requestId: body.data.request.id };
}

const goodForm = {
  legalName: 'Pat Papa',
  businessName: 'Papa Plumbing',
  federalTaxClassification: 'individual',
  address: { line1: '5 Pipe St', line2: 'Suite 2', city: 'Dallas', state: 'tx', postalCode: '75201' },
  tinType: 'ssn',
  tin: '456-78-9012',
  signedName: 'Pat Papa',
  certify: true,
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  fx = await seedEntityAndVendors(db);
}, 180_000);

describe('opening the form', () => {
  it('shows only the payer, the vendor and the expiry', async () => {
    const partyId = await newParty('Papa Plumbing');
    const { token } = await requestFor(partyId);
    const res = await publicCall(token, 'GET');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      data: { payer: { name: 'Acme Studio, LLC' }, vendor: { displayName: 'Papa Plumbing' }, expiresAt: expect.any(String) },
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(new Date(res.json.data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it('answers the same bare 404 for an unknown, cancelled, expired or completed link', async () => {
    const unknown = await publicCall('x'.repeat(43), 'GET');
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });

    const cancelledParty = await newParty('Quebec Quarry');
    const cancelled = await requestFor(cancelledParty);
    await db.update(schema.w9Requests).set({ status: 'cancelled' }).where(eq(schema.w9Requests.id, cancelled.requestId));

    const expiredParty = await newParty('Romeo Roofing');
    const expired = await requestFor(expiredParty);
    await db.update(schema.w9Requests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.w9Requests.id, expired.requestId));

    const completedParty = await newParty('Sierra Signs');
    const completed = await requestFor(completedParty);
    await db.update(schema.w9Requests).set({ status: 'completed' }).where(eq(schema.w9Requests.id, completed.requestId));

    for (const token of [cancelled.token, expired.token, completed.token]) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await publicCall(token, method, method === 'POST' ? goodForm : undefined);
        expect(res.status, `${method} ${token}`).toBe(404);
        expect(res.text).toBe(unknown.text);
      }
    }
    // A hash that is in KV but belongs to another request is not accepted either.
    const wrong = await requestFor(await newParty('Tango Tiling'));
    const [row] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, wrong.requestId));
    kv.store.set(`w9:${row!.tokenHash}`, JSON.stringify({ orgId: 'org_test_default', requestId: cancelled.requestId }));
    expect((await publicCall(wrong.token, 'GET')).status).toBe(404);
  });

  it('keeps the CORS list of the platform: no wildcard, no other origin', async () => {
    const app = createModuleApi<Env, Variables>({ service: 'books-api' });
    app.route('/public/w9', createPublicW9Routes({ openTenant: async () => ({ db, workspaceId: 'ws_test', suspended: false }) }));
    const token = 'y'.repeat(43);
    const evil = await app.request(`/public/w9/${token}`, { headers: { Origin: 'https://evil.example' } }, env as unknown as Record<string, unknown>);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const platform = await app.request(`/public/w9/${token}`, { headers: { Origin: 'https://app.weldsuite.org' } }, env as unknown as Record<string, unknown>);
    expect(platform.headers.get('access-control-allow-origin')).toBe('https://app.weldsuite.org');
  });
});

describe('submitting the form', () => {
  it('refuses oversized, malformed and uncertified submissions without touching the vendor', async () => {
    const partyId = await newParty('Uniform Upholstery');
    const { token, requestId } = await requestFor(partyId);

    const big = await publicCall(token, 'POST', { ...goodForm, businessName: 'x'.repeat(W9_MAX_BODY_BYTES) });
    expect(big.status).toBe(413);
    const declared = await publicCall(token, 'POST', goodForm, { 'Content-Length': String(W9_MAX_BODY_BYTES + 1) });
    expect(declared.status).toBe(413);

    expect((await publicCall(token, 'POST', '{not json')).status).toBe(400);
    expect((await publicCall(token, 'POST', { ...goodForm, certify: false })).status).toBe(400);
    expect((await publicCall(token, 'POST', { ...goodForm, signedName: undefined })).status).toBe(400);
    expect((await publicCall(token, 'POST', { ...goodForm, extra: 'field' })).status).toBe(400);
    expect((await publicCall(token, 'POST', { ...goodForm, address: { ...goodForm.address, state: 'ZZ' } })).status).toBe(400);
    expect((await publicCall(token, 'POST', { ...goodForm, address: { ...goodForm.address, postalCode: '123' } })).status).toBe(400);
    expect((await publicCall(token, 'POST', { ...goodForm, federalTaxClassification: 'llc' })).status).toBe(400);

    const badTin = await publicCall(token, 'POST', { ...goodForm, tin: '000-12-3456' });
    expect(badTin.status).toBe(400);
    expect(badTin.text).not.toContain('000-12-3456');
    expect(badTin.text).not.toContain('000123456');

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, partyId));
    expect(party).toMatchObject({ tinLast4: null, sensitiveEncrypted: null, w9: null });
    const [request] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, requestId));
    expect(request!.status).toBe('pending');
  });

  it('updates the vendor, completes the request and kills the link', async () => {
    const partyId = await newParty('Victor Ventilation');
    const { token, requestId } = await requestFor(partyId);
    const [pending] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, requestId));
    const eventsBefore = events.length;

    const res = await publicCall(token, 'POST', goodForm);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: { completed: true } });
    expect(res.text).not.toContain('456');

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, partyId));
    expect(party).toMatchObject({
      tinType: 'ssn',
      tinLast4: '9012',
      is1099Vendor: true,
      billingAddress: { line1: '5 Pipe St', line2: 'Suite 2', city: 'Dallas', state: 'TX', postalCode: '75201', country: 'US' },
      w9: {
        legalName: 'Pat Papa',
        businessName: 'Papa Plumbing',
        federalTaxClassification: 'individual',
        signedName: 'Pat Papa',
        source: 'online',
        receivedAt: new Date().toISOString().slice(0, 10),
      },
    });
    expect(party!.sensitiveEncrypted).toBeTruthy();
    expect(party!.sensitiveEncrypted).not.toContain('456789012');
    expect(party!.tinMatchStatus).toBeNull();

    // The TIN is what the vendor typed.
    const revealed = await fx.call('/api/accounting-contacts', accountingContactsRoutes, `/${partyId}/reveal-tin`, { method: 'POST', body: {} });
    expect(revealed.data).toEqual({ tin: '456-78-9012', tinType: 'ssn' });

    const [request] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, requestId));
    expect(request).toMatchObject({ status: 'completed' });
    expect(request!.completedAt).toBeTruthy();
    expect(kv.store.has(`w9:${pending!.tokenHash}`)).toBe(false);

    // Used once.
    expect((await publicCall(token, 'GET')).status).toBe(404);
    expect((await publicCall(token, 'POST', goodForm)).status).toBe(404);

    // Events carry no personal data.
    const fresh = events.slice(eventsBefore);
    const completed = fresh.find((e) => e.eventType === 'w9_request:completed');
    expect(completed).toBeTruthy();
    expect(completed!.entityId).toBe(requestId);
    for (const event of fresh) {
      const text = JSON.stringify(event);
      for (const needle of ['456789012', '456-78-9012', 'Pat Papa', 'Papa Plumbing', '5 Pipe St']) expect(text).not.toContain(needle);
    }
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, requestId));
    expect(audit.map((a) => a.action)).toContain('completed');
    expect(JSON.stringify(audit)).not.toContain('456789012');
  });

  it('keeps an address the vendor already has and does not overwrite what is on file', async () => {
    const partyId = await newParty('Whiskey Welding', { billingAddress: { line1: '1 Old Rd', city: 'Austin', state: 'TX', postalCode: '78701' } });
    const { token } = await requestFor(partyId);
    const res = await publicCall(token, 'POST', goodForm);
    expect(res.status).toBe(200);
    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, partyId));
    expect(party!.billingAddress).toMatchObject({ line1: '1 Old Rd' });
  });

  it('does not flag a corporation as a 1099 vendor, but keeps a vendor that was already flagged', async () => {
    const corporation = {
      ...goodForm,
      legalName: 'Xray Industries Inc.',
      businessName: undefined,
      federalTaxClassification: 'c_corporation',
      tinType: 'ein',
      tin: '34-5678901',
    };
    const plain = await newParty('Xray Industries');
    const a = await requestFor(plain);
    expect((await publicCall(a.token, 'POST', corporation)).status).toBe(200);
    const [unflagged] = await db.select().from(schema.parties).where(eq(schema.parties.id, plain));
    expect(unflagged).toMatchObject({ is1099Vendor: false, tinType: 'ein', tinLast4: '8901' });

    const flaggedId = await newParty('Yankee Yardwork', { is1099Vendor: true });
    const b = await requestFor(flaggedId);
    expect((await publicCall(b.token, 'POST', { ...corporation, federalTaxClassification: 'llc', llcTaxClassification: 'S' })).status).toBe(200);
    const [flagged] = await db.select().from(schema.parties).where(eq(schema.parties.id, flaggedId));
    expect(flagged!.is1099Vendor).toBe(true);
    expect(flagged!.w9).toMatchObject({ federalTaxClassification: 'llc', llcTaxClassification: 'S' });

    const llcPartner = await newParty('Zulu Zoning');
    const c = await requestFor(llcPartner);
    expect((await publicCall(c.token, 'POST', { ...corporation, federalTaxClassification: 'llc', llcTaxClassification: 'P' })).status).toBe(200);
    const [partnership] = await db.select().from(schema.parties).where(eq(schema.parties.id, llcPartner));
    expect(partnership!.is1099Vendor).toBe(true);
  });

  it('replaces the TIN of a vendor that had one and clears the old IRS match', async () => {
    const partyId = await newParty('Alfa Awnings');
    await db
      .update(schema.parties)
      .set({ tinType: 'ein', tinLast4: '1111', tinMatchStatus: 'match', tinMatchedAt: new Date() })
      .where(eq(schema.parties.id, partyId));
    const { token } = await requestFor(partyId);
    expect((await publicCall(token, 'POST', goodForm)).status).toBe(200);
    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, partyId));
    expect(party).toMatchObject({ tinType: 'ssn', tinLast4: '9012', tinMatchStatus: null, tinMatchedAt: null });
  });
});
