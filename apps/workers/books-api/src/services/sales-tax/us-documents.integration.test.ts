/**
 * US sales tax on documents with the manual engine (pglite): invoices, credit
 * memos, write-offs, bills and use tax, recurring invoices, dimensions. Fixture
 * rates are invented (see test-fixtures.ts). docs/plans/weldbooks-us.md §3-7.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { invoicesRoutes } from '../../routes/invoices';
import { billsRoutes } from '../../routes/bills';
import { recurringInvoicesRoutes } from '../../routes/recurring-invoices';
import { exemptionCertificatesRoutes } from '../../routes/exemption-certificates';
import { journalEntriesRoutes } from '../../routes/journal-entries';
import { salesTaxAgenciesRoutes } from '../../routes/sales-tax-agencies';
import { salesTaxJurisdictionsRoutes } from '../../routes/sales-tax-jurisdictions';
import { categorizeBankTransaction } from '../accounting-bank-categorize';
import { recordPayment } from '../accounting-payments';
import { PostingError } from '../accounting-posting';
import { seedUsBooks, type UsBooks } from './test-fixtures';

let db: Database;
let books: UsBooks;

const austin = { line1: '500 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' };
const dallas = { line1: '2 Elm St', city: 'Dallas', state: 'TX', postalCode: '75201', country: 'US' };
const sanFrancisco = { line1: '1 Market St', city: 'San Francisco', state: 'CA', postalCode: '94105', country: 'US' };
const seattle = { line1: '1 Pike St', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US' };
const bellevue = { line1: '10 Main St', city: 'Bellevue', state: 'WA', postalCode: '98004', country: 'US' };
const miami = { line1: '9 Palm Rd', city: 'Miami', state: 'FL', postalCode: '33101', country: 'US' };

const invoices = (path = '', opts: Parameters<UsBooks['api']>[3] = {}) => books.api('/api/invoices', invoicesRoutes, path, opts);
const bills = (path = '', opts: Parameters<UsBooks['api']>[3] = {}) => books.api('/api/bills', billsRoutes, path, opts);

async function createInvoice(body: Record<string, unknown>) {
  const res = await invoices('', {
    method: 'POST',
    body: { issueDate: '2026-07-10', dueDate: '2026-08-10', billingAddress: austin, ...body },
  });
  if (res.status !== 201) throw new Error(`create invoice: ${res.text}`);
  return res.data as { id: string; taxTotal: string; total: string; subtotal: string; taxWarnings?: string[]; items: Array<{ id: string }> };
}

async function finalize(id: string) {
  return invoices(`/${id}/finalize`, { method: 'POST' });
}

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({
      code: schema.accounts.code,
      name: schema.accounts.name,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
      classId: schema.journalLines.classId,
      locationId: schema.journalLines.locationId,
    })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows
    .map((r) => ({ code: r.code, name: r.name, debit: Number(r.debit), credit: Number(r.credit), classId: r.classId, locationId: r.locationId }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.debit - b.debit);
}

const taxRowsOf = (sourceId: string) =>
  db.select().from(schema.taxLines).where(eq(schema.taxLines.sourceId, sourceId)).orderBy(asc(schema.taxLines.jurisdictionName), asc(schema.taxLines.sourceLineId));

const sum = (rows: Array<{ taxAmount: string }>) => Math.round(rows.reduce((s, r) => s + Number(r.taxAmount), 0) * 100) / 100;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  books = await seedUsBooks(db);
}, 120_000);

describe('agencies and their accounts', () => {
  it('registering an agency created its child payable accounts and seeded shipping rules', async () => {
    const [agency] = await db.select().from(schema.salesTaxAgencies).where(eq(schema.salesTaxAgencies.id, books.agencies.tx));
    expect(agency).toMatchObject({ stateCode: 'TX', status: 'registered', filingFrequency: 'quarterly' });
    const [liability] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, agency.liabilityAccountId!));
    expect(liability.name).toBe('Sales Tax Payable – Texas Comptroller of Public Accounts');
    expect(liability.parentAccountId).toBe(books.roleAccount.get('sales_tax_payable'));
    const [use] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, agency.useTaxAccountId!));
    expect(use.parentAccountId).toBe(books.roleAccount.get('use_tax_payable'));
    const rules = await db.select().from(schema.salesTaxTaxabilityRules).where(eq(schema.salesTaxTaxabilityRules.agencyId, books.agencies.tx));
    expect(rules.map((r) => [r.taxCode, r.taxable])).toEqual(expect.arrayContaining([['shipping', true], ['handling', true]]));
  });
});

describe('sales: Texas (origin-sourced)', () => {
  let invoiceId: string;
  let journalEntryId: string;
  let itemIds: string[];

  it('taxes at the seller location by jurisdiction, shipping included, and posts to the agency payable', async () => {
    const created = await createInvoice({
      contactId: 'pty_tx',
      items: [
        { description: 'Widgets', quantity: '1', unitPrice: '1000' },
        { description: 'Shipping', quantity: '1', unitPrice: '50', taxCode: 'shipping' },
      ],
    });
    invoiceId = created.id;
    itemIds = created.items.map((i) => i.id);
    // State 65.625 -> 65.63, city 10.50, transit 10.50.
    expect(created).toMatchObject({ subtotal: '1050.00', taxTotal: '86.63', total: '1136.63' });

    const [draft] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(draft).toMatchObject({ taxEngine: 'manual', status: 'draft' });
    expect(draft.taxCalculatedAt).not.toBeNull();
    expect((draft.taxBreakdown ?? []).map((r) => [r.jurisdictionName, r.lineId === itemIds[0] ? 0 : 1])).toHaveLength(6);

    const res = await finalize(invoiceId);
    expect(res.status).toBe(200);
    journalEntryId = res.data.journalEntryId;

    const lines = await entryLines(journalEntryId);
    expect(lines).toEqual([
      { code: '1100', name: 'Accounts receivable', debit: 1136.63, credit: 0, classId: null, locationId: null },
      { code: '2201', name: 'Sales Tax Payable – Texas Comptroller of Public Accounts', debit: 0, credit: 86.63, classId: null, locationId: null },
      { code: '4000', name: 'Sales revenue', debit: 0, credit: 1050, classId: null, locationId: null },
    ]);

    // The agency shows what is owed as a positive amount.
    const agency = await books.api('/api/sales-tax-agencies', salesTaxAgenciesRoutes, `/${books.agencies.tx}`);
    expect(agency.data.liabilityAccount).toMatchObject({ code: '2201', balance: '86.63' });
  });

  it('writes one tax-ledger row per jurisdiction and line, with the source line and the US columns', async () => {
    const rows = await taxRowsOf(invoiceId);
    expect(rows).toHaveLength(6);
    expect(sum(rows)).toBe(86.63);
    expect(new Set(rows.map((r) => r.sourceLineId))).toEqual(new Set(itemIds));
    expect(new Set(rows.map((r) => r.jurisdictionName))).toEqual(new Set(['Texas', 'Austin', 'Capital Metro']));
    for (const row of rows) {
      expect(row).toMatchObject({
        sourceType: 'invoice',
        direction: 'sales',
        taxDate: '2026-07-10',
        stateCode: 'TX',
        shipToState: 'TX',
        shipToPostalCode: '78701',
        engine: 'manual',
        agencyId: books.agencies.tx,
        taxRateId: null,
        exemptAmount: '0.00',
        marketplaceFacilitated: false,
        journalEntryId,
      });
      expect(Number(row.grossAmount)).toBe(Number(row.taxableAmount));
      expect(row.unroundedTaxAmount).not.toBeNull();
    }
    const state = rows.filter((r) => r.jurisdictionName === 'Texas');
    expect(state.map((r) => Number(r.rate))).toEqual([6.25, 6.25]);
    expect(sum(state)).toBe(65.63);
  });

  it('prints the sales tax per jurisdiction on the invoice document', async () => {
    const res = await invoices(`/${invoiceId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sales tax - Texas 6.25% on $1,050.00');
    expect(res.text).toContain('Sales tax - Austin 1% on $1,050.00');
    expect(res.text).toContain('EIN: ');
  });

  it('keeps a posted invoice frozen when the rates change afterwards', async () => {
    const [state] = await db.select().from(schema.salesTaxJurisdictions).where(and(eq(schema.salesTaxJurisdictions.agencyId, books.agencies.tx), eq(schema.salesTaxJurisdictions.level, 'state')));
    const raised = await books.api('/api/sales-tax-jurisdictions', salesTaxJurisdictionsRoutes, `/${state.id}/rates`, {
      method: 'POST',
      body: { rate: 7, effectiveFrom: '2027-01-01', closePrevious: true },
    });
    expect(raised.status).toBe(201);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(invoice.taxTotal).toBe('86.63');
    const edit = await invoices(`/${invoiceId}`, { method: 'PATCH', body: { notes: 'late edit' } });
    expect(edit.status).toBe(400);
    // The old rate still applies to a document dated before the change.
    const early = await createInvoice({ contactId: 'pty_tx', issueDate: '2026-12-31', items: [{ description: 'x', unitPrice: '100' }] });
    expect(early.taxTotal).toBe('8.25');
    const late = await createInvoice({ contactId: 'pty_tx', issueDate: '2027-01-02', items: [{ description: 'x', unitPrice: '100' }] });
    expect(late.taxTotal).toBe('9.00');
  });

  it('a credit memo in the next period writes negative rows at the original rates', async () => {
    const created = await invoices(`/${invoiceId}/credit-note`, { method: 'POST' });
    expect(created.status).toBe(201);
    const memoId = created.data.id as string;
    const moved = await invoices(`/${memoId}`, { method: 'PATCH', body: { issueDate: '2026-08-05' } });
    expect(moved.status).toBe(200);
    // Never recalculated at today's (or the new date's) rates: the invoice's own.
    expect(moved.data).toMatchObject({ taxTotal: '86.63', total: '1136.63' });

    const finalized = await finalize(memoId);
    expect(finalized.status).toBe(200);
    expect(await entryLines(finalized.data.journalEntryId)).toEqual([
      { code: '1100', name: 'Accounts receivable', debit: 0, credit: 1136.63, classId: null, locationId: null },
      { code: '2201', name: 'Sales Tax Payable – Texas Comptroller of Public Accounts', debit: 86.63, credit: 0, classId: null, locationId: null },
      { code: '4000', name: 'Sales revenue', debit: 1050, credit: 0, classId: null, locationId: null },
    ]);

    const rows = await taxRowsOf(memoId);
    expect(rows).toHaveLength(6);
    expect(sum(rows)).toBe(-86.63);
    for (const row of rows) {
      expect(row).toMatchObject({ sourceType: 'credit_note', taxDate: '2026-08-05', agencyId: books.agencies.tx });
      expect(Number(row.taxableAmount)).toBeLessThan(0);
      expect(Number(row.grossAmount)).toBeLessThan(0);
    }
    expect(rows.filter((r) => r.jurisdictionName === 'Texas').map((r) => Number(r.rate))).toEqual([6.25, 6.25]);
    // The memo's rows are keyed on the memo's own lines.
    const memoItems = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, memoId));
    expect(new Set(rows.map((r) => r.sourceLineId))).toEqual(new Set(memoItems.map((i) => i.id)));
  });

  it('a partial credit memo reverses a share of the tax at the original rates', async () => {
    const invoice = await createInvoice({ contactId: 'pty_tx', items: [{ description: 'Widget', quantity: '2', unitPrice: '100' }] });
    expect(invoice.taxTotal).toBe('16.50');
    await finalize(invoice.id);
    const memo = (await invoices(`/${invoice.id}/credit-note`, { method: 'POST' })).data.id as string;
    const edited = await invoices(`/${memo}`, { method: 'PATCH', body: { items: [{ description: 'Widget', quantity: '1', unitPrice: '100' }] } });
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({ subtotal: '100.00', taxTotal: '8.25', total: '108.25' });
    const finalized = await finalize(memo);
    expect(finalized.status).toBe(200);
    expect(sum(await taxRowsOf(memo))).toBe(-8.25);
  });

  it('a credit line that is not on the invoice is refused', async () => {
    const invoice = await createInvoice({ contactId: 'pty_tx', items: [{ description: 'Widget', unitPrice: '100' }] });
    await finalize(invoice.id);
    const memo = (await invoices(`/${invoice.id}/credit-note`, { method: 'POST' })).data.id as string;
    const bad = await invoices(`/${memo}`, { method: 'PATCH', body: { items: [{ description: 'Something else entirely', unitPrice: '10' }] } });
    expect(bad.status).toBe(400);
    expect(bad.error?.code).toBe('CREDIT_LINE_NOT_ON_ORIGINAL');
  });
});

describe('sales: other states', () => {
  it('a state the entity is not registered in gets no tax, a warning and a zero-tax ledger row for nexus', async () => {
    const created = await createInvoice({ contactId: 'pty_ca', billingAddress: sanFrancisco, items: [{ description: 'Widgets', unitPrice: '200' }] });
    expect(created).toMatchObject({ taxTotal: '0.00', total: '200.00' });
    expect(created.taxWarnings).toContain('not_registered_in_state');

    const res = await finalize(created.id);
    expect(res.status).toBe(200);
    expect(await entryLines(res.data.journalEntryId)).toEqual([
      { code: '1100', name: 'Accounts receivable', debit: 200, credit: 0, classId: null, locationId: null },
      { code: '4000', name: 'Sales revenue', debit: 0, credit: 200, classId: null, locationId: null },
    ]);
    const rows = await taxRowsOf(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stateCode: 'CA', shipToState: 'CA', taxAmount: '0.00', taxableAmount: '0.00', grossAmount: '200.00', nonTaxableAmount: '200.00', agencyId: null });
  });

  it('a destination state taxes each ZIP at its own zone', async () => {
    const inSeattle = await createInvoice({ contactId: 'pty_wa', billingAddress: seattle, items: [{ description: 'Widgets', unitPrice: '100' }] });
    const inBellevue = await createInvoice({ contactId: 'pty_wa', billingAddress: bellevue, items: [{ description: 'Widgets', unitPrice: '100' }] });
    expect(inSeattle.taxTotal).toBe('10.10');
    expect(inBellevue.taxTotal).toBe('10.50');
    const res = await finalize(inBellevue.id);
    const rows = await taxRowsOf(inBellevue.id);
    expect(rows.map((r) => [r.jurisdictionName, r.taxAmount]).sort()).toEqual([
      ['Bellevue', '2.90'],
      ['Sound Transit', '1.10'],
      ['Washington', '6.50'],
    ]);
    const waAgency = (await db.select().from(schema.salesTaxAgencies).where(eq(schema.salesTaxAgencies.id, books.agencies.wa)))[0];
    const payable = (await entryLines(res.data.journalEntryId)).find((l) => l.credit === 10.5);
    expect(payable?.name).toContain('Washington');
    expect(payable?.code).toBe((await db.select().from(schema.accounts).where(eq(schema.accounts.id, waAgency.liabilityAccountId!)))[0].code);
  });

  it('a registered state with no rate in force is refused at finalize instead of posting zero tax', async () => {
    const agency = await books.api('/api/sales-tax-agencies', salesTaxAgenciesRoutes, '', {
      method: 'POST',
      body: { stateCode: 'NY', registeredFrom: '2026-01-01' },
    });
    expect(agency.status).toBe(201);
    const invoice = await createInvoice({
      contactId: 'pty_ca',
      billingAddress: { line1: '1 Broadway', city: 'New York', state: 'NY', postalCode: '10004', country: 'US' },
      items: [{ description: 'Widgets', unitPrice: '100' }],
    });
    expect(invoice.taxWarnings).toContain('rates_not_configured');
    const res = await finalize(invoice.id);
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('TAX_RATES_NOT_CONFIGURED');
    const [stored] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.id));
    expect(stored).toMatchObject({ status: 'draft', journalEntryId: null });
  });

  it('an invoice that needs tax has to name a ship-to or bill-to state and ZIP', async () => {
    const noAddress = await createInvoice({ contactId: 'pty_tx', billingAddress: null, items: [{ description: 'Widgets', unitPrice: '100' }] });
    const refused = await finalize(noAddress.id);
    expect(refused.status).toBe(400);
    expect(refused.error?.code).toBe('ADDRESS_REQUIRED');

    const noZip = await createInvoice({ contactId: 'pty_tx', billingAddress: { line1: '1 Main', city: 'Austin', state: 'TX' }, items: [{ description: 'Widgets', unitPrice: '100' }] });
    expect((await finalize(noZip.id)).error?.code).toBe('ADDRESS_REQUIRED');

    // The ship-to address wins over the bill-to address, and fixes it.
    const fixed = await invoices(`/${noZip.id}`, { method: 'PATCH', body: { shippingAddress: dallas } });
    expect(fixed.status).toBe(200);
    expect(fixed.data.taxTotal).toBe('8.25');
    expect((await finalize(noZip.id)).status).toBe(200);
  });

  it('a buyer abroad needs no US address and pays no US tax', async () => {
    const abroad = await createInvoice({
      contactId: 'pty_tx',
      billingAddress: { line1: '1 Bay St', city: 'Toronto', state: 'ON', postalCode: 'M5J 2N8', country: 'CA' },
      items: [{ description: 'Widgets', unitPrice: '100' }],
    });
    expect(abroad.taxTotal).toBe('0.00');
    expect((await finalize(abroad.id)).status).toBe(200);
  });
});

describe('exemption certificates', () => {
  let certificateId: string;

  it('a valid resale certificate zeroes the tax, records the reason and prints on the invoice', async () => {
    const cert = await books.api('/api/exemption-certificates', exemptionCertificatesRoutes, '', {
      method: 'POST',
      body: { partyId: 'pty_fl', states: ['fl'], reason: 'resale', certificateNumber: 'FL-85-1234', issuedOn: '2026-01-01', expiresOn: '2026-12-31' },
    });
    expect(cert.status).toBe(201);
    expect(cert.data).toMatchObject({ status: 'valid', states: ['FL'], blanket: true });
    certificateId = cert.data.id;

    const invoice = await createInvoice({ contactId: 'pty_fl', billingAddress: miami, items: [{ description: 'Stock for resale', unitPrice: '500' }] });
    expect(invoice).toMatchObject({ taxTotal: '0.00', total: '500.00' });
    const res = await finalize(invoice.id);
    expect(res.status).toBe(200);

    const rows = await taxRowsOf(invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stateCode: 'FL',
      agencyId: books.agencies.fl,
      taxableAmount: '0.00',
      exemptAmount: '500.00',
      grossAmount: '500.00',
      exemptReason: 'resale',
      certificateId,
      taxAmount: '0.00',
    });
    const pdf = await invoices(`/${invoice.id}/pdf`);
    expect(pdf.text).toContain('Exempt sale: Resale. Certificate no. FL-85-1234.');
  });

  it('the same customer after the certificate expired is taxed, with a warning', async () => {
    const invoice = await createInvoice({ contactId: 'pty_fl', billingAddress: miami, issueDate: '2027-02-01', dueDate: '2027-03-01', items: [{ description: 'Stock', unitPrice: '500' }] });
    expect(invoice.taxTotal).toBe('30.00');
    expect(invoice.taxWarnings).toContain('certificate_expired');
    const listed = await books.api('/api/exemption-certificates', exemptionCertificatesRoutes, '?partyId=pty_fl');
    expect(listed.data[0].id).toBe(certificateId);
  });
});

describe('overrides and inclusive prices', () => {
  it('a hand-set tax sticks across edits of the draft', async () => {
    const created = await createInvoice({
      contactId: 'pty_tx',
      items: [{ description: 'Widgets', unitPrice: '100', taxOverrideAmount: '5.00', taxOverrideReason: 'Negotiated' }],
    });
    expect(created).toMatchObject({ taxTotal: '5.00', total: '105.00' });

    // Changing the ship-to re-taxes the stored lines; the override survives.
    const moved = await invoices(`/${created.id}`, { method: 'PATCH', body: { shippingAddress: dallas } });
    expect(moved.data.taxTotal).toBe('5.00');
    const [item] = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, created.id));
    expect(item).toMatchObject({ taxOverrideAmount: '5.00', taxOverrideReason: 'Negotiated', taxAmount: '5.00' });

    const res = await finalize(created.id);
    expect(res.status).toBe(200);
    expect(sum(await taxRowsOf(created.id))).toBe(5);
  });

  it('a tax-inclusive line backs the tax out of the price and posts the net as revenue', async () => {
    const created = await createInvoice({ contactId: 'pty_tx', items: [{ description: 'Widgets', unitPrice: '108.25', taxIncluded: true }] });
    expect(created).toMatchObject({ subtotal: '100.00', taxTotal: '8.25', total: '108.25' });
    const res = await finalize(created.id);
    const lines = await entryLines(res.data.journalEntryId);
    expect(lines.find((l) => l.code === '4000')?.credit).toBe(100);
    expect(lines.find((l) => l.code === '1100')?.debit).toBe(108.25);
  });
});

describe('write-off of an invoice with tax', () => {
  it('books the bad debt net of tax and takes the tax back off the agency payable, per jurisdiction', async () => {
    const created = await createInvoice({ contactId: 'pty_tx', items: [{ description: 'Widgets', unitPrice: '300' }] });
    expect(created.taxTotal).toBe('24.75');
    await finalize(created.id);

    const res = await invoices(`/${created.id}/status`, { method: 'PATCH', body: { status: 'uncollectible' } });
    expect(res.status).toBe(200);
    const entryId = res.data.writeOffEntryId as string;
    expect(await entryLines(entryId)).toEqual([
      { code: '1100', name: 'Accounts receivable', debit: 0, credit: 324.75, classId: null, locationId: null },
      { code: '2201', name: 'Sales Tax Payable – Texas Comptroller of Public Accounts', debit: 24.75, credit: 0, classId: null, locationId: null },
      { code: '6210', name: 'Bad debt expense', debit: 300, credit: 0, classId: null, locationId: null },
    ]);

    const rows = (await taxRowsOf(created.id)).filter((r) => r.sourceType === 'write_off');
    expect(rows).toHaveLength(3);
    expect(sum(rows)).toBe(-24.75);
    for (const row of rows) expect(row).toMatchObject({ direction: 'sales', agencyId: books.agencies.tx, taxDate: expect.any(String) });
  });
});

describe('purchases', () => {
  it('sales tax a vendor charged is part of the line cost, with no receivable and no tax-ledger row', async () => {
    const created = await bills('', {
      method: 'POST',
      body: {
        contactId: 'pty_vendor',
        issueDate: '2026-07-11',
        dueDate: '2026-08-11',
        items: [{ description: 'Printer paper', quantity: '1', unitPrice: '100', taxRate: '8.25', accountId: books.roleAccount.get('general_expense') }],
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.total).toBe('108.25');
    const approved = await bills(`/${created.data.id}/approve`, { method: 'PATCH' });
    expect(approved.status).toBe(200);
    expect(await entryLines(approved.data.journalEntryId)).toEqual([
      { code: '2000', name: 'Accounts payable', debit: 0, credit: 108.25, classId: null, locationId: null },
      { code: '6290', name: 'General and miscellaneous expense', debit: 108.25, credit: 0, classId: null, locationId: null },
    ]);
    expect(await taxRowsOf(created.data.id)).toHaveLength(0);
  });

  it('a line marked accrue use tax accrues it at the delivery address and posts it to the agency use tax payable', async () => {
    const created = await bills('', {
      method: 'POST',
      body: {
        contactId: 'pty_vendor',
        issueDate: '2026-07-12',
        dueDate: '2026-08-12',
        deliveryAddress: austin,
        items: [{ description: 'Out-of-state equipment', quantity: '1', unitPrice: '1000', accrueUseTax: true, accountId: books.roleAccount.get('general_expense') }],
      },
    });
    expect(created.status).toBe(201);
    // The vendor charged nothing: the bill total is the price.
    expect(created.data.total).toBe('1000.00');

    const approved = await bills(`/${created.data.id}/approve`, { method: 'PATCH' });
    expect(approved.status).toBe(200);
    const lines = await entryLines(approved.data.journalEntryId);
    expect(lines.filter((l) => l.code === '6290').reduce((s, l) => s + l.debit, 0)).toBe(1082.5);
    expect(lines.find((l) => l.code === '2000')?.credit).toBe(1000);
    const [agency] = await db.select().from(schema.salesTaxAgencies).where(eq(schema.salesTaxAgencies.id, books.agencies.tx));
    const [useAccount] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, agency.useTaxAccountId!));
    expect(lines.find((l) => l.code === useAccount.code)).toMatchObject({ credit: 82.5, name: 'Use Tax Payable – Texas Comptroller of Public Accounts' });

    const rows = await taxRowsOf(created.data.id);
    expect(rows).toHaveLength(3);
    expect(sum(rows)).toBe(82.5);
    for (const row of rows) expect(row).toMatchObject({ sourceType: 'bill', direction: 'use', shipToState: 'TX', agencyId: books.agencies.tx });
  });

  it('use tax in a state with no rates configured is refused instead of accruing nothing', async () => {
    const res = await bills('', {
      method: 'POST',
      body: {
        contactId: 'pty_vendor',
        issueDate: '2026-07-12',
        dueDate: '2026-08-12',
        deliveryAddress: { line1: '1 Broadway', city: 'New York', state: 'NY', postalCode: '10004', country: 'US' },
        items: [{ description: 'Equipment', unitPrice: '100', accrueUseTax: true }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe('TAX_RATES_NOT_CONFIGURED');
  });
});

describe('recurring invoices', () => {
  it('generates a US invoice with tax from the template and posts it when autoFinalize is on', async () => {
    await db.insert(schema.recurringInvoices).values({
      id: 'ri_us',
      entityId: books.entityId,
      contactId: 'pty_tx',
      frequency: 'monthly',
      nextIssueDate: new Date('2026-09-01'),
      status: 'active',
      autoFinalize: true,
      templateData: { items: [{ description: 'Retainer', quantity: 1, unitPrice: 200, taxCode: 'general' }] },
    });
    const generated = await books.api('/api/recurring-invoices', recurringInvoicesRoutes, '/ri_us/generate', { method: 'POST' });
    expect(generated.status).toBe(201);
    expect(generated.data.finalizeError).toBeNull();
    expect(generated.data.journalEntryId).toMatch(/^je_/);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, generated.data.invoiceId));
    expect(invoice).toMatchObject({ taxTotal: '16.50', total: '216.50', status: 'sent', taxEngine: 'manual' });
    expect(sum(await taxRowsOf(invoice.id))).toBe(16.5);
  });
});

describe('class and location', () => {
  it('carry from invoice lines onto the revenue journal line, and unknown ids are refused', async () => {
    await db.insert(schema.accountingDimensionValues).values([
      { id: 'dim_cls', entityId: books.entityId, dimension: 'class', name: 'Retail' },
      { id: 'dim_loc', entityId: books.entityId, dimension: 'location', name: 'Austin shop' },
    ]);
    const created = await createInvoice({
      contactId: 'pty_tx',
      items: [{ description: 'Widgets', unitPrice: '100', classId: 'dim_cls', locationId: 'dim_loc' }],
    });
    const res = await finalize(created.id);
    const revenue = (await entryLines(res.data.journalEntryId)).find((l) => l.code === '4000');
    expect(revenue).toMatchObject({ credit: 100, classId: 'dim_cls', locationId: 'dim_loc' });

    // A location id is not a class.
    const wrong = await invoices('', {
      method: 'POST',
      body: { contactId: 'pty_tx', issueDate: '2026-07-10', dueDate: '2026-08-10', billingAddress: austin, items: [{ description: 'x', unitPrice: '1', classId: 'dim_loc' }] },
    });
    expect(wrong.status).toBe(400);

    const entry = await books.api('/api/journal-entries', journalEntriesRoutes, '', {
      method: 'POST',
      body: {
        date: '2026-07-15',
        lines: [
          { accountId: books.roleAccount.get('general_expense'), debit: '10', classId: 'dim_cls' },
          { accountId: books.roleAccount.get('sales_revenue'), credit: '10', locationId: 'dim_loc' },
        ],
      },
    });
    expect(entry.status).toBe(201);
    const stored = await db.select().from(schema.journalLines).where(eq(schema.journalLines.journalEntryId, entry.data.id));
    expect(stored.map((l) => [l.classId, l.locationId])).toEqual(expect.arrayContaining([['dim_cls', null], [null, 'dim_loc']]));
    const refused = await books.api('/api/journal-entries', journalEntriesRoutes, '', {
      method: 'POST',
      body: {
        date: '2026-07-15',
        lines: [
          { accountId: books.roleAccount.get('general_expense'), debit: '10', classId: 'nope' },
          { accountId: books.roleAccount.get('sales_revenue'), credit: '10' },
        ],
      },
    });
    expect(refused.status).toBe(400);
  });
});

describe('payments', () => {
  it('record-payment passes depositTo through: a check can go to undeposited funds or straight to the bank', async () => {
    const created = await createInvoice({ contactId: 'pty_tx', items: [{ description: 'Widgets', unitPrice: '100' }] });
    await finalize(created.id);
    const paid = await invoices(`/${created.id}/record-payment`, {
      method: 'POST',
      body: { amount: '108.25', date: '2026-07-20', paymentMethod: 'check', checkNumber: '1001', depositTo: 'undeposited_funds' },
    });
    expect(paid.status).toBe(201);
    const lines = await entryLines(paid.data.journalEntryId);
    expect(lines.find((l) => l.debit === 108.25)?.code).toBe('1050');
  });

  it('a vendor payment can withhold: the bills settle gross, the bank is credited net, the rest goes to backup withholding payable', async () => {
    const bill = await bills('', {
      method: 'POST',
      body: { contactId: 'pty_vendor', issueDate: '2026-07-11', dueDate: '2026-08-11', items: [{ description: 'Consulting', unitPrice: '100', accountId: books.roleAccount.get('general_expense') }] },
    });
    await bills(`/${bill.data.id}/approve`, { method: 'PATCH' });

    const input = {
      id: 'pay_idempotent_1',
      entityId: books.entityId,
      type: 'sent' as const,
      amount: 100,
      date: new Date('2026-07-20'),
      paymentMethod: 'ach',
      paymentRunId: 'prn_test_run',
      backupWithholdingAmount: 24,
      allocations: [{ billId: bill.data.id as string, amount: 100 }],
      userId: null,
    };
    const first = await recordPayment(db, input);
    expect(first.paymentId).toBe('pay_idempotent_1');
    expect(await entryLines(first.journalEntryId!)).toEqual([
      { code: '1000', name: 'Checking', debit: 0, credit: 76, classId: null, locationId: null },
      { code: '2000', name: 'Accounts payable', debit: 100, credit: 0, classId: null, locationId: null },
      { code: '2310', name: 'Backup withholding payable', debit: 0, credit: 24, classId: null, locationId: null },
    ]);
    const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, 'pay_idempotent_1'));
    expect(payment).toMatchObject({ amount: '100.00', backupWithholdingAmount: '24.00', paymentRunId: 'prn_test_run' });
    const [settled] = await db.select().from(schema.bills).where(eq(schema.bills.id, bill.data.id));
    expect(settled).toMatchObject({ status: 'paid', balanceDue: '0.00' });

    // The same id again is the same payment, not a second one.
    const again = await recordPayment(db, input);
    expect(again).toMatchObject({ paymentId: 'pay_idempotent_1', journalEntryId: first.journalEntryId });
    expect(await db.select().from(schema.payments).where(eq(schema.payments.id, 'pay_idempotent_1'))).toHaveLength(1);

    // Money received from a customer is never withheld.
    const invoice = await createInvoice({ contactId: 'pty_tx', items: [{ description: 'Widgets', unitPrice: '10' }] });
    await finalize(invoice.id);
    await expect(
      recordPayment(db, { entityId: books.entityId, type: 'received', amount: 10.83, date: new Date('2026-07-21'), backupWithholdingAmount: 1, allocations: [{ invoiceId: invoice.id, amount: 10.83 }], userId: null }),
    ).rejects.toThrow(PostingError);
  });
});

describe('invoice from a commerce order', () => {
  it('lets the engine tax the order: a line per item with its tax code, shipping as its own line, the order discount spread', async () => {
    await db.insert(schema.products).values({ id: 'prod_gift', name: 'Gift card', slug: 'gift-card', taxable: false });
    await db.insert(schema.orders).values({
      id: 'ord_us',
      orderNumber: 'SO-1001',
      counterpartyId: 'pty_tx',
      currency: 'USD',
      subtotal: '200.00',
      discountTotal: '20.00',
      shippingTotal: '10.00',
      total: '190.00',
      billingAddress: austin,
      shippingAddress: austin,
      metadata: { salesTax: { lines: [{ lineId: 'oi_hosted', taxCode: 'saas' }] } },
    });
    await db.insert(schema.orderItems).values([
      { id: 'oi_gift', orderId: 'ord_us', productId: 'prod_gift', name: 'Gift card', quantity: 1, unitPrice: '100.00', total: '100.00' },
      { id: 'oi_hosted', orderId: 'ord_us', name: 'Hosted plan', quantity: 2, unitPrice: '50.00', total: '100.00' },
    ]);

    const res = await invoices('/from-order/ord_us', { method: 'POST' });
    expect(res.status).toBe(201);
    // 20.00 off, half on each item; 90 of SaaS + 10 shipping are taxable at 8.25% (no rule makes either exempt).
    expect(res.data).toMatchObject({ taxTotal: '8.25', total: '198.25' });

    const items = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, res.data.invoiceId)).orderBy(asc(schema.invoiceItems.sortOrder));
    expect(items.map((i) => [i.description, i.taxCode, i.lineTotal, i.taxAmount])).toEqual([
      ['Gift card', 'non_taxable', '90.00', '0.00'],
      ['Hosted plan', 'saas', '90.00', '7.43'],
      ['Shipping', 'shipping', '10.00', '0.82'],
    ]);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, res.data.invoiceId));
    expect(invoice).toMatchObject({ commerceOrderId: 'ord_us', taxEngine: 'manual', subtotal: '190.00', reference: 'SO-1001' });
    expect(invoice.shippingAddress).toMatchObject({ state: 'TX', postalCode: '78701' });
  });
});

describe('US chart lookups', () => {
  it('categorizing a bank line with the seeded 0% rate needs no tax account, and a US purchase rate stays in the cost', async () => {
    const [noTax] = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, books.entityId));
    const [checking] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.entityId, books.entityId), eq(schema.accounts.code, '1000')));
    await db.insert(schema.bankAccounts).values({ id: 'ba_us', entityId: books.entityId, name: 'Operating', currency: 'USD', ledgerAccountId: checking.id });
    await db.insert(schema.bankTransactions).values([
      { id: 'bt_zero', entityId: books.entityId, bankAccountId: 'ba_us', date: new Date('2026-07-05'), amount: '-50.00', status: 'unreconciled', description: 'Parking' },
      { id: 'bt_rate', entityId: books.entityId, bankAccountId: 'ba_us', date: new Date('2026-07-06'), amount: '-108.25', status: 'unreconciled', description: 'Supplies' },
    ]);
    const [parking] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_zero'));
    const zero = await categorizeBankTransaction(db, { txn: parking, categoryAccountId: books.roleAccount.get('general_expense')!, taxRateId: noTax.id, userId: null });
    expect((await entryLines(zero.journalEntryId)).map((l) => [l.code, l.debit, l.credit])).toEqual([['1000', 0, 50], ['6290', 50, 0]]);
    expect(await taxRowsOf('bt_zero')).toHaveLength(0);

    // A US vendor's sales tax is never reclaimed: a rate on a purchase leaves the whole amount in the expense.
    const [custom] = await db
      .insert(schema.taxRates)
      .values({ id: 'tr_us_8', entityId: books.entityId, name: 'Vendor sales tax 8.25%', jurisdictionCode: 'US', rate: '8.2500', type: 'purchase', isActive: true })
      .returning();
    const [supplies] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_rate'));
    const withRate = await categorizeBankTransaction(db, { txn: supplies, categoryAccountId: books.roleAccount.get('general_expense')!, taxRateId: custom.id, userId: null });
    expect((await entryLines(withRate.journalEntryId)).map((l) => [l.code, l.debit, l.credit])).toEqual([['1000', 0, 108.25], ['6290', 108.25, 0]]);
  });
});
