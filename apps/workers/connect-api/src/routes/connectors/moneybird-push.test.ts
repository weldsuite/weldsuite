/**
 * The WeldBooks → Moneybird push on a real (pglite) tenant database: Stripe
 * sales imported into WeldBooks go on to Moneybird on "Send now"
 * (`POST /api/connectors/connections/:id/moneybird/push`, in the background)
 * and on the cron's internal pass (`POST /api/integrations/moneybird-push`):
 * the contact found or created, the external sales invoice with its tax rate
 * and ledger, the payout's financial statement and its lines booked, nothing
 * sent twice, a failed invoice retried on "Send now". Moneybird is a fetch
 * stub answering by URL, method and body.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { getConnectorSync } from '@weldsuite/connectors';
import { ingestRecords } from '@weldsuite/connect-domain/connectors/ingest';
import { conformanceTenantDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const holder = vi.hoisted(() => ({ tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant as Database) };
});

import { connectorRoutes } from './index';
import { integrationsInternalRoutes } from '../integrations/internal';

const SECRET = 'internal-test-secret';
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function moneybird(path: string, method: string, body: string | null): Response {
  const sent = body ? (JSON.parse(body) as Record<string, any>) : {};
  if (path === 'tax_rates') {
    return json([
      { id: 'mb_r21', name: '21% btw', percentage: '21.0', tax_rate_type: 'sales_invoice', active: true },
      { id: 'mb_r0', name: 'Geen btw', percentage: '0.0', tax_rate_type: 'sales_invoice', active: true },
    ]);
  }
  if (path === 'contacts' && method === 'GET') return json([{ id: 'mb_contact_known', email: 'BILLING@acme.example' }]);
  if (path === 'contacts' && method === 'POST') return json({ id: 'mb_contact_new' });
  if (path === 'external_sales_invoices' && method === 'POST') {
    const reference = String(sent.external_sales_invoice?.reference ?? '');
    if (reference === 'ACME-0003') return json({ error: { details_attributes: ['is invalid'] } }, 422);
    return json({ id: `mb_inv_${reference}`, total_price_incl_tax: reference === 'ACME-0002' ? '60.51' : '121.0' });
  }
  if (path === 'financial_accounts') return json([{ id: 'fa_stripe', name: 'Stripe', currency: 'EUR' }]);
  if (path === 'financial_statements' && method === 'POST') {
    const lines = Object.values(sent.financial_statement.financial_mutations_attributes as Record<string, { message: string; amount: string }>);
    return json({ id: 'mb_stmt_1', financial_mutations: lines.map((line, index) => ({ id: `mb_mut_${index + 1}`, message: line.message, amount: line.amount })) });
  }
  if (path.endsWith('/payments') && method === 'POST') return json({ id: `mb_pay_${path.split('/')[1]}` });
  if (path.endsWith('/link_booking') && method === 'PATCH') return json({});
  return json({ error: `unexpected ${method} ${path}` }, 404);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(href)) return realFetch(input, init);
      const url = new URL(href);
      if (url.hostname !== 'moneybird.com') return new Response('not found', { status: 404 });
      const path = url.pathname.replace('/api/v2/adm1/', '').replace(/\.json$/, '');
      return moneybird(path, (init?.method ?? 'GET').toUpperCase(), typeof init?.body === 'string' ? init.body : null);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PUSH = {
  enabled: true,
  sourceConnectionIds: [],
  revenueLedgerAccountId: 'led_rev',
  financialAccountId: 'fa_stripe',
  feeLedgerAccountId: 'led_fee',
  payoutLedgerAccountId: 'led_transfer',
  taxRateOverrides: { reverseCharge: null, outsideEu: null, exempt: null, noTax: null },
  startDate: null,
};

function invoice(id: string, number: string, created: number, total: number, tax: number, email: string, vat = true): Record<string, unknown> {
  return {
    id,
    number,
    status: 'paid',
    currency: 'eur',
    created,
    status_transitions: { finalized_at: created, paid_at: created + 3600 },
    customer: `cus_${id}`,
    customer_name: 'Acme BV',
    customer_email: email,
    customer_address: { line1: 'Kade 1', city: 'Utrecht', postal_code: '3511AA', country: 'nl' },
    customer_tax_ids: vat ? [{ type: 'eu_vat', value: 'NL123456789B01' }] : [],
    subtotal_excluding_tax: total - tax,
    tax,
    total,
    amount_paid: total,
    amount_remaining: 0,
    total_tax_amounts: tax ? [{ amount: tax, taxable_amount: total - tax, tax_rate: { id: 'txr_21', percentage: 21, country: 'NL' } }] : [],
    lines: { data: [{ id: `il_${id}`, description: 'Pro plan', quantity: 1, amount: total - tax, amount_excluding_tax: total - tax, period: { start: created, end: created + 2678400 }, tax_amounts: tax ? [{ amount: tax, taxable_amount: total - tax, tax_rate: 'txr_21' }] : [], discount_amounts: [] }] },
    updated_at: new Date(created * 1000).toISOString(),
    _weld_skip: false,
  };
}

let db: Database;
const at = new Date('2026-01-10T10:00:00.000Z');

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.tenant = db;
  await db.insert(schema.connectorConnections).values([
    { id: 'ccn_pushstripe001', provider: 'stripe', displayName: 'Stripe', status: 'active', credentials: { apiKey: 'rk_x' }, externalAccountId: 'acct_push', createdAt: at, updatedAt: at },
    { id: 'ccn_pushmb0000001', provider: 'moneybird', displayName: 'Moneybird', status: 'active', credentials: { accessToken: 'mb_token', administrationId: 'adm1' }, externalAccountId: 'adm1', settings: { moneybirdPush: PUSH }, createdAt: at, updatedAt: at },
    { id: 'ccn_pushmboff0001', provider: 'moneybird', displayName: 'Moneybird (off)', status: 'active', credentials: { accessToken: 'mb_token', administrationId: 'adm1' }, externalAccountId: 'adm-off', settings: { moneybirdPush: { ...PUSH, enabled: false } }, createdAt: at, updatedAt: at },
  ] as (typeof schema.connectorConnections.$inferInsert)[]);
  const common = { db, connectionId: 'ccn_pushstripe001', provider: 'stripe', ownerId: 'user_test_default', workspaceId: 'org_test_default', entityId: 'ent_books0000001', env: {} };
  await ingestRecords({
    ...common,
    sync: getConnectorSync('stripe', 'stripe-invoices')!.sync,
    records: [
      invoice('in_1', 'ACME-0001', 1767225600, 12100, 2100, 'billing@acme.example'),
      invoice('in_2', 'ACME-0002', 1767312000, 6050, 1050, 'new@other.example', false),
      invoice('in_3', 'ACME-0003', 1767398400, 1000, 0, 'billing@acme.example'),
    ],
  });
  const base = { object: 'stripe_line', payout_id: 'po_1', balance_account: 'balance_EUR', currency: 'EUR', updated_at: '2026-01-05T00:00:00.000Z' };
  await ingestRecords({
    ...common,
    sync: getConnectorSync('stripe', 'stripe-balance-transactions')!.sync,
    records: [
      { ...base, id: 'txn_ch', line: 'gross', type: 'charge', amount: 12100, created: '2026-01-01T01:00:00.000Z', invoice_id: 'in_1', charge_id: 'ch_1', source_id: 'ch_1', balance_transaction_id: 'txn_ch', customer_name: 'Acme BV' },
      { ...base, id: 'txn_ch_fee', line: 'fee', type: 'stripe_fee', amount: -195, created: '2026-01-01T01:00:00.000Z', balance_transaction_id: 'txn_ch' },
      { ...base, id: 'txn_adj', line: 'gross', type: 'adjustment', amount: -100, description: 'Dispute fee', created: '2026-01-02T01:00:00.000Z', balance_transaction_id: 'txn_adj' },
      { ...base, id: 'txn_po', line: 'payout', type: 'payout', amount: -11805, created: '2026-01-05T00:00:00.000Z', balance_transaction_id: 'txn_po', source_id: 'po_1' },
    ],
  });
}, 60_000);

function app(...granted: string[]) {
  return createTestApp<Env, Variables>('/api/connectors', connectorRoutes, {
    context: { tenantDb: db, permissions: permissions(...(granted.length ? granted : ['integrations:read', 'integrations:update'])) },
  }).request;
}

const internalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
internalRoutes.route('/', integrationsInternalRoutes);

function internalApp() {
  return createTestApp<Env, Variables>('/api/integrations', internalRoutes, {
    context: { tenantDb: db, permissions: permissions() },
    env: { INTERNAL_API_SECRET: SECRET } as never,
  }).request;
}

/** The push runs after the response; waits for its run (the conformance harness already did). */
async function settled(count: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = await db
      .select({ status: schema.connectorSyncRuns.status, finishedAt: schema.connectorSyncRuns.finishedAt })
      .from(schema.connectorSyncRuns)
      .where(and(eq(schema.connectorSyncRuns.connectionId, 'ccn_pushmb0000001'), eq(schema.connectorSyncRuns.syncName, 'moneybird-push')));
    if (rows.filter((row) => row.finishedAt).length >= count) {
      const [conn] = await db.select({ lastSyncAt: schema.connectorConnections.lastSyncAt }).from(schema.connectorConnections).where(eq(schema.connectorConnections.id, 'ccn_pushmb0000001'));
      const last = Math.max(...rows.map((row) => row.finishedAt?.getTime() ?? 0));
      if (conn?.lastSyncAt && conn.lastSyncAt.getTime() >= last) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${count} push runs did not finish`);
}

async function pushRows() {
  const m = schema.integrationEntityMappings;
  return db
    .select({ type: m.externalEntityType, externalId: m.externalEntityId, internalType: m.internalEntityType, checksum: m.syncChecksum })
    .from(m)
    .where(eq(m.connectionId, 'ccn_pushmb0000001'))
    .orderBy(asc(m.externalEntityType), asc(m.externalEntityId));
}

describe('Send to Moneybird', () => {
  it('sends the invoices, posts the payout statement and books its lines', async () => {
    const res = await app('integrations:update')('/api/connectors/connections/ccn_pushmb0000001/moneybird/push', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { started: true } });
    await settled(1);
    expect((await pushRows()).map((r) => [r.type, r.externalId, r.checksum])).toEqual([
      ['moneybird_contact', 'mb_contact_known', null],
      ['moneybird_contact', 'mb_contact_new', null],
      ['moneybird_external_sales_invoice', 'failed:' + (await invoiceId('ACME-0003')), null],
      ['moneybird_external_sales_invoice', 'mb_inv_ACME-0001', 'paid'],
      ['moneybird_external_sales_invoice', 'mb_inv_ACME-0002', 'open'],
      ['moneybird_financial_statement', 'mb_stmt_1', 'posted'],
      ['moneybird_pushed_mutation', 'mb_mut_1', 'linked'],
      ['moneybird_pushed_mutation', 'mb_mut_2', 'manual'],
      ['moneybird_pushed_mutation', 'mb_mut_3', 'linked'],
      ['moneybird_pushed_mutation', 'mb_mut_4', 'linked'],
    ]);
    const [run] = await db.select().from(schema.connectorSyncRuns).where(eq(schema.connectorSyncRuns.syncName, 'moneybird-push'));
    expect(run).toMatchObject({ status: 'partial', trigger: 'manual', syncType: 'PUSH', recordsCreated: 3, recordsModified: 3, recordsFailed: 1 });
    expect(run!.error).toMatch(/^1 item\(s\) could not be sent to Moneybird: Moneybird request failed \(422\)/);
    expect(run!.errorSamples).toEqual([{ externalId: 'ACME-0003', message: expect.stringContaining('Moneybird request failed (422)') }]);

    const status = await app()('/api/connectors/connections/ccn_pushmb0000001/moneybird/push-status');
    expect(((await status.json()) as { data: unknown }).data).toMatchObject({ enabled: true, pushedInvoices: 2, failedInvoices: 1, pendingInvoices: 0, pushedPayouts: 1, pendingPayouts: 0 });
  });

  it('retries the failed invoice on Send now and sends nothing twice', async () => {
    await app()('/api/connectors/connections/ccn_pushmb0000001/moneybird/push', { method: 'POST' });
    await settled(2);
    const runs = await db.select().from(schema.connectorSyncRuns).where(eq(schema.connectorSyncRuns.syncName, 'moneybird-push')).orderBy(asc(schema.connectorSyncRuns.createdAt));
    expect(runs.at(-1)).toMatchObject({ status: 'partial', recordsCreated: 0, recordsFailed: 1 });
    expect((await pushRows()).filter((r) => r.type === 'moneybird_external_sales_invoice').length).toBe(3);
  });

  it('answers the cron\'s pass with whether work is left', async () => {
    const res = await internalApp()('/api/integrations/moneybird-push', { method: 'POST', headers: { 'X-Internal-Secret': SECRET, 'X-Workspace-Id': 'org_test_default' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { remaining: false } });
    const unauthorised = await internalApp()('/api/integrations/moneybird-push', { method: 'POST', headers: { 'X-Internal-Secret': 'nope' } });
    expect(unauthorised.status).toBe(401);
  });

  it('refuses a connection that does not send, another provider\'s, and a missing permission', async () => {
    const off = await app()('/api/connectors/connections/ccn_pushmboff0001/moneybird/push', { method: 'POST' });
    expect(off.status).toBe(400);
    expect(await off.json()).toMatchObject({ error: { message: 'Turn on sending to Moneybird first' } });
    expect((await app()('/api/connectors/connections/ccn_pushstripe001/moneybird/push', { method: 'POST' })).status).toBe(404);
    expect((await app('integrations:read')('/api/connectors/connections/ccn_pushmb0000001/moneybird/push', { method: 'POST' })).status).toBe(403);
  });
});

async function invoiceId(number: string): Promise<string> {
  const [row] = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.invoiceNumber, number));
  return row!.id;
}
