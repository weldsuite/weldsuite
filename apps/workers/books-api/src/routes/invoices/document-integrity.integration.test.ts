/**
 * Found in the WeldBooks QA run of 2026-10-10:
 * - TASK-1101: an X-Accounting-Entity-Id that isn't an entity of this
 *   workspace (kept from another workspace) is refused, never written to;
 * - TASK-1102: invoices, bills and credit notes keep the contact's name,
 *   and documents stored without one show the contact's;
 * - TASK-1107: contra accounts (input VAT on a liability, accumulated
 *   depreciation on an asset) reduce their balance-sheet section;
 * - TASK-1116: a credit note is applied to the invoice it credits, refunded
 *   as money going out, never written off, and a draft's PDF is marked.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { invoicesRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { accountingReportsRoutes } from '../accounting-reports';
import { billsRoutes } from '../bills';
import { journalEntriesRoutes } from '../journal-entries';
import { paymentsRoutes } from '../payments';

let db: Database;
let nl: { id: string; acct: Record<string, string>; hoog: string };

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { message: string };
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; entityId?: string } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.entityId ? { 'X-Accounting-Entity-Id': opts.entityId } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  let json: { data?: unknown; error?: { message: string } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // HTML
  }
  return { status: res.status, data: json.data, error: json.error, text };
}

const invoices = (path: string, opts: { method?: string; body?: unknown; entityId?: string } = {}) =>
  call('/api/invoices', invoicesRoutes, `/api/invoices${path}`, { entityId: nl.id, ...opts });

async function accountsByCode(entityId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  return Object.fromEntries(rows.map((a) => [a.code, a.id]));
}

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows
    .map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

async function createNlEntity(name: string) {
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: {
      name,
      jurisdictionCode: 'NL',
      vatNumber: 'NL123456789B01',
      taxIdentifiers: { registrationNumber: '12345678' },
      bankDetails: { iban: 'NL91ABNA0417164300' },
    },
  });
  expect(created.status).toBe(201);
  return created.data.id as string;
}

/** A finalized 100 + 21% invoice for the customer. */
async function finalizedInvoice(issueDate = '2026-07-10') {
  const created = await invoices('', {
    method: 'POST',
    body: {
      contactId: 'pty_customer',
      issueDate,
      dueDate: '2099-12-31',
      items: [{ description: 'Consulting', quantity: '1', unitPrice: '100', taxRateId: nl.hoog }],
    },
  });
  expect(created.status).toBe(201);
  const finalized = await invoices(`/${created.data.id}/finalize`, { method: 'POST' });
  expect(finalized.status).toBe(200);
  return created.data.id as string;
}

async function invoiceRow(id: string) {
  const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1);
  return row;
}

async function creditNoteFor(invoiceId: string) {
  const created = await invoices(`/${invoiceId}/credit-note`, { method: 'POST' });
  expect(created.status).toBe(201);
  return created.data.id as string;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.parties).values([
    { id: 'pty_customer', displayName: 'Klant BV', role: 'customer', billingAddress: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB', country: 'NL' } },
    { id: 'pty_supplier', displayName: 'Leverancier BV', role: 'supplier' },
  ]);
  const id = await createNlEntity('Integrity BV');
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, id));
  nl = { id, acct: await accountsByCode(id), hoog: rates.find((r) => r.name === 'BTW Hoog 21%')!.id };
}, 60_000);

