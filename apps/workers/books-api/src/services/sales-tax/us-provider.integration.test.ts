/**
 * US sales tax through provider engines (pglite, recorded HTTP): Stripe Tax
 * and Avalara answer calculations, commit finalized invoices and reverse
 * credit memos; an engine that can't answer never lets zero tax post.
 * docs/plans/weldbooks-us.md §3, phases 3.1 and 3.2.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { invoicesRoutes } from '../../routes/invoices';
import { billsRoutes } from '../../routes/bills';
import { recurringInvoicesRoutes } from '../../routes/recurring-invoices';
import { salesTaxRoutes } from '../../routes/sales-tax';
import { salesTaxTestHooks } from './runtime';
import { seedUsBooks, TEST_ENV, type UsBooks } from './test-fixtures';

let db: Database;
let books: UsBooks;

const austin = { line1: '500 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' };
// Stripe only dates a calculation within two days of now; documents are dated today.
const TODAY = new Date().toISOString().slice(0, 10);
const LATER = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

const invoices = (path = '', opts: Parameters<UsBooks['api']>[3] = {}) => books.api('/api/invoices', invoicesRoutes, path, opts);
const settings = (path: string, opts: Parameters<UsBooks['api']>[3] = {}) => books.api('/api/sales-tax', salesTaxRoutes, path, opts);

interface Call {
  path: string;
  method: string;
  form: Record<string, string>;
  json?: Record<string, unknown>;
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// A fake Stripe: invented Texas rates in the real response shape.
// ---------------------------------------------------------------------------

const STRIPE_RATES: Array<[string, string, string]> = [
  ['state', 'Texas', '6.25'],
  ['city', 'Austin', '1'],
  ['district', 'Capital Metro', '1'],
];

function stripe() {
  const calls: Call[] = [];
  const control = { down: false, commitStatus: 200, calcs: 0 };
  const references = new Map<string, string[]>();
  const transactionLines = new Map<string, string[]>();
  let transactions = 0;

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const form = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
    calls.push({ path: url.pathname, method, form });
    if (control.down) return respond({ error: { message: 'Stripe is unavailable' } }, 503);

    if (url.pathname === '/v1/tax/calculations') {
      control.calcs += 1;
      const items: unknown[] = [];
      for (let i = 0; form[`line_items[${i}][reference]`] !== undefined; i += 1) {
        const amount = Number(form[`line_items[${i}][amount]`]);
        const breakdown = STRIPE_RATES.map(([level, name, pct]) => ({
          amount: Math.round((amount * Number(pct)) / 100),
          jurisdiction: { country: 'US', display_name: name, level, state: 'TX' },
          sourcing: 'origin',
          tax_rate_details: { display_name: 'Sales Tax', percentage_decimal: pct, tax_type: 'sales_tax' },
          taxability_reason: 'standard_rated',
          taxable_amount: amount,
        }));
        items.push({
          id: `tax_li_${control.calcs}_${i}`,
          amount,
          amount_tax: breakdown.reduce((s, b) => s + b.amount, 0),
          quantity: 1,
          reference: form[`line_items[${i}][reference]`],
          tax_behavior: form[`line_items[${i}][tax_behavior]`] ?? 'exclusive',
          tax_breakdown: breakdown,
        });
      }
      references.set(`taxcalc_${control.calcs}`, items.map((item) => (item as { reference: string }).reference));
      return respond({ id: `taxcalc_${control.calcs}`, line_items: { data: items } });
    }
    if (url.pathname === '/v1/tax/transactions/create_from_calculation') {
      if (control.commitStatus !== 200) return respond({ error: { message: 'Calculation expired' } }, control.commitStatus);
      transactions += 1;
      transactionLines.set(`tax_txn_${transactions}`, references.get(form.calculation) ?? []);
      return respond({ id: `tax_txn_${transactions}`, calculation: form.calculation });
    }
    if (url.pathname.endsWith('/line_items') && url.pathname.includes('/v1/tax/transactions/')) {
      const calc = transactionLines.get(url.pathname.split('/')[4]) ?? [];
      return respond({ data: calc.map((reference, i) => ({ id: `tax_txli_${i}`, reference, tax_behavior: 'exclusive' })), has_more: false });
    }
    if (url.pathname === '/v1/tax/transactions/create_reversal') {
      transactions += 1;
      return respond({ id: `tax_txn_${transactions}` });
    }
    if (url.pathname === '/v1/tax/registrations') {
      return respond({
        data: [
          { id: 'taxreg_tx', country: 'US', status: 'active', country_options: { us: { state: 'TX', type: 'state_sales_tax' } } },
          { id: 'taxreg_ny', country: 'US', status: 'active', country_options: { us: { state: 'NY', type: 'state_sales_tax' } } },
        ],
        has_more: false,
      });
    }
    return respond({ error: { message: `unexpected ${method} ${url.pathname}` } }, 404);
  };
  return { fetch: impl as typeof fetch, calls, control };
}

async function createInvoice(body: Record<string, unknown>) {
  const res = await invoices('', {
    method: 'POST',
    body: { contactId: 'pty_tx', issueDate: TODAY, dueDate: LATER, billingAddress: austin, items: [{ description: 'Widgets', unitPrice: '1000' }], ...body },
  });
  if (res.status !== 201) throw new Error(`create invoice: ${res.text}`);
  return res.data as { id: string; taxTotal: string; total: string; subtotal: string; taxWarnings?: string[] };
}

const finalize = (id: string) => invoices(`/${id}/finalize`, { method: 'POST' });
const invoiceRow = async (id: string) => (await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0];

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  books = await seedUsBooks(db);
}, 120_000);

afterAll(() => {
  salesTaxTestHooks.fetch = undefined;
});

describe('engine settings', () => {
  it('stores the Stripe key encrypted and never returns it', async () => {
    const refused = await settings('/settings', { method: 'PUT', body: { engine: 'stripe_tax' } });
    expect(refused.status).toBe(400);

    const saved = await settings('/settings', { method: 'PUT', body: { engine: 'stripe_tax', credentials: { apiKey: 'rk_test_super_secret_key' } } });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ engine: 'stripe_tax', hasCredentials: true });
    expect(saved.text).not.toContain('rk_test_super_secret_key');

    const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, books.entityId));
    expect(entity.salesTaxCredentialsEncrypted).toBeTruthy();
    expect(entity.salesTaxCredentialsEncrypted).not.toContain('rk_test');
    expect(entity.salesTaxEngine).toBe('stripe_tax');

    const read = await settings('/settings');
    expect(read.data).toMatchObject({ engine: 'stripe_tax', hasCredentials: true });
    expect(read.data.agencies.map((a: { stateCode: string }) => a.stateCode).sort()).toEqual(['FL', 'TX', 'WA']);
    expect(read.text).not.toContain('rk_test');
  });

  it('checks the provider registrations against the agencies, both ways', async () => {
    const server = stripe();
    salesTaxTestHooks.fetch = server.fetch;
    const res = await settings('/registration-check', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.data.matched.map((m: { stateCode: string }) => m.stateCode)).toEqual(['TX']);
    expect(res.data.missingInProvider.map((m: { stateCode: string }) => m.stateCode).sort()).toEqual(['FL', 'WA']);
    expect(res.data.missingInWeldBooks.map((m: { stateCode: string }) => m.stateCode)).toEqual(['NY']);
    expect(res.data.inSync).toBe(false);
  });
});

describe('Stripe Tax', () => {
  const server = stripe();
  let invoiceId: string;

  beforeAll(() => {
    salesTaxTestHooks.fetch = server.fetch;
  });

  afterEach(() => {
    server.control.down = false;
    server.control.commitStatus = 200;
  });

  it('calculates a draft through the engine and shows the same tax in the live preview', async () => {
    const created = await createInvoice({});
    invoiceId = created.id;
    expect(created).toMatchObject({ taxTotal: '82.50', total: '1082.50' });
    const row = await invoiceRow(invoiceId);
    expect(row).toMatchObject({ taxEngine: 'stripe_tax', taxEngineRef: expect.stringMatching(/^taxcalc_/) });
    expect(row.taxCommittedAt).toBeNull();

    const preview = await settings('/calculate', {
      method: 'POST',
      body: { kind: 'invoice', contactId: 'pty_tx', issueDate: TODAY, billingAddress: austin, items: [{ unitPrice: '1000' }] },
    });
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ engine: 'stripe_tax', subtotal: '1000.00', taxTotal: '82.50', total: '1082.50', warnings: [] });
    expect(preview.data.jurisdictions.map((j: { jurisdictionName: string }) => j.jurisdictionName).sort()).toEqual(['Austin', 'Capital Metro', 'Texas']);
  });

  it('an engine that is down keeps the draft, flags it, and refuses finalize without posting', async () => {
    server.control.down = true;
    // A new draft is saved without tax.
    const untaxed = await createInvoice({});
    expect(untaxed).toMatchObject({ taxTotal: '0.00', total: '1000.00' });
    expect(untaxed.taxWarnings?.[0]).toMatch(/^tax_engine_unavailable/);
    expect(await invoiceRow(untaxed.id)).toMatchObject({ taxEngine: null, taxCalculatedAt: null });

    // An edit that doesn't touch the lines keeps the last calculation.
    const moved = await invoices(`/${invoiceId}`, { method: 'PATCH', body: { shippingAddress: austin } });
    expect(moved.status).toBe(200);
    expect(moved.data.taxTotal).toBe('82.50');
    expect(moved.data.taxWarnings.some((w: string) => w.startsWith('tax_engine_unavailable'))).toBe(true);

    const refused = await finalize(invoiceId);
    expect(refused.status).toBe(503);
    expect(refused.error?.code).toBe('TAX_ENGINE_UNAVAILABLE');
    const row = await invoiceRow(invoiceId);
    expect(row).toMatchObject({ status: 'draft', journalEntryId: null, taxTotal: '82.50' });
    const entries = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.sourceId, invoiceId));
    expect(entries).toHaveLength(0);

    const preview = await settings('/calculate', {
      method: 'POST',
      body: { kind: 'invoice', billingAddress: austin, items: [{ unitPrice: '100' }] },
    });
    expect(preview.status).toBe(503);
    expect(preview.error?.code).toBe('TAX_ENGINE_UNAVAILABLE');
    server.control.down = false;
  });

  it('finalizing posts the engine tax to the agency payable and records the invoice with Stripe', async () => {
    const res = await finalize(invoiceId);
    expect(res.status).toBe(200);
    const row = await invoiceRow(invoiceId);
    expect(row.taxTotal).toBe('82.50');
    expect(row.taxCommittedAt).not.toBeNull();
    expect(row.taxEngineRef).toMatch(/^tax_txn_/);
    expect(row.taxWarnings ?? []).toEqual([]);

    const commit = server.calls.find((c) => c.path === '/v1/tax/transactions/create_from_calculation');
    expect(commit?.form).toMatchObject({ reference: row.invoiceNumber });

    const rows = await db.select().from(schema.taxLines).where(eq(schema.taxLines.sourceId, invoiceId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.engine === 'stripe_tax' && r.engineRef?.startsWith('taxcalc_'))).toBe(true);
    expect(res.data.taxSync).toMatchObject({ status: 'committed' });
  });

  it('a commit that fails after posting leaves the ledger alone and is retried by commit-tax', async () => {
    const created = await createInvoice({});
    server.control.commitStatus = 400;
    const res = await finalize(created.id);
    expect(res.status).toBe(200);
    expect(res.data.taxSync.status).toBe('failed');
    let row = await invoiceRow(created.id);
    expect(row.status).toBe('sent');
    expect(row.journalEntryId).toMatch(/^je_/);
    expect(row.taxCommittedAt).toBeNull();
    expect(row.taxWarnings?.[0]).toMatch(/^commit_failed/);

    server.control.commitStatus = 200;
    const retried = await invoices(`/${created.id}/commit-tax`, { method: 'POST' });
    expect(retried.status).toBe(200);
    expect(retried.data).toMatchObject({ status: 'committed' });
    row = await invoiceRow(created.id);
    expect(row.taxCommittedAt).not.toBeNull();
    expect(row.taxWarnings ?? []).toEqual([]);
    expect((await invoices(`/${created.id}/commit-tax`, { method: 'POST' })).data.status).toBe('already_synced');
  });

  it('a credit memo reverses the committed transaction line by line, and needs no calculation', async () => {
    const before = server.control.calcs;
    const memo = (await invoices(`/${invoiceId}/credit-note`, { method: 'POST' })).data.id as string;
    const res = await finalize(memo);
    expect(res.status).toBe(200);
    expect(server.control.calcs).toBe(before);

    const reversal = server.calls.find((c) => c.path === '/v1/tax/transactions/create_reversal');
    expect(reversal?.form).toMatchObject({
      mode: 'partial',
      original_transaction: expect.stringMatching(/^tax_txn_/),
      'line_items[0][amount]': '-100000',
      'line_items[0][amount_tax]': '-8250',
    });
    const row = await invoiceRow(memo);
    expect(row.taxCommittedAt).not.toBeNull();
    expect(res.data.taxSync.status).toBe('reversed');
  });

  it('a credit memo is posted even when the engine is down; the reversal is flagged for a retry', async () => {
    const original = await createInvoice({});
    await finalize(original.id);
    const memo = (await invoices(`/${original.id}/credit-note`, { method: 'POST' })).data.id as string;
    server.control.down = true;
    const res = await finalize(memo);
    server.control.down = false;
    expect(res.status).toBe(200);
    expect(res.data.taxSync.status).toBe('failed');
    expect((await invoiceRow(memo)).taxWarnings?.[0]).toMatch(/^reverse_failed/);
  });

  it('use tax on a bill falls back to the manual rates, because Stripe cannot calculate it', async () => {
    const callsBefore = server.calls.length;
    const bill = await books.api('/api/bills', billsRoutes, '', {
      method: 'POST',
      body: {
        contactId: 'pty_vendor',
        issueDate: '2026-07-12',
        dueDate: '2026-08-12',
        deliveryAddress: austin,
        items: [{ description: 'Equipment', unitPrice: '1000', accrueUseTax: true }],
      },
    });
    expect(bill.status).toBe(201);
    expect(bill.data.taxBreakdown.filter((r: { kind?: string }) => r.kind === 'use').reduce((s: number, r: { taxAmount: number }) => s + r.taxAmount, 0)).toBe(82.5);
    expect(server.calls.length).toBe(callsBefore);
  });

  it('a recurring invoice generated while the engine is down stays a draft with the reason', async () => {
    await db.insert(schema.recurringInvoices).values({
      id: 'ri_down',
      entityId: books.entityId,
      contactId: 'pty_tx',
      frequency: 'monthly',
      nextIssueDate: new Date('2026-09-01'),
      status: 'active',
      autoFinalize: true,
      templateData: { items: [{ description: 'Retainer', quantity: 1, unitPrice: 200 }] },
    });
    server.control.down = true;
    const generated = await books.api('/api/recurring-invoices', recurringInvoicesRoutes, '/ri_down/generate', { method: 'POST' });
    server.control.down = false;
    expect(generated.status).toBe(201);
    expect(generated.data.journalEntryId).toBeNull();
    expect(generated.data.finalizeError).toMatch(/sales tax engine could not calculate/);
    const row = await invoiceRow(generated.data.invoiceId);
    expect(row).toMatchObject({ status: 'draft', journalEntryId: null, taxTotal: '0.00' });
  });
});

// ---------------------------------------------------------------------------
// A fake Avalara
// ---------------------------------------------------------------------------

function avalara() {
  const calls: Call[] = [];
  const control = { refundStatus: 200, committed: new Map<string, Array<{ lineNumber: string; amount: number }>>() };

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const json = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ path: url.pathname, method, form: {}, json });

    if (url.pathname === '/api/v2/transactions/create' && json) {
      const lines = (json.lines as Array<{ number: string; amount: number }>).map((l) => ({
        lineNumber: l.number,
        lineAmount: l.amount,
        taxIncluded: false,
        tax: Math.round(l.amount * 8.25) / 100,
        details: [
          { jurisType: 'STA', jurisCode: '48', jurisName: 'TEXAS', region: 'TX', rate: 0.0625, tax: Math.round(l.amount * 6.25) / 100, taxableAmount: l.amount, exemptAmount: 0, nonTaxableAmount: 0 },
          { jurisType: 'CIT', jurisCode: '4805000', jurisName: 'AUSTIN', region: 'TX', rate: 0.01, tax: Math.round(l.amount) / 100, taxableAmount: l.amount, exemptAmount: 0, nonTaxableAmount: 0 },
          { jurisType: 'STJ', jurisCode: '4805001', jurisName: 'CAPITAL METRO', region: 'TX', rate: 0.01, tax: Math.round(l.amount) / 100, taxableAmount: l.amount, exemptAmount: 0, nonTaxableAmount: 0 },
        ],
      }));
      const code = json.commit ? String(json.code) : 'avatax-temp-1';
      if (json.commit) control.committed.set(code, lines.map((l) => ({ lineNumber: l.lineNumber, amount: l.lineAmount })));
      return respond({ id: 1, code, date: json.date, status: json.commit ? 'Committed' : 'Temporary', lines });
    }
    const refund = /\/companies\/[^/]+\/transactions\/([^/]+)\/refund$/.exec(url.pathname);
    if (refund) {
      if (control.refundStatus !== 200) return respond({ error: { message: 'Refund rejected' } }, control.refundStatus);
      return respond({ code: json?.refundTransactionCode });
    }
    const original = /\/companies\/[^/]+\/transactions\/([^/]+)$/.exec(url.pathname);
    if (original && method === 'GET') {
      const lines = control.committed.get(decodeURIComponent(original[1])) ?? [];
      return respond({ code: original[1], date: '2026-07-10', lines: lines.map((l) => ({ lineNumber: l.lineNumber, lineAmount: l.amount, taxIncluded: false, tax: 0 })) });
    }
    return respond({ error: { message: `unexpected ${method} ${url.pathname}` } }, 404);
  };
  return { fetch: impl as typeof fetch, calls, control };
}

describe('Avalara AvaTax', () => {
  const server = avalara();

  beforeAll(() => {
    salesTaxTestHooks.fetch = server.fetch;
  });

  it('needs the account, license key and company code', async () => {
    const missing = await settings('/settings', { method: 'PUT', body: { engine: 'avalara', credentials: { accountId: '1100000000', licenseKey: 'lic-secret' } } });
    expect(missing.status).toBe(400);
    const saved = await settings('/settings', {
      method: 'PUT',
      body: { engine: 'avalara', config: { companyCode: 'ACME', environment: 'sandbox' }, credentials: { accountId: '1100000000', licenseKey: 'lic-secret' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ engine: 'avalara', hasCredentials: true, config: { companyCode: 'ACME', environment: 'sandbox' } });
    expect(saved.text).not.toContain('lic-secret');
  });

  let invoiceId: string;

  it('calculates, commits at finalize under the invoice number, and accrues use tax itself', async () => {
    const created = await createInvoice({});
    invoiceId = created.id;
    expect(created.taxTotal).toBe('82.50');
    const res = await finalize(invoiceId);
    expect(res.status).toBe(200);
    const row = await invoiceRow(invoiceId);
    expect(row.taxCommittedAt).not.toBeNull();
    expect(row.taxEngineRef).toBe(row.invoiceNumber);
    const commit = server.calls.filter((c) => c.path === '/api/v2/transactions/create').at(-1);
    expect(commit?.json).toMatchObject({ type: 'SalesInvoice', commit: true, code: row.invoiceNumber, companyCode: 'ACME' });

    const bill = await books.api('/api/bills', billsRoutes, '', {
      method: 'POST',
      body: {
        contactId: 'pty_vendor',
        issueDate: '2026-07-12',
        dueDate: '2026-08-12',
        deliveryAddress: austin,
        items: [{ description: 'Equipment', unitPrice: '1000', accrueUseTax: true }],
      },
    });
    expect(bill.status).toBe(201);
    const useRows = bill.data.taxBreakdown.filter((r: { kind?: string }) => r.kind === 'use');
    expect(useRows.reduce((s: number, r: { taxAmount: number }) => s + r.taxAmount, 0)).toBe(82.5);
    expect(server.calls.filter((c) => c.path === '/api/v2/transactions/create').at(-1)?.json).toMatchObject({ type: 'PurchaseOrder' });
  });

  it('a full credit memo is a full refund of the committed invoice', async () => {
    const memo = (await invoices(`/${invoiceId}/credit-note`, { method: 'POST' })).data.id as string;
    const res = await finalize(memo);
    expect(res.status).toBe(200);
    expect(res.data.taxSync.status).toBe('reversed');
    const refund = server.calls.find((c) => c.path.endsWith('/refund'));
    expect(refund?.json).toMatchObject({ refundType: 'Full', referenceCode: (await invoiceRow(invoiceId)).invoiceNumber });
  });

  it('a partial line credit Avalara cannot express posts anyway and says so', async () => {
    const original = await createInvoice({ items: [{ description: 'Widgets', quantity: '2', unitPrice: '500' }, { description: 'Gadgets', quantity: '1', unitPrice: '300' }] });
    await finalize(original.id);
    const memo = (await invoices(`/${original.id}/credit-note`, { method: 'POST' })).data.id as string;
    // Credit half of one line and none of the other: not a whole line, not one percentage.
    const edited = await invoices(`/${memo}`, { method: 'PATCH', body: { items: [{ description: 'Widgets', quantity: '1', unitPrice: '500' }, { description: 'Gadgets', quantity: '1', unitPrice: '300' }] } });
    expect(edited.status).toBe(200);
    const res = await finalize(memo);
    expect(res.status).toBe(200);
    expect(res.data.taxSync.status).toBe('failed');
    expect((await invoiceRow(memo)).taxWarnings?.[0]).toMatch(/^reverse_unsupported/);
    const rows = await db.select().from(schema.taxLines).where(and(eq(schema.taxLines.sourceId, memo), eq(schema.taxLines.sourceType, 'credit_note')));
    expect(rows.length).toBeGreaterThan(0);
  });
});

void TEST_ENV;
