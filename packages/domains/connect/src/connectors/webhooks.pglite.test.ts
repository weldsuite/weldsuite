/**
 * pglite: Moneybird webhook deliveries through `processConnectorWebhook`,
 * against a mocked Moneybird API. A contact event imports its entity; a
 * payment, an untyped document and a statement are routed to what they
 * change (`moneybird-webhooks.ts`), one sync run per sync they feed.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { hmacSha256Hex } from '@weldsuite/connectors';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { getConnectionById } from './connections';
import { processConnectorWebhook, type ConnectorWebhooksEnv } from './webhooks';

let db: Database;
const SECRET = 'mb-hook-secret';
const ENV = { ENVIRONMENT: 'test' } as unknown as ConnectorWebhooksEnv;

const SALES_INVOICE = {
  id: 'si1',
  invoice_id: '2026-W01',
  contact_id: 'c1',
  state: 'reminded',
  invoice_date: '2026-05-01',
  due_date: '2026-05-15',
  currency: 'EUR',
  total_price_excl_tax: '100.0',
  total_price_incl_tax: '121.0',
  total_paid: '21.0',
  total_unpaid: '100.0',
  details: [{ description: 'Support', amount: '1', price: '100.0', tax_rate_id: 'tr21', total_price_excl_tax_with_discount: '100.0' }],
  tax_totals: [{ tax_rate_id: 'tr21', taxable_amount: '100.0', tax_amount: '21.0' }],
  updated_at: '2026-05-03T10:00:00.000Z',
};

const RECEIPT = {
  id: 'r1',
  reference: 'R-9',
  contact_id: 'c1',
  state: 'open',
  date: '2026-05-02',
  currency: 'EUR',
  total_price_excl_tax: '10.0',
  total_price_incl_tax: '12.1',
  details: [{ description: 'Parking', amount: '1', price: '10.0' }],
  payments: [],
  updated_at: '2026-05-02T10:00:00.000Z',
};

const MUTATION = { id: 'm1', financial_account_id: 'fa1', amount: '21.0', date: '2026-05-03', message: 'Payment 2026-W01', state: 'processed', updated_at: '2026-05-03T10:00:00.000Z' };

/** Just enough of the Moneybird API. */
function mockMoneybird(): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v2\/\d+\//, '').replace(/\.json$/, '');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === 'sales_invoices/si1') return json(SALES_INVOICE);
    if (path === 'sales_invoices/locked') return json({ error: 'Token expired' }, 401);
    if (path === 'documents/receipts/r1') return json(RECEIPT);
    if (path === 'financial_mutations/synchronization' && method === 'POST') {
      const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
      return json([MUTATION].filter((m) => ids.includes(m.id)));
    }
    return json({ error: 'record not found' }, 404);
  });
  return calls;
}

async function deliver(connectionId: string, body: Record<string, unknown>, signature?: string) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const connection = (await getConnectionById(db, connectionId))!;
  return processConnectorWebhook({
    db,
    env: ENV,
    connection,
    ownerId: 'user_1',
    workspaceId: 'ws_1',
    rawBody: raw,
    headers: new Headers({ 'Moneybird-Signature': signature ?? `t=${t},v1=${await hmacSha256Hex(SECRET, `${t}.${raw}`)}` }),
  });
}

async function runs(connectionId: string) {
  return (await db.select().from(schema.connectorSyncRuns).where(eq(schema.connectorSyncRuns.connectionId, connectionId)))
    .map((r) => [r.syncName, r.status, r.recordsCreated])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // One connection per administration.
  const base = (admin: string) => ({
    provider: 'moneybird',
    status: 'active',
    externalAccountId: admin,
    webhookSecret: SECRET,
    credentials: { accessToken: 'mb_token', administrationId: admin, entityId: 'ent_wh' },
  });
  await db.insert(schema.connectorConnections).values([
    { ...base('311'), id: 'conn_mb_hook', displayName: 'Moneybird', enabledSyncs: ['contacts', 'invoices', 'bills', 'bankTransactions'] },
    { ...base('312'), id: 'conn_mb_contacts', displayName: 'Contacts only', enabledSyncs: ['contacts'] },
    { ...base('313'), id: 'conn_mb_outbound', displayName: 'Sends contacts', enabledSyncs: ['contacts'], objectSyncDirections: { contacts: 'outbound' } },
  ] as (typeof schema.connectorConnections.$inferInsert)[]);
}, 60_000);

