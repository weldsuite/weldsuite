/**
 * TASK-1112 / TASK-1114: India GST.
 *
 * An India entity (GSTIN 27..., Maharashtra) invoices a Mumbai customer
 * (GSTIN 27...) and a Bengaluru customer (GSTIN 29...) at "GST 18%". The
 * invoices store the CGST + SGST / IGST components, the journal credits the
 * output CGST / SGST / IGST accounts instead of GST payable, the tax invoice
 * prints the buyer's GSTIN, the place of supply and the HSN/SAC, and the GST
 * worksheet (GSTR-1 / GSTR-3B summary) reads it all back from the tax ledger.
 * A finalize needs the entity's address and a buyer name.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { invoicesRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { accountingContactsRoutes } from '../accounting-contacts';
import { billsRoutes } from '../bills';
import { vatReturnsRoutes } from '../vat-returns';

let db: Database;
let entityId: string;
let rate18: string;
let rate5: string;
let mumbai: string;
let bengaluru: string;
let supplierKarnataka: string;
let accountByCode: Record<string, string>;

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
    headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': opts.entityId ?? entityId },
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
  call('/api/invoices', invoicesRoutes, `/api/invoices${path}`, opts);
const contacts = (path: string, opts: { method?: string; body?: unknown } = {}) =>
  call('/api/accounting-contacts', accountingContactsRoutes, `/api/accounting-contacts${path}`, opts);

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

async function createInvoice(contactId: string, extra: Record<string, unknown> = {}, line: Record<string, unknown> = {}) {
  return invoices('', {
    method: 'POST',
    body: {
      contactId,
      issueDate: '2026-10-05',
      dueDate: '2026-10-19',
      items: [{ description: 'Consulting', quantity: '1', unitPrice: '1000', taxRateId: rate18, hsnSac: '998313', ...line }],
      ...extra,
    },
  });
}

async function createCustomer(name: string, vatNumber: string, state: string) {
  const res = await contacts('', {
    method: 'POST',
    body: {
      fullName: name,
      companyName: name,
      vatNumber,
      role: 'customer',
      billingAddress: { line1: '1 Main Road', city: 'City', state, postalCode: '400001', country: 'IN' },
    },
  });
  expect(res.status, res.text).toBe(201);
  return res.data.id as string;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    entityId: 'none',
    body: {
      name: 'Weld India Pvt Ltd',
      jurisdictionCode: 'IN',
      vatNumber: '27AABCU9603R1ZN',
      taxIdentifiers: { registrationNumber: 'AABCU9603R' },
      address: { line1: '12 Linking Road', city: 'Mumbai', state: 'Maharashtra', postalCode: '400050', country: 'IN' },
    },
  });
  expect(created.status, created.text).toBe(201);
  entityId = created.data.id as string;

  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  rate18 = rates.find((r) => r.name === 'GST 18%')!.id;
  rate5 = rates.find((r) => r.name === 'GST 5%')!.id;
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  accountByCode = Object.fromEntries(accounts.map((a) => [a.code, a.id]));

  mumbai = await createCustomer('Mumbai Traders', '27AAPFU0939F1ZV', 'Maharashtra');
  bengaluru = await createCustomer('Bengaluru Tech', '29AABCU9603R1ZJ', 'Karnataka');
  const supplier = await contacts('', {
    method: 'POST',
    body: { fullName: 'Karnataka Supplies', companyName: 'Karnataka Supplies', vatNumber: '29AABCU9603R1ZJ', role: 'supplier' },
  });
  supplierKarnataka = supplier.data.id as string;
}, 60_000);

describe('GSTIN and PAN validation on entities and contacts', () => {
  it('refuses a GSTIN whose check digit is wrong, on an entity and on a contact', async () => {
    const entity = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      entityId: 'none',
      body: { name: 'Bad GSTIN', jurisdictionCode: 'IN', vatNumber: '27AABCU9603R1ZX' },
    });
    expect(entity.status).toBe(400);
    expect(entity.error?.message).toMatch(/check digit/i);

    const contact = await contacts('', {
      method: 'POST',
      body: { fullName: 'Wrong GSTIN Ltd', companyName: 'Wrong GSTIN Ltd', vatNumber: '27AABCU9603R1ZX', billingAddress: { country: 'IN' } },
    });
    expect(contact.status).toBe(400);
    expect(contact.error?.message).toMatch(/check digit/i);
  });

  it('refuses a GSTIN whose PAN is not the entity PAN, and accepts a matching one', async () => {
    const mismatch = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      entityId: 'none',
      body: { name: 'PAN mismatch', jurisdictionCode: 'IN', vatNumber: '27AAPFU0939F1ZV', taxIdentifiers: { registrationNumber: 'AABCU9603R' } },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.error?.message).toMatch(/PAN/);
  });

  it('does not block an unrelated edit of an entity saved with a GSTIN from before the check digit existed', async () => {
    const legacy = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      entityId: 'none',
      body: { name: 'Legacy IN', jurisdictionCode: 'IN', vatNumber: '27AAPFU0939F1ZV' },
    });
    expect(legacy.status).toBe(201);
    // Stored by an older version: right shape, wrong check digit.
    await db.update(schema.entities).set({ taxIdentifiers: { vatNumber: '27AABCU9603R1ZM' } }).where(eq(schema.entities.id, legacy.data.id));
    const patched = await call('/api/accounting-entities', accountingEntitiesRoutes, `/api/accounting-entities/${legacy.data.id}`, {
      method: 'PATCH',
      body: { address: { line1: '1 Road', city: 'Pune', state: 'Maharashtra', country: 'IN' } },
    });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.data.jurisdictionSettings?.stateCode).toBe('27');
  });
});

describe('the seeded rate table', () => {
  it('has 5, 18, 40, 3 and 0.25 percent active and 12 and 28 percent switched off', async () => {
    const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
    const active = (name: string) => rates.find((r) => r.name === name)?.isActive;
    expect(active('GST 18%')).toBe(true);
    expect(active('GST 5%')).toBe(true);
    expect(active('GST 40%')).toBe(true);
    expect(active('GST 3% (gold, silver)')).toBe(true);
    expect(active('GST 0.25% (rough diamonds)')).toBe(true);
    expect(active('GST 12% (legacy)')).toBe(false);
    expect(active('GST 28% (legacy)')).toBe(false);
  });
});

describe('CGST + SGST versus IGST', () => {
  it('splits an intra-state invoice into CGST and SGST and posts them to the output accounts', async () => {
    const created = await createInvoice(mumbai);
    expect(created.status, created.text).toBe(201);
    expect(created.data.placeOfSupply).toBe('27');
    expect(created.data.taxBreakdown.map((r: { component: string; taxAmount: number; accountRole: string }) => [r.component, r.taxAmount, r.accountRole])).toEqual([
      ['cgst', 90, 'tax_output_cgst'],
      ['sgst', 90, 'tax_output_sgst'],
    ]);
    expect(created.data.taxTotal).toBe('180.00');
    expect(created.data.items[0].hsnSac).toBe('998313');

    const finalized = await invoices(`/${created.data.id}/finalize`, { method: 'POST' });
    expect(finalized.status, finalized.text).toBe(200);
    const lines = await entryLines(finalized.data.journalEntryId);
    expect(lines).toEqual([
      { code: '1300', debit: 1180, credit: 0 },
      { code: '1710', debit: 0, credit: 90 },
      { code: '1720', debit: 0, credit: 90 },
      { code: '8000', debit: 0, credit: 1000 },
    ]);

    const taxRows = await db.select().from(schema.taxLines).where(eq(schema.taxLines.sourceId, created.data.id));
    expect(taxRows.map((r) => r.component).sort()).toEqual(['cgst', 'sgst']);

    // The buyer's GSTIN and the place of supply are kept with the finalized invoice.
    const [stored] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, created.data.id));
    expect(stored.contactTaxNumber).toBe('27AAPFU0939F1ZV');
    expect(stored.placeOfSupply).toBe('27');
  });

  it('charges IGST on an inter-state invoice and posts it to the output IGST account', async () => {
    const created = await createInvoice(bengaluru);
    expect(created.status, created.text).toBe(201);
    expect(created.data.placeOfSupply).toBe('29');
    expect(created.data.taxBreakdown).toHaveLength(1);
    expect(created.data.taxBreakdown[0]).toMatchObject({ component: 'igst', taxRate: 18, taxAmount: 180, accountRole: 'tax_output_igst' });

    const finalized = await invoices(`/${created.data.id}/finalize`, { method: 'POST' });
    expect(finalized.status, finalized.text).toBe(200);
    const lines = await entryLines(finalized.data.journalEntryId);
    expect(lines.find((l) => l.code === '1730')).toMatchObject({ credit: 180 });
    expect(lines.find((l) => l.code === '1700')).toBeUndefined();
  });

  it('uses the place of supply the user chose over the buyer GSTIN state', async () => {
    const created = await createInvoice(mumbai, { placeOfSupply: '29' });
    expect(created.status, created.text).toBe(201);
    expect(created.data.placeOfSupply).toBe('29');
    expect(created.data.taxBreakdown[0].component).toBe('igst');

    // Changing it on the draft re-splits the tax.
    const patched = await invoices(`/${created.data.id}`, { method: 'PATCH', body: { placeOfSupply: '27' } });
    expect(patched.status, patched.text).toBe(200);
    const [stored] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, created.data.id));
    expect(stored.placeOfSupply).toBe('27');
    expect(stored.taxBreakdown?.map((r) => r.component)).toEqual(['cgst', 'sgst']);
  });

  it('zero-rates an invoice whose place of supply is outside India', async () => {
    const export_ = await db.select().from(schema.taxRates).where(and(eq(schema.taxRates.entityId, entityId), eq(schema.taxRates.taxCategoryCode, 'export_goods')));
    const created = await createInvoice(mumbai, { placeOfSupply: '96' }, { taxRateId: export_[0].id });
    expect(created.status, created.text).toBe(201);
    expect(created.data.taxTotal).toBe('0.00');
    expect(created.data.placeOfSupply).toBe('96');
  });

  it('derives the place of supply from the address state when the buyer has no GSTIN', async () => {
    const consumer = await contacts('', {
      method: 'POST',
      body: { fullName: 'Retail Customer', role: 'customer', billingAddress: { line1: '5 MG Road', city: 'Bengaluru', state: 'Karnataka', country: 'IN' } },
    });
    const created = await createInvoice(consumer.data.id as string);
    expect(created.status, created.text).toBe(201);
    expect(created.data.placeOfSupply).toBe('29');
    expect(created.data.taxBreakdown[0].component).toBe('igst');
  });

  it('refuses to finalize GST at a slab rate when no place of supply is known', async () => {
    const unknown = await contacts('', { method: 'POST', body: { fullName: 'Unlocated Customer', role: 'customer' } });
    const created = await createInvoice(unknown.data.id as string);
    expect(created.status, created.text).toBe(201);
    expect(created.data.placeOfSupply).toBeNull();
    // Fail closed: the slab rate, no split.
    expect(created.data.taxBreakdown[0].component).toBeUndefined();
    const finalized = await invoices(`/${created.data.id}/finalize`, { method: 'POST' });
    expect(finalized.status).toBe(400);
    expect(finalized.error?.message).toMatch(/place of supply/i);

    // Choosing it fixes the invoice.
    const patched = await invoices(`/${created.data.id}`, { method: 'PATCH', body: { placeOfSupply: '27' } });
    expect(patched.status, patched.text).toBe(200);
    const again = await invoices(`/${created.data.id}/finalize`, { method: 'POST' });
    expect(again.status, again.text).toBe(200);
  });
});

describe('the tax invoice', () => {
  it('prints the buyer GSTIN, place of supply, HSN/SAC and the CGST/SGST columns', async () => {
    const created = await createInvoice(mumbai);
    const finalized = await invoices(`/${created.data.id}/finalize`, { method: 'POST' });
    expect(finalized.status, finalized.text).toBe(200);
    const pdf = await invoices(`/${created.data.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.text).toContain('Tax Invoice');
    expect(pdf.text).toContain('Mumbai Traders');
    expect(pdf.text).toContain('27AAPFU0939F1ZV');
    expect(pdf.text).toContain('Place of supply');
    expect(pdf.text).toContain('Maharashtra (27)');
    expect(pdf.text).toContain('998313');
    expect(pdf.text).toContain('CGST');
    expect(pdf.text).toContain('SGST');
    expect(pdf.text).not.toContain('IGST');
    // supplier address and identifiers
    expect(pdf.text).toContain('12 Linking Road');
    expect(pdf.text).toContain('27AABCU9603R1ZN');
    expect(pdf.text).toContain('AABCU9603R');
  });

  it('prints IGST columns for an inter-state invoice', async () => {
    const created = await createInvoice(bengaluru);
    const pdf = await invoices(`/${created.data.id}/pdf`);
    expect(pdf.text).toContain('IGST');
    expect(pdf.text).toContain('Karnataka (29)');
  });
});

describe('finalize needs the entity address and a buyer name', () => {
  it('refuses an entity without an address and says where to add it', async () => {
    const noAddress = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      entityId: 'none',
      body: { name: 'No Address Pvt Ltd', jurisdictionCode: 'IN', vatNumber: '27AAPFU0939F1ZV', taxIdentifiers: { registrationNumber: 'AAPFU0939F' } },
    });
    expect(noAddress.status, noAddress.text).toBe(201);
    const id = noAddress.data.id as string;
    const created = await invoices('', {
      method: 'POST',
      entityId: id,
      body: { contactId: mumbai, issueDate: '2026-10-05', dueDate: '2026-10-19', items: [{ description: 'Work', quantity: '1', unitPrice: '100' }] },
    });
    expect(created.status, created.text).toBe(201);
    const finalized = await invoices(`/${created.data.id}/finalize`, { method: 'POST', entityId: id });
    expect(finalized.status).toBe(400);
    expect(finalized.error?.message).toMatch(/business address/);
    expect(finalized.error?.message).toMatch(/Entities/);
    // Clients that translate the message get the missing fields as codes next to it.
    expect(JSON.parse(finalized.text).error.details).toEqual({
      code: 'ENTITY_INVOICE_FIELDS_MISSING',
      missingFields: ['address'],
    });

    // Filling it in lets the invoice through.
    const patched = await call('/api/accounting-entities', accountingEntitiesRoutes, `/api/accounting-entities/${id}`, {
      method: 'PATCH',
      body: { address: { line1: '9 Park Street', city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'IN' } },
    });
    expect(patched.status, patched.text).toBe(200);
    const again = await invoices(`/${created.data.id}/finalize`, { method: 'POST', entityId: id });
    expect(again.status, again.text).toBe(200);
  });

  it('refuses an invoice with no buyer name', async () => {
    const created = await createInvoice(mumbai);
    // Stored without the customer's name, and the contact has none either.
    await db.update(schema.invoices).set({ contactName: null }).where(eq(schema.invoices.id, created.data.id));
    await db.update(schema.parties).set({ displayName: '' }).where(eq(schema.parties.id, mumbai));
    const finalized = await invoices(`/${created.data.id}/finalize`, { method: 'POST' });
    await db.update(schema.parties).set({ displayName: 'Mumbai Traders' }).where(eq(schema.parties.id, mumbai));
    expect(finalized.status).toBe(400);
    expect(finalized.error?.message).toMatch(/customer name/i);
  });
});

describe('bills split the same way', () => {
  it('posts input IGST for a supplier in another state', async () => {
    const bill = await call('/api/bills', billsRoutes, '/api/bills', {
      method: 'POST',
      body: {
        contactId: supplierKarnataka,
        issueDate: '2026-10-06',
        dueDate: '2026-10-20',
        items: [{ description: 'Software', quantity: '1', unitPrice: '2000', taxRateId: rate18 }],
      },
    });
    expect(bill.status, bill.text).toBe(201);
    const [stored] = await db.select().from(schema.bills).where(eq(schema.bills.id, bill.data.id));
    expect(stored.taxBreakdown?.map((r) => [r.component, r.accountRole])).toEqual([['igst', 'tax_input_igst']]);
    expect(stored.taxTotal).toBe('360.00');
  });
});

describe('GST worksheet (GSTR-1 and GSTR-3B summary)', () => {
  it('summarises the period from the tax ledger', async () => {
    const res = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/gst-worksheet?periodStart=2026-10-01&periodEnd=2026-10-31');
    expect(res.status, res.text).toBe(200);
    const sheet = res.data;
    expect(sheet.entityStateCode).toBe('27');
    expect(sheet.gstr1.b2b.map((p: { gstin: string }) => p.gstin)).toEqual(['27AAPFU0939F1ZV', '29AABCU9603R1ZJ']);
    const mumbaiParty = sheet.gstr1.b2b[0];
    expect(mumbaiParty.cgst).toBeGreaterThan(0);
    expect(mumbaiParty.igst).toBe(0);
    const bengaluruParty = sheet.gstr1.b2b[1];
    expect(bengaluruParty.igst).toBe(180);
    expect(bengaluruParty.cgst).toBe(0);
    // SAC 998313 is on every invoice line that was finalized
    expect(sheet.gstr1.hsn.find((r: { hsnSac: string }) => r.hsnSac === '998313')).toBeDefined();
    expect(sheet.gstr3b.outwardTaxable.taxableValue).toBeGreaterThan(0);
    expect(sheet.gstr3b.payment.liability.igst).toBeGreaterThanOrEqual(180);
    expect(sheet.unsplitTax).toBe(0);
  });

  it('refuses a missing period and an entity without a GST return', async () => {
    const missing = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/gst-worksheet');
    expect(missing.status).toBe(400);
    const nl = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      entityId: 'none',
      body: { name: 'NL BV', jurisdictionCode: 'NL', vatNumber: 'NL123456789B01', taxIdentifiers: { registrationNumber: '12345678' } },
    });
    const refused = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/gst-worksheet?periodStart=2026-10-01&periodEnd=2026-10-31', { entityId: nl.data.id });
    expect(refused.status).toBe(400);
  });
});

describe('a credit note keeps the split of its invoice', () => {
  it('reverses CGST and SGST on the same accounts', async () => {
    const created = await createInvoice(mumbai, {}, { taxRateId: rate5 });
    const finalized = await invoices(`/${created.data.id}/finalize`, { method: 'POST' });
    expect(finalized.status, finalized.text).toBe(200);
    const credit = await invoices(`/${created.data.id}/credit-note`, { method: 'POST' });
    expect(credit.status, credit.text).toBe(201);
    const creditFinalized = await invoices(`/${credit.data.id}/finalize`, { method: 'POST' });
    expect(creditFinalized.status, creditFinalized.text).toBe(200);
    const lines = await entryLines(creditFinalized.data.journalEntryId);
    expect(lines.find((l) => l.code === '1710')).toMatchObject({ debit: 25 });
    expect(lines.find((l) => l.code === '1720')).toMatchObject({ debit: 25 });
    expect(accountByCode['1710']).toBeDefined();
  });
});
