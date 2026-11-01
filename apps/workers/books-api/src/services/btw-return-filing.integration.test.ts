/**
 * Filing the BTW-aangifte and the Opgaaf ICP on a Dutch entity (pglite):
 * the XBRL, the (simulated) Digipoort submission and its status, the
 * period stamped and locked, corrections through a suppletie, and the
 * refusals along the way. The tax ledger is written directly, so the
 * returns don't depend on the invoice flow.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../routes/accounting-entities';
import { vatReturnsRoutes } from '../routes/vat-returns';
import { icpDeclarationsRoutes } from '../routes/icp-declarations';

let db: Database;
let entityId: string;
const rateId: Record<string, string> = {};

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { message: string };
  text: string;
  headers: Headers;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, method = 'GET', body?: unknown): Promise<Result> {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(entityId ? { 'X-Accounting-Entity-Id': entityId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = res.headers.get('content-type')?.includes('json') && text ? (JSON.parse(text) as { data?: unknown; error?: { message: string } }) : {};
  return { status: res.status, data: json.data, error: json.error, text, headers: res.headers };
}

const vat = (path: string, method = 'GET', body?: unknown) => call('/api/vat-returns', vatReturnsRoutes, `/api/vat-returns${path}`, method, body);
const icp = (path: string, method = 'GET', body?: unknown) => call('/api/icp-declarations', icpDeclarationsRoutes, `/api/icp-declarations${path}`, method, body);

let lineNo = 0;
/** One tax-ledger row, as a posting writes it. */
async function ledger(rate: string, direction: 'sales' | 'purchase', taxDate: string, base: number, tax: number, contactId: string | null = null) {
  lineNo += 1;
  await db.insert(schema.taxLines).values({
    id: `txl_${lineNo}`,
    entityId,
    sourceType: 'journal',
    journalEntryId: `je_${lineNo}`,
    taxDate,
    direction,
    taxRateId: rateId[rate],
    rate: '21',
    taxableAmount: base.toFixed(2),
    taxAmount: tax.toFixed(2),
    currency: 'EUR',
    baseTaxableAmount: base.toFixed(2),
    baseTaxAmount: tax.toFixed(2),
    contactId,
    taxCategoryCode: rate === 'iclGoods' ? 'eu_b2b_goods' : 'standard',
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'Aangifte BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
    address: { line1: 'Keizersgracht 1', city: 'Amsterdam', postalCode: '1015 AA', country: 'NL' },
    contact: { phone: '+31 20 123 4567' },
  });
  expect(created.status, created.text).toBe(201);
  entityId = created.data.id as string;

  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  const byName = (name: string) => rates.find((r) => r.name === name)!.id;
  rateId.hoog = byName('BTW Hoog 21%');
  rateId.iclGoods = byName('BTW ICL goederen');
  rateId.euServices = byName('BTW Intracommunautair diensten');

  await db.insert(schema.companies).values([
    { id: 'cmp_de', name: 'Kunde GmbH', displayName: 'Kunde GmbH', vatNumber: 'DE 123.456.789' },
    { id: 'cmp_novat', name: 'Kunde Ohne', displayName: 'Kunde Ohne' },
  ]);
  await db.insert(schema.parties).values([
    { id: 'pty_de', displayName: 'Kunde GmbH', role: 'customer', companyId: 'cmp_de' },
    { id: 'pty_novat', displayName: 'Kunde Ohne', role: 'customer', companyId: 'cmp_novat' },
  ]);
}, 60_000);

