/**
 * Online W-9 requests: creating the link (only a hash is stored, a KV index
 * routes the public page to the tenant), listing, expiry and cancelling.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingContactsRoutes } from '../accounting-contacts';
import { w9RequestsRoutes } from './index';
import { events, fakeKv, seedEntityAndVendors, type ApiResult, type Fixture } from '../../services/form-1099/test-fixtures';
import { sha256Hex } from '../../services/w9-requests';

let db: Database;
let fx: Fixture;
const kv = fakeKv();
const ORG = 'org_test_default';

const api = (path: string, opts: Parameters<Fixture['call']>[3] = {}): Promise<ApiResult> =>
  fx.call('/api/w9-requests', w9RequestsRoutes, path, { ...opts, env: { WORKSPACE_CACHE: kv.kv, ...opts.env } });

async function newParty(name: string, extra: Partial<typeof schema.parties.$inferInsert> = {}) {
  const id = `pty_${name.toLowerCase().replace(/\W+/g, '')}`;
  await db.insert(schema.parties).values({ id, displayName: name, role: 'supplier', ...extra });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  fx = await seedEntityAndVendors(db);
}, 180_000);

describe('creating a request', () => {
  let partyId: string;
  let first: ApiResult;

  it('stores only the token hash, indexes it in KV and returns the link once', async () => {
    partyId = await newParty('Kilo Painting');
    first = await api('', { method: 'POST', body: { partyId, email: 'kilo@example.test' }, perms: ['suppliers:update'] });
    expect(first.status).toBe(201);
    expect(first.data.emailSent).toBe(false);

    const url = first.data.url as string;
    const match = /^https:\/\/app\.weldsuite\.org\/w9\/([A-Za-z0-9_-]{43})$/.exec(url);
    expect(match, url).toBeTruthy();
    const token = match![1]!;

    expect(first.data.request).toMatchObject({ partyId, email: 'kilo@example.test', status: 'pending', entityId: fx.entityId });
    expect(first.data.request).not.toHaveProperty('tokenHash');
    expect(first.text).not.toContain(await sha256Hex(token));

    const [row] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, first.data.request.id));
    expect(row!.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const key = `w9:${row!.tokenHash}`;
    expect(JSON.parse(kv.store.get(key)!)).toEqual({ orgId: ORG, requestId: row!.id });
    // 30 days by default.
    expect(kv.ttls.get(key)).toBeGreaterThan(29 * 86_400);
    expect(kv.ttls.get(key)).toBeLessThanOrEqual(30 * 86_400);
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
  });

  it('keeps the token out of events and the audit trail', async () => {
    const created = events.filter((e) => e.eventType === 'w9_request:created');
    expect(created.length).toBeGreaterThan(0);
    const url = first.data.url as string;
    const token = url.slice(url.lastIndexOf('/') + 1);
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain(token);
      expect(JSON.stringify(event)).not.toContain('tokenHash');
    }
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, first.data.request.id));
    expect(audit.map((a) => a.action)).toContain('created');
  });

  it('uses the platform URL of the environment, the contact email by default and the requested expiry', async () => {
    const withEmail = await fx.call('/api/accounting-contacts', accountingContactsRoutes, '', {
      method: 'POST',
      body: { fullName: 'Lima Landscaping', companyName: 'Lima Landscaping', email: 'lima@example.test', role: 'supplier' },
    });
    const res = await api('', {
      method: 'POST',
      body: { partyId: withEmail.data.id, expiresInDays: 7 },
      perms: ['taxes:create'],
      env: { PLATFORM_URL: 'https://app-test.weldsuite.org/' },
    });
    expect(res.status).toBe(201);
    expect(res.data.url).toMatch(/^https:\/\/app-test\.weldsuite\.org\/w9\/[A-Za-z0-9_-]{43}$/);
    expect(res.data.request.email).toBe('lima@example.test');
    const [row] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, res.data.request.id));
    expect(kv.ttls.get(`w9:${row!.tokenHash}`)).toBeLessThanOrEqual(7 * 86_400);
    expect(kv.ttls.get(`w9:${row!.tokenHash}`)).toBeGreaterThan(6 * 86_400);
  });

  it('needs suppliers:update or taxes:create and a real vendor, with a sane expiry', async () => {
    expect((await api('', { method: 'POST', body: { partyId }, perms: ['invoices:update'] })).status).toBe(403);
    expect((await api('', { method: 'POST', body: { partyId: 'pty_missing' }, perms: ['taxes:create'] })).status).toBe(404);
    expect((await api('', { method: 'POST', body: { partyId, expiresInDays: 0 }, perms: ['taxes:create'] })).status).toBe(400);
    expect((await api('', { method: 'POST', body: { partyId, expiresInDays: 91 }, perms: ['taxes:create'] })).status).toBe(400);
    expect((await api('', { method: 'POST', body: { partyId, email: 'not-an-email' }, perms: ['taxes:create'] })).status).toBe(400);
  });

  it('a new request replaces the earlier pending one for the same vendor', async () => {
    const second = await api('', { method: 'POST', body: { partyId }, perms: ['taxes:create'] });
    expect(second.status).toBe(201);

    const [old] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, first.data.request.id));
    expect(old!.status).toBe('cancelled');
    expect(kv.store.has(`w9:${old!.tokenHash}`)).toBe(false);
    const [current] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, second.data.request.id));
    expect(kv.store.has(`w9:${current!.tokenHash}`)).toBe(true);
  });
});

describe('listing, expiry and cancelling', () => {
  it('lists a vendor\'s requests newest first and filters by status', async () => {
    const partyId = await newParty('Mike Masonry');
    const a = await api('', { method: 'POST', body: { partyId }, perms: ['taxes:create'] });
    const b = await api('', { method: 'POST', body: { partyId }, perms: ['taxes:create'] });

    const all = await api(`?partyId=${partyId}`, { perms: ['suppliers:read'] });
    expect(all.status).toBe(200);
    expect(all.data.map((r: { id: string }) => r.id)).toEqual([b.data.request.id, a.data.request.id]);
    expect(all.text).not.toContain('tokenHash');

    const pending = await api(`?partyId=${partyId}&status=pending`, { perms: ['taxes:read'] });
    expect(pending.data.map((r: { id: string }) => r.id)).toEqual([b.data.request.id]);
    const cancelled = await api(`?partyId=${partyId}&status=cancelled`, { perms: ['taxes:read'] });
    expect(cancelled.data.map((r: { id: string }) => r.id)).toEqual([a.data.request.id]);

    expect((await api('', { perms: ['invoices:read'] })).status).toBe(403);
  });

  it('reads a pending request past its date as expired', async () => {
    const partyId = await newParty('November Nursery');
    const res = await api('', { method: 'POST', body: { partyId }, perms: ['taxes:create'] });
    await db.update(schema.w9Requests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.w9Requests.id, res.data.request.id));

    const one = await api(`/${res.data.request.id}`, { perms: ['taxes:read'] });
    expect(one.data.status).toBe('expired');
    const expired = await api(`?partyId=${partyId}&status=expired`, { perms: ['taxes:read'] });
    expect(expired.data).toHaveLength(1);
    const pending = await api(`?partyId=${partyId}&status=pending`, { perms: ['taxes:read'] });
    expect(pending.data).toHaveLength(0);
  });

  it('cancelling removes the KV index, once', async () => {
    const partyId = await newParty('Oscar Orchards');
    const res = await api('', { method: 'POST', body: { partyId }, perms: ['taxes:create'] });
    const id = res.data.request.id as string;
    const [row] = await db.select().from(schema.w9Requests).where(eq(schema.w9Requests.id, id));
    expect(kv.store.has(`w9:${row!.tokenHash}`)).toBe(true);

    expect((await api(`/${id}/cancel`, { method: 'POST', perms: ['invoices:update'] })).status).toBe(403);
    const cancelled = await api(`/${id}/cancel`, { method: 'POST', perms: ['suppliers:update'] });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.status).toBe('cancelled');
    expect(kv.store.has(`w9:${row!.tokenHash}`)).toBe(false);
    expect(events.some((e) => e.eventType === 'w9_request:updated' && e.entityId === id)).toBe(true);

    expect((await api(`/${id}/cancel`, { method: 'POST', perms: ['taxes:update'] })).status).toBe(409);
    expect((await api('/w9r_missing/cancel', { method: 'POST', perms: ['taxes:update'] })).status).toBe(404);
  });
});
