/**
 * /api/accounting-settings (pglite tenant and master databases): the settings
 * row made on first read, the update that creates or merges it, the ECB
 * exchange rates (fallback, parsed feed, cache), the accounting inbox in the
 * master `mail_account_registry`, the finance workflow templates, and the
 * refusals: validation, an unknown currency, missing permissions.
 *
 * Nothing is mocked but `getMasterDb` (through `conformanceMasterDb`, so the
 * conformance suite runs these against the Rust backend too) and the ECB
 * feed on `fetch`.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

import { accountingSettingsRoutes } from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let db: Database;

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope><Cube><Cube time='2026-03-02'>
<Cube currency='USD' rate='1.0500'/><Cube currency='GBP' rate='0.8400'/><Cube currency='JPY' rate='160.10'/>
</Cube></Cube></gesmes:Envelope>`;

const realFetch = globalThis.fetch;

/** The ECB feed answers `status` (with the XML on a 200); every other call goes to the real `fetch`. */
function ecb(status: number) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== ECB_URL) return realFetch(input, init);
    return status === 200 ? new Response(ECB_XML, { status: 200 }) : new Response('down', { status });
  });
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; perms?: string[]; headers?: Record<string, string> } = {},
) {
  const { request } = createTestApp('/api/accounting-settings', accountingSettingsRoutes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db, masterDb: master },
  });
  const res = await request(`/api/accounting-settings${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  db = (await createPgliteDb()).db;
  await master.insert(masterSchema.workspaces).values({ id: 'ws_test_default', clerkOrgId: 'org_test_default', name: 'Books', slug: 'books-settings' });
  await db.insert(schema.entities).values({ id: 'ent_set', name: 'Settings BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings row', () => {
  it('creates the row on first read, then reads it', async () => {
    const first = await call('');
    expect(first.status).toBe(201);
    expect(Object.keys(first.data).sort()).toEqual(['createdAt', 'id', 'updatedAt']);
    const again = await call('');
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ id: first.data.id, accountingMethod: 'accrual', defaultPaymentTermsDays: 30, fiscalYearStart: 1, emailSettings: null });
  });

  it('creates a new row on update when there is none', async () => {
    await db.update(schema.settings).set({ deletedAt: new Date('2026-02-01T00:00:00Z') });
    const put = await call('', { method: 'PUT', body: { accountingMethod: 'cash', defaultEntityId: null, unknown: 'dropped' } });
    expect(put.status).toBe(201);
    expect(put.data).toMatchObject({ accountingMethod: 'cash', defaultEntityId: null });
    expect(put.data.unknown).toBeUndefined();
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, put.data.id));
    expect(audit).toHaveLength(1);
  });

  it('merges an update into the row and audits the change', async () => {
    const patched = await call('', {
      method: 'PATCH',
      body: { defaultEntityId: 'ent_set', fiscalYearStart: 4, defaultPaymentTermsDays: 14, emailSettings: { autoCreateDraftBills: true, extra: 'x' } },
    });
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ accountingMethod: 'cash', defaultEntityId: 'ent_set', fiscalYearStart: 4, emailSettings: { autoCreateDraftBills: true } });
    expect(patched.data.emailSettings.extra).toBeUndefined();
    const put = await call('', { method: 'PUT', body: {} });
    expect(put.status).toBe(200);
    expect((await call('')).data).toMatchObject({ defaultPaymentTermsDays: 14, accountingMethod: 'cash' });
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityType, 'accounting_settings'));
    expect(audit.some((row) => row.accountingEntityId === 'ent_set')).toBe(true);
  });

  it('refuses bad bodies and missing permissions', async () => {
    expect((await call('', { method: 'PATCH', body: { fiscalYearStart: 13 } })).status).toBe(400);
    expect((await call('', { method: 'PATCH', body: { fiscalYearStart: 1.5, accountingMethod: 'hybrid' } })).status).toBe(400);
    expect((await call('', { method: 'PATCH', body: { defaultPaymentTermsDays: -1 } })).status).toBe(400);
    expect((await call('', { method: 'PUT', body: { defaultEntityId: 'x'.repeat(31) } })).status).toBe(400);
    expect((await call('', { method: 'PATCH', body: { emailSettings: { autoScanEnabled: 'yes', inboxAddress: 5 } } })).status).toBe(400);
    expect((await call('', { method: 'PATCH', body: { emailSettings: 'on' } })).status).toBe(400);
    expect((await call('', { perms: ['invoices:read'] })).status).toBe(403);
    expect((await call('', { method: 'PATCH', perms: ['accounts:read'], body: {} })).status).toBe(403);
  });
});

describe('exchange rates', () => {
  it('answers the fallback table while the feed is down', async () => {
    vi.stubGlobal('fetch', ecb(503));
    const res = await call('/exchange-rates');
    expect(res.status).toBe(200);
    expect(res.data.rates).toMatchObject({ EUR: 1, USD: 1.08, GBP: 0.86 });
    expect(res.data.baseCurrency).toBe('EUR');
    expect(res.data.currencies.length).toBeGreaterThan(10);
    const rate = await call('/exchange-rate/usd/gbp');
    expect(rate.data).toMatchObject({ from: 'USD', to: 'GBP', rate: 0.86 / 1.08 });
  });

  it('parses the feed, then keeps it for the hour', async () => {
    vi.stubGlobal('fetch', ecb(200));
    const res = await call('/exchange-rates', { headers: { 'Accept-Language': 'nl-NL,nl;q=0.9' } });
    expect(res.data.rates).toEqual({ USD: 1.05, GBP: 0.84, JPY: 160.1, EUR: 1 });
    expect(res.data.currencies.find((c: { code: string }) => c.code === 'INR').name).toBe('Indiase Roepie');
    vi.stubGlobal('fetch', ecb(503));
    const rate = await call('/exchange-rate/gbp/usd');
    expect(rate.data).toMatchObject({ from: 'GBP', to: 'USD', rate: 1.05 / 0.84 });
    expect((await call('/exchange-rate/eur/eur')).data.rate).toBe(1);
    expect((await call('/exchange-rate/JPY/EUR')).data.rate).toBe(1 / 160.1);
  });

  it('fails on a currency the feed does not have', async () => {
    const res = await call('/exchange-rate/eur/xxx');
    expect(res.status).toBe(500);
    expect(res.error?.message).toBe('Failed to fetch exchange rate');
    expect((await call('/exchange-rates', { perms: ['invoices:read'] })).status).toBe(403);
  });
});

describe('inbox', () => {
  it('registers the address in the master registry and the settings', async () => {
    const res = await call('/inbox', { method: 'POST', body: { email: 'Books@Example.com' } });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ email: 'books@example.com', accountId: 'acct_inbox_ws_test_default' });
    const [row] = await master
      .select()
      .from(masterSchema.mailAccountRegistry)
      .where(eq(masterSchema.mailAccountRegistry.email, 'books@example.com'));
    expect(row).toMatchObject({ workspaceId: 'ws_test_default', isActive: true });
    expect((await call('')).data.emailSettings).toEqual({ autoCreateDraftBills: true, inboxAddress: 'books@example.com', autoScanEnabled: true });
  });

  it('takes over an address that was deactivated', async () => {
    await master.update(masterSchema.mailAccountRegistry).set({ isActive: false, accountId: 'acct_old' });
    const res = await call('/inbox', { method: 'POST', body: { email: 'books@example.com' } });
    expect(res.status).toBe(200);
    const [row] = await master.select().from(masterSchema.mailAccountRegistry);
    expect(row).toMatchObject({ isActive: true, accountId: 'acct_inbox_ws_test_default' });
  });

  it('refuses a bad address and missing permissions', async () => {
    expect((await call('/inbox', { method: 'POST', body: { email: 'not-an-email' } })).status).toBe(400);
    expect((await call('/inbox', { method: 'POST', body: {} })).status).toBe(400);
    expect((await call('/inbox', { method: 'POST', perms: ['accounts:read'], body: { email: 'a@b.co' } })).status).toBe(403);
  });
});

describe('POST /seed-workflows', () => {
  it('seeds the finance templates once', async () => {
    expect((await call('/seed-workflows', { method: 'POST', perms: ['accounts:update'] })).status).toBe(403);
    const res = await call('/seed-workflows', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ templatesCreated: 7 });
    const rows = await db.select().from(schema.workflowTemplates).where(eq(schema.workflowTemplates.category, 'finance'));
    expect(rows.map((r) => r.name)).toContain('Betalingsherinnering');
    expect(rows.find((r) => r.name === 'BTW deadline herinnering')?.triggers?.[0]?.type).toBe('schedule');
    const again = await call('/seed-workflows', { method: 'POST' });
    expect(again.status).toBe(409);
    expect(again.error?.message).toBe('Accounting workflow templates already seeded.');
  });
});