describe('TASK-1101 · an entity id from another workspace', () => {
  it('creating an invoice under it is refused and stores nothing', async () => {
    const res = await invoices('', {
      method: 'POST',
      entityId: 'ent_other_workspace',
      body: {
        contactId: 'pty_customer',
        issueDate: '2026-07-10',
        dueDate: '2026-07-24',
        items: [{ description: 'Consulting', quantity: '1', unitPrice: '100' }],
      },
    });
    expect(res.status).toBe(400);
    const stored = await db.select().from(schema.invoices).where(eq(schema.invoices.entityId, 'ent_other_workspace'));
    expect(stored).toEqual([]);
    const sequences = await db
      .select()
      .from(schema.entityNumberSequences)
      .where(eq(schema.entityNumberSequences.entityId, 'ent_other_workspace'));
    expect(sequences).toEqual([]);
  });

  it('lists nothing under it, and a deleted entity counts as unknown too', async () => {
    const listed = await invoices('', { entityId: 'ent_other_workspace' });
    expect(listed.status).toBe(200);
    expect(listed.data).toEqual([]);

    const goneId = await createNlEntity('Gone BV');
    await db.update(schema.entities).set({ deletedAt: new Date() }).where(eq(schema.entities.id, goneId));
    const bill = await call('/api/bills', billsRoutes, '/api/bills', {
      method: 'POST',
      entityId: goneId,
      body: { contactId: 'pty_supplier', issueDate: '2026-07-10', dueDate: '2026-07-24', items: [{ description: 'Paper', quantity: '1', unitPrice: '10' }] },
    });
    expect(bill.status).toBe(400);
  });

  it('an entityId in the bill body gets the same check as the header', async () => {
    const goneId = await createNlEntity('Gone Too BV');
    await db.update(schema.entities).set({ deletedAt: new Date() }).where(eq(schema.entities.id, goneId));
    const bill = await call('/api/bills', billsRoutes, '/api/bills', {
      method: 'POST',
      entityId: nl.id,
      body: {
        entityId: goneId,
        contactId: 'pty_supplier',
        issueDate: '2026-07-10',
        dueDate: '2026-07-24',
        items: [{ description: 'Paper', quantity: '1', unitPrice: '10' }],
      },
    });
    expect(bill.status).toBe(400);
    expect(await db.select().from(schema.bills).where(eq(schema.bills.entityId, goneId))).toEqual([]);
  });
});

