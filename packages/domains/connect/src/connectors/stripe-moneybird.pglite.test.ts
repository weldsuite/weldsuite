/**
 * pglite: Stripe import into WeldBooks, then the Moneybird push against a
 * mocked Moneybird API. Covers the invoice, its contact, the payout statement,
 * booking its lines, and that a second pass sends nothing twice.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getConnectorSync } from '@weldsuite/connectors';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ingestRecords } from './ingest';
import { getConnectionById } from './connections';
import { MB_INVOICE_TYPE, MB_PUSHED_MUTATION_TYPE, MB_STATEMENT_TYPE, moneybirdPushStatus, pushToMoneybird } from './moneybird-push';

let db: Database;

const invoicesSync = getConnectorSync('stripe', 'stripe-invoices')!.sync;
const linesSync = getConnectorSync('stripe', 'stripe-balance-transactions')!.sync;

const PUSH_SETTINGS = {
  enabled: true,
  sourceConnectionIds: [],
  revenueLedgerAccountId: 'led_rev',
  financialAccountId: 'fa_stripe',
  feeLedgerAccountId: 'led_fee',
  payoutLedgerAccountId: 'led_transfer',
  taxRateOverrides: { reverseCharge: null, outsideEu: null, exempt: null, noTax: null },
  startDate: null,
};

function stripeInvoice(): Record<string, unknown> {
  return {
    id: 'in_1',
    number: 'ACME-0001',
    status: 'paid',
    currency: 'eur',
    created: 1767225600,
    status_transitions: { finalized_at: 1767225600, paid_at: 1767229200 },
    customer: 'cus_1',
    customer_name: 'Acme BV',
    customer_email: 'billing@acme.example',
    customer_address: { line1: 'Kade 1', city: 'Utrecht', postal_code: '3511AA', country: 'NL' },
    customer_tax_ids: [{ type: 'eu_vat', value: 'NL123456789B01' }],
    subtotal_excluding_tax: 10000,
    tax: 2100,
    total: 12100,
    amount_paid: 12100,
    amount_remaining: 0,
    total_tax_amounts: [
      { amount: 2100, taxable_amount: 10000, taxability_reason: 'standard_rated', tax_rate: { id: 'txr_21', percentage: 21, country: 'NL' } },
    ],
    lines: {
      data: [{ id: 'il_1', description: 'Pro plan', quantity: 1, amount: 10000, amount_excluding_tax: 10000, tax_amounts: [{ amount: 2100, taxable_amount: 10000, tax_rate: 'txr_21' }], discount_amounts: [] }],
    },
    updated_at: '2026-01-01T00:00:00.000Z',
    _weld_skip: false,
  };
}

function payoutLines(): Array<Record<string, unknown>> {
  const base = { object: 'stripe_line', payout_id: 'po_1', balance_account: 'balance_EUR', currency: 'EUR', updated_at: '2026-01-02T00:00:00.000Z' };
  return [
    { ...base, id: 'txn_ch', line: 'gross', type: 'charge', amount: 12100, created: '2026-01-01T01:00:00.000Z', invoice_id: 'in_1', charge_id: 'ch_1', source_id: 'ch_1', balance_transaction_id: 'txn_ch', customer_name: 'Acme BV' },
    { ...base, id: 'txn_ch_fee', line: 'fee', type: 'stripe_fee', amount: -195, created: '2026-01-01T01:00:00.000Z', balance_transaction_id: 'txn_ch' },
    { ...base, id: 'txn_po', line: 'payout', type: 'payout', amount: -11905, created: '2026-01-03T00:00:00.000Z', balance_transaction_id: 'txn_po', source_id: 'po_1' },
  ];
}

/** Moneybird ids stay unique across tests (the mapping table is unique per remote id). */
let invoiceSeq = 0;

interface MoneybirdCall {
  method: string;
  path: string;
  body: unknown;
}

