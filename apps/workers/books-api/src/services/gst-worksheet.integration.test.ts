/**
 * India's GST worksheet (GSTR-1 tables and the GSTR-3B summary) of a period,
 * from the tax ledger and the invoices behind it (pglite). The ledger and the
 * invoices are written directly, so the worksheet doesn't depend on the
 * invoice flow.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../routes/accounting-entities';
import { vatReturnsRoutes } from '../routes/vat-returns';

let db: Database;
let entityId = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, entity: string, method = 'GET', body?: unknown) {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': entity },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { data?: Record<string, unknown>; error?: { message: string } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: json.data as any, error: json.error };
}

const worksheet = (query: string, entity = entityId) =>
  call('/api/vat-returns', vatReturnsRoutes, `/api/vat-returns/gst-worksheet${query}`, entity);

let seq = 0;
async function invoice(
  id: string,
  args: { type?: string; contactName: string; gstin?: string | null; placeOfSupply: string | null; total: number; creditOf?: string },
  items: Array<{ hsnSac: string | null; quantity: number; lineTotal: number; taxAmount: number; rate: number }>,
) {
  await db.insert(schema.invoices).values({
    id,
    entityId,
    invoiceNumber: `INV-${id}`,
    type: args.type ?? 'standard',
    status: 'finalized',
    contactId: `pty_${id}`,
    contactName: args.contactName,
    contactTaxNumber: args.gstin ?? null,
    placeOfSupply: args.placeOfSupply,
    issueDate: new Date('2026-07-10T12:00:00Z'),
    dueDate: new Date('2026-08-10T12:00:00Z'),
    currency: 'INR',
    subtotal: args.total.toFixed(2),
    total: args.total.toFixed(2),
    balanceDue: args.total.toFixed(2),
    creditNoteForInvoiceId: args.creditOf,
  });
  for (const item of items) {
    seq += 1;
    await db.insert(schema.invoiceItems).values({
      id: `${id}_l${seq}`,
      entityId,
      invoiceId: id,
      description: 'Item',
      quantity: String(item.quantity),
      unitPrice: (item.lineTotal / item.quantity).toFixed(2),
      unit: 'NOS',
      hsnSac: item.hsnSac,
      lineTotal: item.lineTotal.toFixed(2),
      taxAmount: item.taxAmount.toFixed(2),
      taxRate: String(item.rate),
      sortOrder: seq,
    });
  }
}

async function ledger(
  sourceType: string,
  sourceId: string | null,
  direction: string,
  component: string | null,
  rate: number,
  base: number,
  tax: number,
  extra: { category?: string; selfAssessed?: boolean } = {},
) {
  seq += 1;
  await db.insert(schema.taxLines).values({
    id: `txl_in_${seq}`,
    entityId,
    sourceType,
    sourceId,
    journalEntryId: `je_in_${seq}`,
    taxDate: '2026-07-10',
    direction,
    component,
    rate: String(rate),
    taxCategoryCode: extra.category ?? 'standard',
    selfAssessed: extra.selfAssessed ?? false,
    taxableAmount: base.toFixed(2),
    taxAmount: tax.toFixed(2),
    currency: 'INR',
    baseTaxableAmount: base.toFixed(2),
    baseTaxAmount: tax.toFixed(2),
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'none', 'POST', {
    name: 'Bharat Traders',
    jurisdictionCode: 'IN',
    vatNumber: '27AAPFU0939F1ZV',
    address: { line1: '1 MG Road', city: 'Mumbai', postalCode: '400001', country: 'IN' },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id;

  // An intra-state B2B sale (CGST + SGST), an inter-state B2B sale (IGST), a large
  // inter-state B2C sale, a small B2C sale, an export, a nil-rated sale and a credit note.
  await invoice('b2b1', { contactName: 'Pune Retail', gstin: '27AABCU9603R1ZM', placeOfSupply: '27', total: 1180 }, [{ hsnSac: '8471', quantity: 2, lineTotal: 1000, taxAmount: 180, rate: 18 }]);
  await ledger('invoice', 'b2b1', 'sales', 'cgst', 9, 1000, 90);
  await ledger('invoice', 'b2b1', 'sales', 'sgst', 9, 1000, 90);
  await invoice('b2b2', { contactName: 'Delhi Mart', gstin: '07AAACR5055K1Z5', placeOfSupply: '07', total: 590 }, [{ hsnSac: '8471', quantity: 1, lineTotal: 500, taxAmount: 90, rate: 18 }]);
  await ledger('invoice', 'b2b2', 'sales', 'igst', 18, 500, 90);
  await invoice('b2cl', { contactName: 'Walk-in Bengaluru', placeOfSupply: '29', total: 354_000 }, [{ hsnSac: '9403', quantity: 10, lineTotal: 300_000, taxAmount: 54_000, rate: 18 }]);
  await ledger('invoice', 'b2cl', 'sales', 'igst', 18, 300_000, 54_000);
  await invoice('b2cs', { contactName: 'Walk-in Mumbai', placeOfSupply: '27', total: 112 }, [{ hsnSac: null, quantity: 1, lineTotal: 100, taxAmount: 12, rate: 12 }]);
  await ledger('invoice', 'b2cs', 'sales', 'cgst', 6, 100, 6);
  await ledger('invoice', 'b2cs', 'sales', 'sgst', 6, 100, 6);
  await invoice('exp1', { contactName: 'London Ltd', placeOfSupply: '96', total: 2000 }, [{ hsnSac: '8471', quantity: 1, lineTotal: 2000, taxAmount: 0, rate: 0 }]);
  await ledger('invoice', 'exp1', 'sales', 'export', 0, 2000, 0, { category: 'export_goods' });
  await invoice('nil1', { contactName: 'Pune Retail', gstin: '27AABCU9603R1ZM', placeOfSupply: '27', total: 300 }, [{ hsnSac: '0401', quantity: 3, lineTotal: 300, taxAmount: 0, rate: 0 }]);
  await ledger('invoice', 'nil1', 'sales', null, 0, 300, 0, { category: 'zero' });
  await invoice('cn1', { type: 'credit_note', contactName: 'Pune Retail', gstin: '27AABCU9603R1ZM', placeOfSupply: '27', total: 118, creditOf: 'b2b1' }, [{ hsnSac: '8471', quantity: 1, lineTotal: 100, taxAmount: 18, rate: 18 }]);
  await ledger('credit_note', 'cn1', 'sales', 'cgst', 9, -100, -9);
  await ledger('credit_note', 'cn1', 'sales', 'sgst', 9, -100, -9);
  // A journal with tax, a slab booked without a split, input tax credit and reverse charge.
  await ledger('journal', null, 'sales', 'igst', 18, 50, 9);
  await ledger('invoice', 'b2b1', 'sales', null, 18, 0, 5);
  await ledger('bill', 'bil_1', 'purchase', 'cgst', 9, 2000, 180);
  await ledger('bill', 'bil_1', 'purchase', 'sgst', 9, 2000, 180);
  await ledger('bill', 'bil_2', 'purchase', 'igst', 18, 1000, 180);
  await ledger('bill', 'bil_3', 'purchase', 'igst', 18, 500, 90, { selfAssessed: true, category: 'reverse_charge' });
}, 60_000);

describe('GST worksheet', () => {
  it('needs both dates, in order', async () => {
    expect((await worksheet('')).error?.message).toBe('periodStart and periodEnd are required as YYYY-MM-DD dates');
    expect((await worksheet('?periodStart=2026-07-01&periodEnd=2026-7-31')).status).toBe(400);
    expect((await worksheet('?periodStart=2026-07-31&periodEnd=2026-07-01')).error?.message).toBe('periodStart must not be after periodEnd');
  });

  it('refuses an entity without a GST return', async () => {
    await db.insert(schema.entities).values({ id: 'ent_nl', name: 'Bedrijf', jurisdictionCode: 'NL' });
    const res = await worksheet('?periodStart=2026-07-01&periodEnd=2026-07-31', 'ent_nl');
    expect(res.error?.message).toBe("This entity's jurisdiction has no GST return.");
  });

  it('builds GSTR-1 and GSTR-3B of the month', async () => {
    const res = await worksheet('?periodStart=2026-07-01&periodEnd=2026-07-31');
    expect(res.status).toBe(200);
    const { gstr1, gstr3b } = res.data;
    expect(res.data.entityStateCode).toBe('27');
    expect(gstr1.b2b.map((p: { gstin: string }) => p.gstin)).toEqual(['07AAACR5055K1Z5', '27AABCU9603R1ZM']);
    expect(gstr1.b2cLarge).toHaveLength(1);
    expect(gstr1.b2cSmall[0]).toMatchObject({ placeOfSupply: '27', slabRate: 12, taxable: 100, cgst: 6, sgst: 6 });
    expect(gstr1.exports[0]).toMatchObject({ number: 'INV-exp1', value: 2000, taxable: 2000 });
    expect(gstr1.nilExempt[0]).toMatchObject({ category: 'nil_rated', intraRegistered: 300 });
    expect(gstr1.creditNotes[0]).toMatchObject({ originalNumber: 'INV-b2b1', taxable: -100 });
    expect(gstr1.hsn.length).toBeGreaterThan(2);
    expect(gstr3b.itc.reverseCharge).toMatchObject({ igst: 90 });
    expect(gstr3b.interStateUnregistered[0]).toMatchObject({ placeOfSupply: '29', igst: 54_000 });
    expect(res.data.unsplitTax).toBe(5);
    expect(res.data.warnings.map((w: { code: string }) => w.code)).toEqual(['unsplit_tax', 'missing_hsn', 'tax_on_other_documents']);
  });

  it('is empty for a month without supplies', async () => {
    const res = await worksheet('?periodStart=2026-01-01&periodEnd=2026-01-31');
    expect(res.data).toMatchObject({ unsplitTax: 0, warnings: [], gstr3b: { payment: { totalNetPayable: 0 } } });
  });
});