beforeEach(() => {
  mockMoneybird();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Moneybird webhook deliveries', () => {
  it('imports a contact from its event, and routes payments, documents and statements', async () => {
    expect(
      await deliver('conn_mb_hook', { action: 'contact_changed', entity: { id: 'c1', company_name: 'Hook BV', updated_at: '2026-05-01T08:00:00.000Z' } }),
    ).toEqual({ ok: true, status: 200, message: 'ingested' });

    const payment = await deliver('conn_mb_hook', {
      action: 'payment_registered',
      entity_type: 'Payment',
      entity: { id: 'pay1', invoice_type: 'SalesInvoice', invoice_id: 'si1', financial_mutation_id: 'm1' },
    });
    expect(payment).toEqual({ ok: true, status: 200, message: 'ingested' });
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.invoiceNumber, '2026-W01'));
    expect(invoice).toMatchObject({ status: 'partial', taxTotal: '21.00', amountPaid: '21.00', balanceDue: '100.00' });
    const [line] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.externalId, 'm1'));
    expect(line).toMatchObject({ amount: '21.00', status: 'reconciled' });

    expect(await deliver('conn_mb_hook', { action: 'document_saved', entity_type: 'Document', entity: { id: 'r1' } })).toEqual({
      ok: true,
      status: 200,
      message: 'ingested',
    });
    const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'R-9'));
    expect(bill).toMatchObject({ status: 'approved', total: '12.10' });

    const statement = await deliver('conn_mb_hook', {
      action: 'financial_statement_created',
      entity: { id: 'fs1', financial_account_id: 'fa1', financial_mutations: [{ id: 'm2', amount: '-3.5', date: '2026-05-04', message: 'Fee', state: 'unprocessed' }] },
    });
    expect(statement).toEqual({ ok: true, status: 200, message: 'ingested' });
    const [fee] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.externalId, 'm2'));
    expect(fee).toMatchObject({ amount: '-3.50', bankAccountId: line!.bankAccountId });

    expect(await runs('conn_mb_hook')).toEqual([
      ['moneybird-contacts', 'success', 1],
      ['moneybird-financial-mutations', 'success', 1],
      ['moneybird-financial-mutations', 'success', 1],
      ['moneybird-receipts', 'success', 1],
      ['moneybird-sales-invoices', 'success', 1],
    ]);
  });

  it('answers what it does not import', async () => {
    expect(
      await deliver('conn_mb_hook', { action: 'payment_registered', entity: { invoice_type: 'ExternalSalesInvoice', invoice_id: 'x1' } }),
    ).toEqual({ ok: true, status: 200, message: 'nothing to import for payment_registered' });
    // Bills aren't imported on this connection: Moneybird isn't even asked.
    const calls = mockMoneybird();
    expect(await deliver('conn_mb_contacts', { action: 'document_saved', entity: { id: 'r1' } })).toEqual({
      ok: true,
      status: 200,
      message: 'nothing to import for document_saved',
    });
    expect(calls).toEqual([]);
    expect(await deliver('conn_mb_contacts', { action: 'sales_invoice_updated', entity: { id: 'si1' } })).toEqual({
      ok: true,
      status: 200,
      message: 'sync disabled',
    });
    expect(await deliver('conn_mb_outbound', { action: 'contact_changed', entity: { id: 'c2' } })).toEqual({
      ok: true,
      status: 200,
      message: 'inbound sync disabled for object',
    });
    expect(await deliver('conn_mb_hook', { action: 'estimate_created', entity: { id: 'e1' } })).toEqual({
      ok: true,
      status: 200,
      message: 'ignored topic estimate_created',
    });
    expect(await deliver('conn_mb_hook', { entity: { id: 'e1' } })).toEqual({ ok: false, status: 400, message: 'missing webhook topic' });
  });

  it('refuses a forged delivery and reports a Moneybird failure', async () => {
    expect(await deliver('conn_mb_hook', { action: 'contact_changed', entity: { id: 'c1' } }, 't=1,v1=00')).toEqual({
      ok: false,
      status: 401,
      message: 'invalid webhook signature',
    });
    expect(
      await deliver('conn_mb_hook', { action: 'payment_registered', entity: { invoice_type: 'SalesInvoice', invoice_id: 'locked' } }),
    ).toEqual({ ok: false, status: 500, message: 'Moneybird rejected the access token' });
  });
});