describe('TASK-1102 · documents keep the contact name', () => {
  it('an invoice created with only contactId stores the contact name and prints it', async () => {
    const created = await invoices('', {
      method: 'POST',
      body: { contactId: 'pty_customer', issueDate: '2026-07-10', dueDate: '2026-07-24', items: [{ description: 'Work', quantity: '1', unitPrice: '50' }] },
    });
    expect(created.status).toBe(201);
    expect(created.data.contactName).toBe('Klant BV');
    expect((await invoiceRow(created.data.id))?.contactName).toBe('Klant BV');

    const pdf = await invoices(`/${created.data.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.text).toContain('Klant BV');
  });

  it('an invoice stored without a name shows, finds and credits under the contact name', async () => {
    const id = await finalizedInvoice();
    await db.update(schema.invoices).set({ contactName: null }).where(eq(schema.invoices.id, id));

    const listed = await invoices('');
    expect(listed.data.find((r: { id: string }) => r.id === id)?.contactName).toBe('Klant BV');
    expect((await invoices(`/${id}`)).data.contactName).toBe('Klant BV');
    const searched = await invoices('?search=Klant');
    expect(searched.data.map((r: { id: string }) => r.id)).toContain(id);
    expect((await invoices(`/${id}/pdf`)).text).toContain('Klant BV');

    const creditNoteId = await creditNoteFor(id);
    expect((await invoiceRow(creditNoteId))?.contactName).toBe('Klant BV');
  });

  it('a bill created with only contactId stores the supplier name', async () => {
    const res = await call('/api/bills', billsRoutes, '/api/bills', {
      method: 'POST',
      entityId: nl.id,
      body: { contactId: 'pty_supplier', issueDate: '2026-07-10', dueDate: '2026-07-24', items: [{ description: 'Paper', quantity: '1', unitPrice: '10' }] },
    });
    expect(res.status).toBe(201);
    expect(res.data.contactName).toBe('Leverancier BV');
  });
});

describe('TASK-1107 · contra accounts on the balance sheet', () => {
  async function postEntry(entityId: string, acct: Record<string, string>, lines: Array<[string, 'debit' | 'credit', string]>) {
    const created = await call('/api/journal-entries', journalEntriesRoutes, '/api/journal-entries', {
      method: 'POST',
      entityId,
      body: { date: '2026-07-20', description: 'Contra test', lines: lines.map(([code, side, amount]) => ({ accountId: acct[code], [side]: amount })) },
    });
    expect(created.status).toBe(201);
    const posted = await call('/api/journal-entries', journalEntriesRoutes, `/api/journal-entries/${created.data.id}/post`, { method: 'POST', entityId });
    expect(posted.status).toBe(200);
  }

  const balanceSheet = (entityId: string) =>
    call('/api/accounting-reports', accountingReportsRoutes, '/api/accounting-reports/balance-sheet?asOf=2026-12-31&basis=accrual', { entityId });
  const row = (rows: Array<{ accountCode: string; balance: string }>, code: string) => rows.find((r) => r.accountCode === code);

  it('input VAT (a debit on a liability account) lowers the liabilities and the sheet balances', async () => {
    const id = await createNlEntity('Contra BV');
    const acct = await accountsByCode(id);
    await postEntry(id, acct, [
      ['4310', 'debit', '300'],
      ['1730', 'debit', '63'],
      ['1600', 'credit', '363'],
    ]);
    const res = await balanceSheet(id);
    expect(res.status).toBe(200);
    expect(row(res.data.liabilities, '1730')?.balance).toBe('-63.00');
    expect(row(res.data.liabilities, '1600')?.balance).toBe('363.00');
    expect(res.data).toMatchObject({ totalLiabilities: '300.00', totalEquity: '-300.00', isBalanced: true, difference: '0.00' });
  });

  it('accumulated depreciation (a credit on an asset account) lowers the assets and the sheet balances', async () => {
    const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      body: {
        name: 'Contra LLC',
        jurisdictionCode: 'US',
        entityType: 'single_member_llc',
        address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
      },
    });
    expect(created.status).toBe(201);
    const acct = await accountsByCode(created.data.id);
    const depreciation = acct['6040'] ? '6040' : Object.keys(acct).find((code) => code.startsWith('6'))!;
    await postEntry(created.data.id, acct, [
      [depreciation, 'debit', '450'],
      ['1590', 'credit', '450'],
    ]);
    const res = await balanceSheet(created.data.id);
    expect(row(res.data.assets, '1590')?.balance).toBe('-450.00');
    expect(res.data).toMatchObject({ totalAssets: '-450.00', totalEquity: '-450.00', isBalanced: true, difference: '0.00' });
  });
});

describe('TASK-1116 · credit notes', () => {
  it('a finalized credit note is applied to the open invoice it credits', async () => {
    const invoiceId = await finalizedInvoice();
    const creditNoteId = await creditNoteFor(invoiceId);
    const finalized = await invoices(`/${creditNoteId}/finalize`, { method: 'POST' });
    expect(finalized.status).toBe(200);
    expect(finalized.data.creditApplied).toMatchObject({ invoiceId, amount: 121 });

    expect(await invoiceRow(invoiceId)).toMatchObject({ balanceDue: '0.00', status: 'paid' });
    expect(await invoiceRow(creditNoteId)).toMatchObject({ balanceDue: '0.00' });
    const detail = await invoices(`/${invoiceId}`);
    expect(detail.data.creditNotes.map((n: { id: string }) => n.id)).toEqual([creditNoteId]);
  });

  it('what the invoice no longer owes stays open on the credit note, and its refund debits receivables', async () => {
    const invoiceId = await finalizedInvoice();
    const paid = await invoices(`/${invoiceId}/record-payment`, { method: 'POST', body: { amount: '100', date: '2026-07-15', paymentMethod: 'bank_transfer' } });
    expect(paid.status).toBe(201);

    const creditNoteId = await creditNoteFor(invoiceId);
    const finalized = await invoices(`/${creditNoteId}/finalize`, { method: 'POST' });
    expect(finalized.data.creditApplied).toMatchObject({ amount: 21 });
    expect(await invoiceRow(invoiceId)).toMatchObject({ balanceDue: '0.00' });
    expect(await invoiceRow(creditNoteId)).toMatchObject({ balanceDue: '100.00' });

    // Paying a credit note out is a refund: money leaves the bank, receivables go back up.
    const refund = await invoices(`/${creditNoteId}/record-payment`, { method: 'POST', body: { amount: '100', date: '2026-07-20', paymentMethod: 'bank_transfer' } });
    expect(refund.status).toBe(201);
    const lines = await entryLines(refund.data.journalEntryId);
    expect(lines.find((l) => l.code === '1300')).toMatchObject({ debit: 100, credit: 0 });
    expect(lines.filter((l) => l.code !== '1300')).toEqual([expect.objectContaining({ debit: 0, credit: 100 })]);
    const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, refund.data.paymentId));
    expect(payment.type).toBe('sent');
    expect(await invoiceRow(creditNoteId)).toMatchObject({ balanceDue: '0.00', status: 'paid' });
  });

  it('a received payment can not be allocated to a credit note, and a credit note can not be written off', async () => {
    const invoiceId = await finalizedInvoice();
    await invoices(`/${invoiceId}/record-payment`, { method: 'POST', body: { amount: '121', date: '2026-07-15', paymentMethod: 'bank_transfer' } });
    const creditNoteId = await creditNoteFor(invoiceId);
    await invoices(`/${creditNoteId}/finalize`, { method: 'POST' });
    expect(await invoiceRow(creditNoteId)).toMatchObject({ balanceDue: '121.00' });

    const received = await call('/api/payments', paymentsRoutes, '/api/payments', {
      method: 'POST',
      entityId: nl.id,
      body: { type: 'received', amount: '121', date: '2026-07-20', contactId: 'pty_customer', paymentMethod: 'bank_transfer', allocations: [{ invoiceId: creditNoteId, amount: '121' }] },
    });
    expect(received.status).toBe(400);
    expect(received.error?.message).toMatch(/credit note/i);

    const writeOff = await invoices(`/${creditNoteId}/status`, { method: 'PATCH', body: { status: 'uncollectible' } });
    expect(writeOff.status).toBe(400);
    expect(await invoiceRow(creditNoteId)).toMatchObject({ balanceDue: '121.00' });
  });

  it('an open credit note can be applied by hand to another open invoice of the customer, posting nothing', async () => {
    const paidInvoice = await finalizedInvoice();
    await invoices(`/${paidInvoice}/record-payment`, { method: 'POST', body: { amount: '121', date: '2026-07-15', paymentMethod: 'bank_transfer' } });
    const creditNoteId = await creditNoteFor(paidInvoice);
    await invoices(`/${creditNoteId}/finalize`, { method: 'POST' });
    const openInvoice = await finalizedInvoice('2026-07-12');

    const entriesBefore = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entityId, nl.id));
    const applied = await invoices(`/${creditNoteId}/apply-credit`, { method: 'POST', body: { invoiceId: openInvoice, amount: '50' } });
    expect(applied.status).toBe(200);
    expect(applied.data).toMatchObject({ invoiceId: openInvoice, amount: '50.00' });
    expect(await invoiceRow(openInvoice)).toMatchObject({ balanceDue: '71.00', status: 'partial' });
    expect(await invoiceRow(creditNoteId)).toMatchObject({ balanceDue: '71.00' });
    const entriesAfter = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entityId, nl.id));
    expect(entriesAfter.length).toBe(entriesBefore.length);

    const tooMuch = await invoices(`/${creditNoteId}/apply-credit`, { method: 'POST', body: { invoiceId: openInvoice, amount: '80' } });
    expect(tooMuch.status).toBe(400);
  });

  it('two applications at once never settle more than is open on either document', async () => {
    const paidInvoice = await finalizedInvoice();
    await invoices(`/${paidInvoice}/record-payment`, { method: 'POST', body: { amount: '121', date: '2026-07-15', paymentMethod: 'bank_transfer' } });
    const creditNoteId = await creditNoteFor(paidInvoice);
    await invoices(`/${creditNoteId}/finalize`, { method: 'POST' });
    const openInvoice = await finalizedInvoice('2026-07-12');

    // Each fits on its own (80 of 121), together they don't: both read the old balances, one must lose.
    const results = await Promise.all([
      invoices(`/${creditNoteId}/apply-credit`, { method: 'POST', body: { invoiceId: openInvoice, amount: '80' } }),
      invoices(`/${creditNoteId}/apply-credit`, { method: 'POST', body: { invoiceId: openInvoice, amount: '80' } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await invoiceRow(creditNoteId)).toMatchObject({ amountPaid: '80.00', balanceDue: '41.00' });
    expect(await invoiceRow(openInvoice)).toMatchObject({ amountPaid: '80.00', balanceDue: '41.00' });
  });

  it("a draft's PDF carries a draft banner, a finalized one doesn't", async () => {
    const draft = await invoices('', {
      method: 'POST',
      body: { contactId: 'pty_customer', issueDate: '2026-07-10', dueDate: '2026-07-24', items: [{ description: 'Work', quantity: '1', unitPrice: '50' }] },
    });
    const draftPdf = await invoices(`/${draft.data.id}/pdf`);
    expect(draftPdf.text).toContain('data-draft-notice');
    expect(draftPdf.text).toContain('Concept: geen geldige factuur');

    const finalPdf = await invoices(`/${await finalizedInvoice()}/pdf`);
    expect(finalPdf.text).not.toContain('data-draft-notice');
  });
});

describe('payments still settle invoices and bills the usual way', () => {
  it('a sent payment allocated to a standard invoice is refused', async () => {
    const invoiceId = await finalizedInvoice();
    const res = await call('/api/payments', paymentsRoutes, '/api/payments', {
      method: 'POST',
      entityId: nl.id,
      body: { type: 'sent', amount: '10', date: '2026-07-20', contactId: 'pty_customer', paymentMethod: 'bank_transfer', allocations: [{ invoiceId, amount: '10' }] },
    });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(schema.invoices).where(and(eq(schema.invoices.id, invoiceId)));
    expect(row.balanceDue).toBe('121.00');
  });
});