/** Just enough of the Moneybird API for one push pass. */
function mockMoneybird(): MoneybirdCall[] {
  const calls: MoneybirdCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v2/adm1/', '').replace(/\.json$/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
    calls.push({ method, path, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

    if (path === 'tax_rates') return json([{ id: 'mb_r21', name: '21% btw', percentage: '21.0', tax_rate_type: 'sales_invoice', active: true }]);
    if (path === 'contacts' && method === 'GET') return json([]);
    if (path === 'contacts' && method === 'POST') return json({ id: 'mb_contact_1' });
    if (path === 'external_sales_invoices' && method === 'POST') {
      invoiceSeq += 1;
      return json({ id: `mb_inv_${invoiceSeq}`, total_price_incl_tax: '121.0' });
    }
    if (path === 'financial_accounts') return json([{ id: 'fa_stripe', name: 'Stripe', currency: 'EUR' }]);
    if (path === 'financial_statements') {
      const mutations = Object.values(
        (body as { financial_statement: { financial_mutations_attributes: Record<string, { message: string; amount: string }> } })
          .financial_statement.financial_mutations_attributes,
      );
      return json({ id: 'mb_stmt_1', financial_mutations: mutations.map((mutation, index) => ({ id: `mb_mut_${index + 1}`, ...mutation })) });
    }
    if (path.endsWith('/payments')) return json({ id: 'mb_pay_1' });
    if (path.endsWith('/link_booking')) return json({});
    return json({ error: `unexpected ${method} ${path}` }, 404);
  });
  return calls;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.connectorConnections).values([
    { id: 'conn_stripe', provider: 'stripe', displayName: 'Stripe', status: 'active', externalAccountId: 'acct_1' },
    {
      id: 'conn_mb',
      provider: 'moneybird',
      displayName: 'Moneybird',
      status: 'active',
      externalAccountId: 'adm1',
      credentials: { accessToken: 'mb_token', administrationId: 'adm1' },
      settings: { moneybirdPush: PUSH_SETTINGS },
    },
  ]);
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Stripe → WeldBooks → Moneybird', () => {
  it('imports the Stripe invoice and payout lines into WeldBooks', async () => {
    const invoices = await ingestRecords({
      db,
      connectionId: 'conn_stripe',
      provider: 'stripe',
      sync: invoicesSync,
      records: [stripeInvoice()],
      ownerId: 'user_1',
      workspaceId: 'org_1',
      entityId: 'ent_1',
      env: {},
    });
    expect(invoices).toMatchObject({ created: 1, failed: 0 });

    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.invoiceNumber, 'ACME-0001'));
    expect(invoice).toMatchObject({ status: 'paid', total: '121.00', taxTotal: '21.00', currency: 'EUR', journalEntryId: null });
    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, invoice!.contactId));
    expect(party).toMatchObject({ kind: 'company', displayName: 'Acme BV' });

    const lines = await ingestRecords({
      db,
      connectionId: 'conn_stripe',
      provider: 'stripe',
      sync: linesSync,
      records: payoutLines(),
      ownerId: 'user_1',
      workspaceId: 'org_1',
      entityId: 'ent_1',
      env: {},
    });
    expect(lines).toMatchObject({ created: 3, failed: 0 });

    const txns = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.entityId, 'ent_1'));
    const charge = txns.find((row) => row.externalId === 'txn_ch');
    expect(charge).toMatchObject({ amount: '121.00', status: 'reconciled', reconciledInvoiceId: invoice!.id });
    expect(txns.find((row) => row.externalId === 'txn_ch_fee')?.amount).toBe('-1.95');
    const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, charge!.bankAccountId));
    expect(account?.name).toBe('Stripe balance (EUR)');
  });

  it('sends the invoice, posts the payout statement and books its lines', async () => {
    const calls = mockMoneybird();
    const connection = (await getConnectionById(db, 'conn_mb'))!;
    const result = await pushToMoneybird({ db, env: {}, connection, trigger: 'manual' });
    expect(result).toMatchObject({ invoicesPushed: 1, statementsPushed: 1, linesBooked: 3, failed: 0 });

    const created = calls.find((call) => call.path === 'external_sales_invoices');
    expect(created?.body).toMatchObject({
      external_sales_invoice: {
        contact_id: 'mb_contact_1',
        reference: 'ACME-0001',
        prices_are_incl_tax: false,
        details_attributes: [{ description: 'Pro plan', amount: '1', price: '100.00', tax_rate_id: 'mb_r21', ledger_account_id: 'led_rev' }],
      },
    });
    const statement = calls.find((call) => call.path === 'financial_statements')?.body as {
      financial_statement: { financial_account_id: string; financial_mutations_attributes: Record<string, { amount: string }> };
    };
    expect(statement.financial_statement.financial_account_id).toBe('fa_stripe');
    expect(Object.values(statement.financial_statement.financial_mutations_attributes).map((row) => row.amount)).toEqual(['121.00', '-1.95', '-119.05']);

    const payment = calls.find((call) => call.path === 'external_sales_invoices/mb_inv_1/payments');
    expect(payment?.body).toMatchObject({ payment: { price: '121.00', financial_account_id: 'fa_stripe', financial_mutation_id: 'mb_mut_1' } });
    const links = calls.filter((call) => call.path.endsWith('/link_booking')).map((call) => call.body);
    expect(links).toHaveLength(2);
    expect(links).toEqual(
      expect.arrayContaining([
        { booking_type: 'LedgerAccount', booking_id: 'led_fee', price_base: '1.95', description: 'Stripe fees' },
        { booking_type: 'LedgerAccount', booking_id: 'led_transfer', price_base: '119.05', description: 'Stripe payout' },
      ]),
    );

    const [pushed] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(and(eq(schema.integrationEntityMappings.connectionId, 'conn_mb'), eq(schema.integrationEntityMappings.externalEntityType, MB_INVOICE_TYPE)));
    expect(pushed).toMatchObject({ externalEntityId: 'mb_inv_1', syncChecksum: 'paid' });
    const booked = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(and(eq(schema.integrationEntityMappings.connectionId, 'conn_mb'), eq(schema.integrationEntityMappings.externalEntityType, MB_PUSHED_MUTATION_TYPE)));
    expect(booked.map((row) => row.syncChecksum)).toEqual(['linked', 'linked', 'linked']);
  });

  it('sends nothing twice', async () => {
    const calls = mockMoneybird();
    const connection = (await getConnectionById(db, 'conn_mb'))!;
    const result = await pushToMoneybird({ db, env: {}, connection, trigger: 'manual', force: true });
    expect(result).toMatchObject({ invoicesPushed: 0, statementsPushed: 0, linesBooked: 0, remaining: false });
    expect(calls).toHaveLength(0);

    const status = await moneybirdPushStatus(db, connection);
    expect(status).toMatchObject({ enabled: true, pushedInvoices: 1, pendingInvoices: 0, failedInvoices: 0, pushedPayouts: 1, pendingPayouts: 0 });
    expect(status.lastRun?.status).toBe('success');
    const statements = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(eq(schema.integrationEntityMappings.externalEntityType, MB_STATEMENT_TYPE));
    expect(statements).toHaveLength(1);
  });

  it('marks a failed invoice and leaves it out until the cooldown or Send now', async () => {
    await ingestRecords({
      db,
      connectionId: 'conn_stripe',
      provider: 'stripe',
      sync: invoicesSync,
      records: [{ ...stripeInvoice(), id: 'in_2', number: 'ACME-0002', total_tax_amounts: [{ amount: 600, taxable_amount: 10000, taxability_reason: 'standard_rated', tax_rate: { id: 'txr_6', percentage: 6 } }], lines: { data: [{ id: 'il_2', description: 'Book', quantity: 1, amount: 10000, amount_excluding_tax: 10000, tax_amounts: [{ amount: 600, taxable_amount: 10000, tax_rate: 'txr_6' }], discount_amounts: [] }] } }],
      ownerId: 'user_1',
      workspaceId: 'org_1',
      entityId: 'ent_1',
      env: {},
    });
    mockMoneybird();
    const connection = (await getConnectionById(db, 'conn_mb'))!;
    const first = await pushToMoneybird({ db, env: {}, connection, trigger: 'manual' });
    expect(first).toMatchObject({ invoicesPushed: 0, failed: 1, remaining: false });

    const calls = mockMoneybird();
    const second = await pushToMoneybird({ db, env: {}, connection, trigger: 'webhook' });
    expect(second.failed).toBe(0);
    expect(calls).toHaveLength(0);

    const status = await moneybirdPushStatus(db, connection);
    expect(status.failedInvoices).toBe(1);
  });

  it('takes over a claim a crashed pass left behind', async () => {
    await ingestRecords({
      db,
      connectionId: 'conn_stripe',
      provider: 'stripe',
      sync: invoicesSync,
      records: [{ ...stripeInvoice(), id: 'in_3', number: 'ACME-0003' }],
      ownerId: 'user_1',
      workspaceId: 'org_1',
      entityId: 'ent_1',
      env: {},
    });
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.invoiceNumber, 'ACME-0003'));
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    await db.insert(schema.integrationEntityMappings).values({
      id: 'iem_stale',
      createdAt: anHourAgo,
      updatedAt: anHourAgo,
      connectionId: 'conn_mb',
      externalEntityType: MB_INVOICE_TYPE,
      externalEntityId: `pending:${invoice!.id}`,
      internalEntityType: 'invoice',
      internalEntityId: invoice!.id,
    });

    mockMoneybird();
    const connection = (await getConnectionById(db, 'conn_mb'))!;
    const result = await pushToMoneybird({ db, env: {}, connection, trigger: 'schedule' });
    expect(result.invoicesPushed).toBe(1);
    const [row] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(eq(schema.integrationEntityMappings.id, 'iem_stale'));
    expect(row?.externalEntityId).toMatch(/^mb_inv_/);
  });
});