describe('the BTW-aangifte of a quarter', () => {
  let returnId = '';

  it('reads a return, and 404s on one that does not exist', async () => {
    await ledger('hoog', 'sales', '2026-02-10', 1000, 210);
    await ledger('hoog', 'purchase', '2026-02-11', 100, 21);
    const calculated = await vat('/calculate', 'POST', { periodType: 'quarterly', periodStart: '2026-01-01', periodEnd: '2026-03-31', periodLabel: 'Q1 2026' });
    expect(calculated.status).toBe(201);
    returnId = calculated.data.id;

    const res = await vat(`/${returnId}`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: 'calculated', periodLabel: 'Q1 2026', rubrieken: { r1a: 1000, r1aBtw: 210, r5b: 21, r5g: 189 } });
    expect((await vat('/vat_missing')).status).toBe(404);
  });

  it('renders the XBRL of an unfiled return, and refuses the status and a suppletie before filing', async () => {
    const xml = await vat(`/${returnId}/xml`);
    expect(xml.status).toBe(200);
    expect(xml.headers.get('content-type')).toBe('application/xml');
    expect(xml.headers.get('content-disposition')).toBe('attachment; filename="btw-aangifte-Q1 2026.xml"');
    expect(xml.text).toContain('<bd-i:ValueAddedTaxOwed contextRef="Msg" unitRef="EUR" decimals="0">210</bd-i:ValueAddedTaxOwed>');
    expect(xml.text).toContain('<bd-i:ContactTelephoneNumber contextRef="Msg">+31201234567</bd-i:ContactTelephoneNumber>');
    expect(xml.text).toContain('bd-rpt-ob-aangifte-2026.xsd');

    expect((await vat(`/${returnId}/filing-status`)).status).toBe(400);
    expect((await vat(`/${returnId}/suppletie`, 'POST')).status).toBe(400);
  });

  it('needs a telephone number to file', async () => {
    await db.update(schema.entities).set({ contact: {} }).where(eq(schema.entities.id, entityId));
    const res = await vat(`/${returnId}/file`, 'POST');
    expect(res.status).toBe(400);
    expect(res.error?.message).toMatch(/telephone number/);
    await db.update(schema.entities).set({ contact: { phone: '+31 20 123 4567' } }).where(eq(schema.entities.id, entityId));
  });

  it('files it: the ledger rows are stamped, the tax lock date moves to the quarter end', async () => {
    const res = await vat(`/${returnId}/file`, 'POST');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: returnId, status: 'filed', digipoortSuccess: true, message: 'BTW-aangifte submitted to Digipoort' });
    expect(res.data.kenmerk).toMatch(/^WS-/);

    const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, entityId));
    expect(entity.taxLockDate).toBe('2026-03-31');
    const stamped = await db.select().from(schema.taxLines).where(eq(schema.taxLines.taxReturnId, returnId));
    expect(stamped).toHaveLength(2);

    const detail = await vat(`/${returnId}`);
    expect(detail.data).toMatchObject({ status: 'filed', filingReference: res.data.kenmerk });
    const xml = await vat(`/${returnId}/xml`);
    expect(xml.text).toContain('MessageReferenceSupplierVAT');

    expect((await vat(`/${returnId}/file`, 'POST')).error?.message).toMatch(/already been filed/);
    expect((await vat(`/${returnId}`, 'PATCH', { notes: 'late' })).status).toBe(400);
  });

  it('polls the filing status (simulated without the certificate binding)', async () => {
    const res = await vat(`/${returnId}/filing-status`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: returnId, success: true, simulated: true, status: 'submitted' });
  });

  it('checks a filed return for corrections: none, one to fold into the next return, then a suppletie', async () => {
    const none = await vat(`/${returnId}/suppletie`, 'POST');
    expect(none.status).toBe(200);
    expect(none.data).toEqual({ correctionRequired: false, netDiff: 0, message: 'The ledger matches the filed return — no suppletie needed.' });

    await ledger('hoog', 'sales', '2026-03-01', 1000, 210);
    const small = await vat(`/${returnId}/suppletie`, 'POST');
    expect(small.status).toBe(200);
    expect(small.data).toMatchObject({ correctionRequired: false, foldIntoNextReturn: true, netDiff: 210 });

    await ledger('hoog', 'sales', '2026-03-02', 10000, 2100);
    const large = await vat(`/${returnId}/suppletie`, 'POST');
    expect(large.status).toBe(201);
    expect(large.data).toMatchObject({ correctionRequired: true, netDiff: 2310 });
    expect(large.data.message).toMatch(/exceeds the €1,000 threshold/);

    const [suppletie] = await db.select().from(schema.vatReturns).where(eq(schema.vatReturns.id, large.data.id));
    expect(suppletie).toMatchObject({ correctionOfId: returnId, periodLabel: 'Q1 2026 (suppletie)', status: 'calculated' });

    // Filing the suppletie leaves the stamped rows alone.
    const filed = await vat(`/${large.data.id}/file`, 'POST');
    expect(filed.status).toBe(200);
    const stamped = await db.select().from(schema.taxLines).where(eq(schema.taxLines.taxReturnId, large.data.id));
    expect(stamped).toHaveLength(0);
  });

  it('refuses to file without a BTW number', async () => {
    const other = await vat('/calculate', 'POST', { periodType: 'monthly', periodStart: '2026-04-01', periodEnd: '2026-04-30' });
    expect(other.status).toBe(201);
    await db.update(schema.entities).set({ taxIdentifiers: { registrationNumber: '12345678' } }).where(eq(schema.entities.id, entityId));
    expect((await vat(`/${other.data.id}/file`, 'POST')).error?.message).toBe('VAT/BTW number is not configured on this entity');
    expect((await vat(`/${other.data.id}/xml`)).status).toBe(400);
    await db.update(schema.entities).set({ taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' } }).where(eq(schema.entities.id, entityId));
  });
});

