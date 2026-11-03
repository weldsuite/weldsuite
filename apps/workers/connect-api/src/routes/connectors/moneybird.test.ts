/**
 * `/api/connectors` for the accounting connectors on a real (pglite) tenant
 * database: the credential test against Moneybird and Stripe, what the
 * "Send sales to Moneybird" settings pick from, and how far the push is
 * (Stripe sales imported into WeldBooks, some already sent, one failed). The
 * provider APIs are a fetch stub answering by URL, method and token.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConnectorSync } from '@weldsuite/connectors';
import { ingestRecords } from '@weldsuite/connect-domain/connectors/ingest';
import { connectorRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function moneybird(path: string, token: string | null): Response {
  if (token === 'Bearer mb-bad') return json({ error: 'Token is invalid' }, 401);
  if (path === 'administrations') return json([{ id: 123456, name: 'Acme BV', language: 'nl', currency: 'EUR' }, { id: '', name: 'nameless' }]);
  if (path === 'adm1/contacts') return json([]);
  if (path === 'adm1/ledger_accounts') {
    return json([
      { id: '501', name: 'Omzet', account_type: 'revenue', account_id: '8000' },
      { id: '502', account_type: 'expenses' },
      { name: 'no id' },
    ]);
  }
  if (path === 'adm1/financial_accounts') {
    return json([
      { id: 'fa_stripe', name: 'Stripe', type: 'PaymentServiceAccount', identifier: 'acct_1', currency: 'EUR' },
      { id: 'fa_bank', name: '', identifier: 'NL01BANK0123456789', currency: 'EUR' },
    ]);
  }
  if (path === 'adm1/tax_rates') {
    return json([
      { id: 'tr_21', name: '21% btw', percentage: '21.0', tax_rate_type: 'sales_invoice', country: null, active: true },
      { id: 'tr_9', name: '9% btw', percentage: 9, tax_rate_type: 'purchase_invoice', active: true },
      { id: 'tr_0', name: 'Geen btw', percentage: null, tax_rate_type: null, active: true },
      { id: 'tr_old', name: 'Oud', percentage: '19.0', tax_rate_type: 'sales_invoice', active: false },
    ]);
  }
  return json({ error: 'not found' }, 404);
}

function stripe(path: string, token: string | null): Response {
  if (token === 'Bearer rk_bad') return json({ error: { message: 'Invalid API Key provided: rk_bad' } }, 401);
  if (token === 'Bearer rk_restricted') {
    if (path === 'account') return json({ error: { message: 'The provided key does not have access to account' } }, 403);
    if (path === 'balance') return json({ object: 'balance', available: [], pending: [] });
  }
  if (path === 'account') {
    return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Acme' } }, business_profile: { name: 'Acme BV' } });
  }
  return json({ error: { message: 'Unrecognized request URL' } }, 404);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(url)) return realFetch(input, init);
      const token = new Headers(init?.headers).get('authorization');
      const { hostname, pathname } = new URL(url);
      if (hostname === 'moneybird.com') return moneybird(pathname.replace('/api/v2/', '').replace(/\.json$/, ''), token);
      if (hostname === 'api.stripe.com') return stripe(pathname.replace('/v1/', ''), token);
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PUSH_SETTINGS = {
  enabled: true,
  sourceConnectionIds: [],
  revenueLedgerAccountId: '501',
  financialAccountId: 'fa_stripe',
  feeLedgerAccountId: null,
  payoutLedgerAccountId: null,
  taxRateOverrides: { reverseCharge: null, outsideEu: null, exempt: null, noTax: null },
  startDate: null,
};

function stripeInvoice(id: string, number: string, created: number): Record<string, unknown> {
  return {
    id,
    number,
    status: 'paid',
    currency: 'eur',
    created,
    status_transitions: { finalized_at: created, paid_at: created + 3600 },
    customer: 'cus_1',
    customer_name: 'Acme BV',
    customer_email: 'billing@acme.example',
    subtotal_excluding_tax: 10000,
    tax: 2100,
    total: 12100,
    amount_paid: 12100,
    amount_remaining: 0,
    total_tax_amounts: [{ amount: 2100, taxable_amount: 10000, tax_rate: { id: 'txr_21', percentage: 21, country: 'NL' } }],
    lines: { data: [{ id: `il_${id}`, description: 'Pro plan', quantity: 1, amount: 10000, amount_excluding_tax: 10000, tax_amounts: [], discount_amounts: [] }] },
    updated_at: new Date(created * 1000).toISOString(),
    _weld_skip: false,
  };
}

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date('2026-03-01T10:00:00.000Z');
  await db.insert(schema.connectorConnections).values([
    { id: 'ccn_mbpush0000001', provider: 'moneybird', displayName: 'Moneybird', status: 'active', credentials: { accessToken: 'mb-token', administrationId: 'adm1' }, externalAccountId: 'adm1', settings: { moneybirdPush: PUSH_SETTINGS }, createdAt: at, updatedAt: at },
    { id: 'ccn_mbbad00000001', provider: 'moneybird', displayName: 'Moneybird (revoked)', status: 'active', credentials: { accessToken: 'mb-bad', administrationId: 'adm1' }, externalAccountId: 'adm-revoked', createdAt: at, updatedAt: at },
    { id: 'ccn_mbnoadm000001', provider: 'moneybird', displayName: 'Moneybird (no administration)', status: 'pending', credentials: { accessToken: 'mb-token' }, createdAt: at, updatedAt: at },
    { id: 'ccn_stripe0000001', provider: 'stripe', displayName: 'Stripe (Acme)', status: 'active', credentials: { stripeUserId: 'acct_1' }, externalAccountId: 'acct_1', createdAt: new Date('2026-03-02T10:00:00.000Z'), updatedAt: at },
    { id: 'ccn_stripe0000002', provider: 'stripe', displayName: null, status: 'active', credentials: { apiKey: 'rk_live_x' }, externalAccountId: 'acct_2', createdAt: new Date('2026-03-03T10:00:00.000Z'), updatedAt: at },
    { id: 'ccn_woo_000000009', provider: 'woocommerce', displayName: 'Shop', status: 'active', createdAt: at, updatedAt: at },
  ] as (typeof schema.connectorConnections.$inferInsert)[]);

  // Three Stripe sales and a payout imported into WeldBooks.
  await ingestRecords({
    db,
    connectionId: 'ccn_stripe0000001',
    provider: 'stripe',
    sync: getConnectorSync('stripe', 'stripe-invoices')!.sync,
    records: [stripeInvoice('in_1', 'ACME-0001', 1767225600), stripeInvoice('in_2', 'ACME-0002', 1767312000), stripeInvoice('in_3', 'ACME-0003', 1767398400)],
    ownerId: 'user_test_default',
    workspaceId: 'org_test',
    entityId: 'ent_books0000001',
    env: {},
  });
  const base = { object: 'stripe_line', payout_id: 'po_1', balance_account: 'balance_EUR', currency: 'EUR', updated_at: '2026-01-05T00:00:00.000Z' };
  await ingestRecords({
    db,
    connectionId: 'ccn_stripe0000001',
    provider: 'stripe',
    sync: getConnectorSync('stripe', 'stripe-balance-transactions')!.sync,
    records: [
      { ...base, id: 'txn_ch', line: 'gross', type: 'charge', amount: 12100, created: '2026-01-01T01:00:00.000Z', invoice_id: 'in_1', charge_id: 'ch_1', source_id: 'ch_1', balance_transaction_id: 'txn_ch' },
      { ...base, id: 'txn_po', line: 'payout', type: 'payout', amount: -12100, created: '2026-01-05T00:00:00.000Z', balance_transaction_id: 'txn_po', source_id: 'po_1' },
    ],
    ownerId: 'user_test_default',
    workspaceId: 'org_test',
    entityId: 'ent_books0000001',
    env: {},
  });

  // One invoice already sent, one that failed, and the last pass.
  const invoices = await db.select({ id: schema.invoices.id, number: schema.invoices.invoiceNumber }).from(schema.invoices);
  const idOf = (number: string) => invoices.find((row) => row.number === number)!.id;
  await db.insert(schema.integrationEntityMappings).values([
    { id: 'iem_mbsent000001', connectionId: 'ccn_mbpush0000001', externalEntityType: 'moneybird_external_sales_invoice', externalEntityId: 'mb_inv_1', internalEntityType: 'invoice', internalEntityId: idOf('ACME-0001'), syncChecksum: 'paid', updatedAt: at },
    { id: 'iem_mbfail000001', connectionId: 'ccn_mbpush0000001', externalEntityType: 'moneybird_external_sales_invoice', externalEntityId: `failed:${idOf('ACME-0002')}`, internalEntityType: 'invoice', internalEntityId: idOf('ACME-0002'), updatedAt: new Date() },
  ] as (typeof schema.integrationEntityMappings.$inferInsert)[]);
  await db.insert(schema.connectorSyncRuns).values({
    id: 'csr_mbpush000001',
    connectionId: 'ccn_mbpush0000001',
    syncName: 'moneybird-push',
    model: 'MoneybirdPush',
    status: 'partial',
    trigger: 'schedule',
    error: '1 record(s) failed',
    errorSamples: [{ externalId: 'in_2', message: 'Moneybird request failed (422)' }],
    startedAt: at,
    finishedAt: new Date('2026-03-01T10:00:05.000Z'),
    createdAt: at,
  } as typeof schema.connectorSyncRuns.$inferInsert);
}, 60_000);

function app(...granted: string[]) {
  return createTestApp<Env, Variables>('/api/connectors', connectorRoutes, {
    context: { tenantDb: db, permissions: permissions(...(granted.length ? granted : ['integrations:read', 'integrations:create'])) },
  }).request;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /test for the accounting connectors', () => {
  it('tests Moneybird with and without an administration', async () => {
    const withAdmin = await app()('/api/connectors/test', post({ provider: 'moneybird', credentials: { accessToken: 'mb-token', administrationId: 'adm1' } }));
    expect(((await withAdmin.json()) as { data: unknown }).data).toEqual({ ok: true, storeUrl: 'https://moneybird.com/adm1' });
    const withoutAdmin = await app()('/api/connectors/test', post({ provider: 'moneybird', credentials: { accessToken: 'mb-token' } }));
    expect(((await withoutAdmin.json()) as { data: unknown }).data).toEqual({ ok: true, storeUrl: 'https://moneybird.com' });
    const rejected = await app()('/api/connectors/test', post({ provider: 'moneybird', credentials: { accessToken: 'mb-bad' } }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { message: 'Moneybird rejected the access token' } });
  });

  it('tests Stripe keys, falling back to the balance for a restricted key', async () => {
    const key = await app()('/api/connectors/test', post({ provider: 'stripe', credentials: { apiKey: 'rk_live_good' } }));
    expect(((await key.json()) as { data: unknown }).data).toEqual({ ok: true, storeUrl: 'acct_1' });
    const restricted = await app()('/api/connectors/test', post({ provider: 'stripe', credentials: { apiKey: 'rk_restricted' } }));
    expect(((await restricted.json()) as { data: unknown }).data).toEqual({ ok: true, storeUrl: 'key_cted' });
    const bad = await app()('/api/connectors/test', post({ provider: 'stripe', credentials: { apiKey: 'rk_bad' } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { message: 'Stripe: Invalid API Key provided: rk_bad' } });
    const none = await app()('/api/connectors/test', post({ provider: 'stripe', credentials: { stripeUserId: 'acct_9' } }));
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: { message: 'Stripe is not connected (no API key)' } });
  });
});

describe('GET /connections/:id/moneybird/options', () => {
  it('lists the administration\'s ledgers, accounts, sales tax rates and the Stripe connections', async () => {
    const res = await app('integrations:read')('/api/connectors/connections/ccn_mbpush0000001/moneybird/options');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown[]> };
    expect(data.ledgerAccounts).toEqual([
      { id: '501', name: 'Omzet', accountType: 'revenue', accountId: '8000' },
      { id: '502', name: '502', accountType: 'expenses', accountId: null },
    ]);
    expect(data.financialAccounts).toEqual([
      { id: 'fa_stripe', name: 'Stripe', type: 'PaymentServiceAccount', identifier: 'acct_1', currency: 'EUR' },
      { id: 'fa_bank', name: 'NL01BANK0123456789', type: null, identifier: 'NL01BANK0123456789', currency: 'EUR' },
    ]);
    expect(data.taxRates).toEqual([
      { id: 'tr_21', name: '21% btw', percentage: 21, taxRateType: 'sales_invoice', country: null },
      { id: 'tr_0', name: 'Geen btw', percentage: null, taxRateType: null, country: null },
    ]);
    expect(data.stripeConnections).toEqual([
      { id: 'ccn_stripe0000002', displayName: null, externalAccountId: 'acct_2' },
      { id: 'ccn_stripe0000001', displayName: 'Stripe (Acme)', externalAccountId: 'acct_1' },
    ]);
  });

  it('answers 400 when Moneybird refuses the token or no administration is picked', async () => {
    const revoked = await app()('/api/connectors/connections/ccn_mbbad00000001/moneybird/options');
    expect(revoked.status).toBe(400);
    expect(await revoked.json()).toMatchObject({ error: { message: 'Moneybird rejected the connection — reconnect it' } });
    const noAdmin = await app()('/api/connectors/connections/ccn_mbnoadm000001/moneybird/options');
    expect(noAdmin.status).toBe(400);
    expect(await noAdmin.json()).toMatchObject({ error: { message: 'Moneybird administration is not selected' } });
  });

  it('404s another provider\'s or an unknown connection, and needs integrations:read', async () => {
    expect((await app()('/api/connectors/connections/ccn_woo_000000009/moneybird/options')).status).toBe(404);
    expect((await app()('/api/connectors/connections/ccn_missing0000000/moneybird/options')).status).toBe(404);
    expect((await app('integrations:create')('/api/connectors/connections/ccn_mbpush0000001/moneybird/options')).status).toBe(403);
  });
});

describe('GET /connections/:id/moneybird/push-status', () => {
  it('counts what was sent, what failed and what is still to send', async () => {
    const res = await app('integrations:read')('/api/connectors/connections/ccn_mbpush0000001/moneybird/push-status');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      enabled: true,
      pushedInvoices: 1,
      pendingInvoices: 1,
      failedInvoices: 1,
      pushedPayouts: 0,
      pendingPayouts: 1,
      lastRun: {
        status: 'partial',
        startedAt: '2026-03-01T10:00:00.000Z',
        finishedAt: '2026-03-01T10:00:05.000Z',
        error: '1 record(s) failed',
        errorSamples: [{ externalId: 'in_2', message: 'Moneybird request failed (422)' }],
      },
    });
  });

  it('reads a connection without push settings as off', async () => {
    const res = await app()('/api/connectors/connections/ccn_mbbad00000001/moneybird/push-status');
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      enabled: false,
      pushedInvoices: 0,
      pendingInvoices: 0,
      failedInvoices: 0,
      pushedPayouts: 0,
      pendingPayouts: 0,
      lastRun: null,
    });
  });

  it('404s another provider\'s connection and needs integrations:read', async () => {
    expect((await app()('/api/connectors/connections/ccn_stripe0000001/moneybird/push-status')).status).toBe(404);
    expect((await app('integrations:update')('/api/connectors/connections/ccn_mbpush0000001/moneybird/push-status')).status).toBe(403);
  });
});