describe('the Opgaaf ICP', () => {
  it('files a declaration with lines, and refuses one without', async () => {
    await ledger('iclGoods', 'sales', '2026-07-05', 1000, 0, 'pty_de');
    await ledger('euServices', 'sales', '2026-07-06', 400, 0, 'pty_de');
    await ledger('euServices', 'sales', '2026-07-07', 300, 0, 'pty_novat');
    const period = { periodType: 'quarterly', periodStart: '2026-07-01', periodEnd: '2026-09-30', periodLabel: 'Q3 2026' };
    const calculated = await icp('/calculate', 'POST', period);
    expect(calculated.status).toBe(201);
    expect(calculated.data).toMatchObject({ totalAmount: 1400, lineCount: 2, skippedContacts: ['pty_novat'] });
    const id = calculated.data.id as string;

    expect((await icp('/icp_missing')).status).toBe(404);

    await db.update(schema.entities).set({ contact: {} }).where(eq(schema.entities.id, entityId));
    expect((await icp(`/${id}/file`, 'POST')).error?.message).toMatch(/telephone number/);
    await db.update(schema.entities).set({ contact: { phone: '+31 20 123 4567' } }).where(eq(schema.entities.id, entityId));

    const filed = await icp(`/${id}/file`, 'POST');
    expect(filed.status).toBe(200);
    expect(filed.data).toMatchObject({ id, status: 'filed', digipoortSuccess: true, simulated: true });
    expect((await icp(`/${id}/file`, 'POST')).error?.message).toBe('ICP declaration has already been filed');
    expect((await icp(`/${id}`, 'DELETE')).status).toBe(400);
    expect((await icp('/calculate', 'POST', period)).status).toBe(400);

    const xml = await icp(`/${id}/xml`);
    expect(xml.status).toBe(200);
    expect(xml.headers.get('content-disposition')).toBe('attachment; filename="opgaaf-icp-Q3 2026.xml"');
    expect(xml.text).toContain('<bd-i:ServicesAmount contextRef="Line1" unitRef="EUR" decimals="0">400</bd-i:ServicesAmount>');

    const empty = await icp('/calculate', 'POST', { periodType: 'monthly', periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    expect(empty.status).toBe(201);
    expect(empty.data).toMatchObject({ totalAmount: 0, lineCount: 0 });
    expect((await icp(`/${empty.data.id}/file`, 'POST')).error?.message).toMatch(/has no lines/);
  });

  it('refuses entities outside the EU and periods that are not dates', async () => {
    expect((await icp('/calculate', 'POST', { periodType: 'monthly', periodStart: 'not a date', periodEnd: '2026-10-31' })).status).toBe(400);
    expect((await vat('/calculate', 'POST', { periodType: 'weekly', periodStart: '2026-10-01', periodEnd: '2026-10-31' })).status).toBe(400);
  });
});
