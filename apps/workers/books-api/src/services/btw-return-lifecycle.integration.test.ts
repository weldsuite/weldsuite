/**
 * BTW-aangifte and Opgaaf ICP lifecycle on a Dutch entity (pglite): calculating
 * a period again updates the open return instead of duplicating it, unfiled
 * returns can be deleted, reversed periods are refused, EU goods and services
 * are reported as such on the ICP, and entities seeded before the "ICL goederen"
 * rate pick it up.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { buildComplianceNotices } from '@weldsuite/books-domain/accounting-compliance';
import { accountingEntitiesRoutes } from '../routes/accounting-entities';
import { invoicesRoutes } from '../routes/invoices';
import { vatReturnsRoutes } from '../routes/vat-returns';
import { icpDeclarationsRoutes } from '../routes/icp-declarations';
import { taxRatesRoutes } from '../routes/tax-rates';

let db: Database;
let entityId: string;
const rateId: Record<string, string> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, method = 'GET', body?: unknown) {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(entityId ? { 'X-Accounting-Entity-Id': entityId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = res.headers.get('content-type')?.includes('json');
  const json = res.status === 204 || !isJson ? null : ((await res.json()) as { data?: unknown; error?: { message: string } });
  return { status: res.status, data: json?.data as Record<string, unknown>, error: json?.error, raw: res };
}

async function finalizedInvoice(contactId: string, rate: string, net: string, issueDate = '2026-02-10') {
  const created = await call('/api/invoices', invoicesRoutes, '/api/invoices', 'POST', {
    contactId,
    issueDate,
    dueDate: '2026-03-10',
    items: [{ description: 'Item', quantity: '1', unitPrice: net, taxRateId: rate }],
  });
  expect(created.status).toBe(201);
  const id = created.data.id as string;
  const res = await call('/api/invoices', invoicesRoutes, `/api/invoices/${id}/finalize`, 'POST');
  expect(res.status).toBe(200);
  return id;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'Aangifte BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
    address: { line1: 'Keizersgracht 1', city: 'Amsterdam', postalCode: '1015 AA', country: 'NL' },
    contact: { phone: '+31201234567' },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id as string;

  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  const byName = (name: string) => rates.find((r) => r.name === name)!.id;
  rateId.hoog = byName('BTW Hoog 21%');
  rateId.laag = byName('BTW Laag 9%');
  rateId.nul = byName('BTW Nul 0%');
  rateId.iclGoods = byName('BTW ICL goederen');
  rateId.euServices = byName('BTW Intracommunautair diensten');

  await db.insert(schema.companies).values({ id: 'cmp_de', name: 'Kunde GmbH', displayName: 'Kunde GmbH', vatNumber: 'DE123456789' });
  await db.insert(schema.parties).values([
    { id: 'pty_nl', displayName: 'Klant BV', role: 'customer', billingAddress: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB', country: 'NL' } },
    { id: 'pty_de', displayName: 'Kunde GmbH', role: 'customer', companyId: 'cmp_de', billingAddress: { line1: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', country: 'DE' } },
  ]);
  // The buyer's VAT number is VIES-valid: finalize must not depend on the live service.
  await db.insert(schema.viesChecks).values({
    id: 'vies_de', vatNumber: 'DE123456789', countryCode: 'DE', valid: true, checkedAt: new Date(),
  });
}, 60_000);

describe('BTW-aangifte boxes', () => {
  it('puts hoog in 1a, laag in 1b and domestic 0% in 1e, and totals 5a to 5g', async () => {
    await finalizedInvoice('pty_nl', rateId.hoog, '1000');
    await finalizedInvoice('pty_nl', rateId.laag, '500');
    await finalizedInvoice('pty_nl', rateId.nul, '250');

    const res = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', {
      periodType: 'quarterly',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
    });
    expect(res.status).toBe(201);
    expect(res.data.rubrieken).toMatchObject({
      r1a: 1000, r1aBtw: 210,
      r1b: 500, r1bBtw: 45,
      r1c: 0, r1cBtw: 0,
      r1e: 250,
      r5a: 255, r5b: 0, r5c: 255, r5g: 255,
    });
  });
});

describe('recalculating, deleting and period checks', () => {
  const period = { periodType: 'quarterly', periodStart: '2026-04-01', periodEnd: '2026-06-30' };

  it('recalculating the same period updates the open return instead of adding a second one', async () => {
    const first = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', period);
    expect(first.status).toBe(201);
    await finalizedInvoice('pty_nl', rateId.hoog, '100', '2026-05-05');
    const again = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', period);
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(first.data.id);
    expect(again.data.recalculated).toBe(true);
    expect(again.data.rubrieken).toMatchObject({ r1a: 100, r1aBtw: 21 });

    const list = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns');
    const forPeriod = (list.data as unknown as Array<{ id: string; periodStart: string }>).filter((r) => r.periodStart.startsWith('2026-04-01'));
    expect(forPeriod).toHaveLength(1);
  });

  it('keeps the manual estimate boxes when recalculating and recomputes 5g', async () => {
    const list = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns');
    const target = (list.data as unknown as Array<{ id: string; periodStart: string }>).find((r) => r.periodStart.startsWith('2026-04-01'))!;
    const patched = await call('/api/vat-returns', vatReturnsRoutes, `/api/vat-returns/${target.id}`, 'PATCH', { rubrieken: { r5f: 10 } });
    expect(patched.status).toBe(200);
    expect(patched.data.rubrieken).toMatchObject({ r5c: 21, r5f: 10, r5g: 31 });
    const again = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', period);
    expect(again.data.rubrieken).toMatchObject({ r5f: 10, r5g: 31 });
  });

  it('deletes an unfiled return, and refuses to delete or recalculate a filed one', async () => {
    const list = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns');
    const target = (list.data as unknown as Array<{ id: string; periodStart: string }>).find((r) => r.periodStart.startsWith('2026-04-01'))!;

    await db.update(schema.vatReturns).set({ status: 'filed' }).where(eq(schema.vatReturns.id, target.id));
    expect((await call('/api/vat-returns', vatReturnsRoutes, `/api/vat-returns/${target.id}`, 'DELETE')).status).toBe(400);
    const blocked = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', period);
    expect(blocked.status).toBe(400);

    await db.update(schema.vatReturns).set({ status: 'calculated' }).where(eq(schema.vatReturns.id, target.id));
    expect((await call('/api/vat-returns', vatReturnsRoutes, `/api/vat-returns/${target.id}`, 'DELETE')).status).toBe(204);
    const rows = await db.select().from(schema.vatReturns).where(and(eq(schema.vatReturns.id, target.id), isNull(schema.vatReturns.deletedAt)));
    expect(rows).toHaveLength(0);

    // Calculating again after the delete gives a fresh return.
    const fresh = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', period);
    expect(fresh.status).toBe(201);
    expect(fresh.data.id).not.toBe(target.id);
  });

  it('rejects a period that ends before it starts', async () => {
    const vat = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', {
      periodType: 'monthly',
      periodStart: '2026-06-30',
      periodEnd: '2026-06-01',
    });
    expect(vat.status).toBe(400);
    const icp = await call('/api/icp-declarations', icpDeclarationsRoutes, '/api/icp-declarations/calculate', 'POST', {
      periodType: 'monthly',
      periodStart: '2026-06-30',
      periodEnd: '2026-06-01',
    });
    expect(icp.status).toBe(400);
  });
});

describe('ICP: goods and services', () => {
  it('reports intracommunautaire leveringen as goods and EU services as services', async () => {
    await finalizedInvoice('pty_de', rateId.iclGoods, '1000', '2026-08-05');
    await finalizedInvoice('pty_de', rateId.euServices, '500', '2026-08-06');

    const period = { periodType: 'quarterly', periodStart: '2026-07-01', periodEnd: '2026-09-30' };
    const res = await call('/api/icp-declarations', icpDeclarationsRoutes, '/api/icp-declarations/calculate', 'POST', period);
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ totalAmount: 1500, lineCount: 2 });

    const detail = await call('/api/icp-declarations', icpDeclarationsRoutes, `/api/icp-declarations/${res.data.id}`);
    const lines = (detail.data.lines as Array<{ vatNumber: string; supplyType: string; amount: string }>)
      .map((l) => ({ vatNumber: l.vatNumber, supplyType: l.supplyType, amount: Number(l.amount) }))
      .sort((a, b) => a.supplyType.localeCompare(b.supplyType));
    expect(lines).toEqual([
      { vatNumber: 'DE123456789', supplyType: 'goods', amount: 1000 },
      { vatNumber: 'DE123456789', supplyType: 'services', amount: 500 },
    ]);

    const xml = await (await call('/api/icp-declarations', icpDeclarationsRoutes, `/api/icp-declarations/${res.data.id}/xml`)).raw.text();
    expect(xml).toContain('<bd-i:SuppliesAmount contextRef="Line1" unitRef="EUR" decimals="0">1000</bd-i:SuppliesAmount>');
    expect(xml).toContain('<bd-i:ServicesAmount contextRef="Line1" unitRef="EUR" decimals="0">500</bd-i:ServicesAmount>');
    expect(xml).toContain('<bd-dim-dom:VATNumberDomain>123456789</bd-dim-dom:VATNumberDomain>');
    expect(xml).toContain('bd-rpt-icp-opgaaf-2026.xsd');

    // The BTW return reports both in 3b.
    const vat = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', period);
    expect(vat.data.rubrieken).toMatchObject({ r3b: 1500, r5a: 0 });

    // Calculating the same period again updates the declaration, a delete removes it.
    const again = await call('/api/icp-declarations', icpDeclarationsRoutes, '/api/icp-declarations/calculate', 'POST', period);
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(res.data.id);
    const list = await call('/api/icp-declarations', icpDeclarationsRoutes, '/api/icp-declarations');
    expect(list.data as unknown as unknown[]).toHaveLength(1);
    expect((await call('/api/icp-declarations', icpDeclarationsRoutes, `/api/icp-declarations/${res.data.id}`, 'DELETE')).status).toBe(204);
  });

  it('prints the art. 138 note for goods and the reverse-charge note for services', async () => {
    const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, entityId));
    const goods = buildComplianceNotices(entity, new Set(['eu_b2b_goods']));
    expect(goods.join(' ')).toContain('intracommunautaire levering');
    expect(goods.join(' ')).toContain('art. 138');
    expect(goods.join(' ')).not.toContain('196');
    const services = buildComplianceNotices(entity, new Set(['eu_b2b_service']));
    expect(services.join(' ')).toContain('art. 196');
    expect(services.join(' ')).not.toContain('intracommunautaire levering');
  });
});

describe('VIES outage during finalize', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finalizes with a warning and does not cache the outage as an invalid number', async () => {
    await db.insert(schema.companies).values({ id: 'cmp_fr', name: 'Client SARL', displayName: 'Client SARL', vatNumber: 'FR12345678901' });
    await db.insert(schema.parties).values({ id: 'pty_fr', displayName: 'Client SARL', role: 'customer', companyId: 'cmp_fr', billingAddress: { line1: 'Rue 1', city: 'Paris', postalCode: '75001', country: 'FR' } });
    // What the REST endpoint really answers when the member state is busy: HTTP 200 with valid=false.
    const outage = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ valid: false, actionSucceed: false, errorWrappers: [{ error: 'MS_MAX_CONCURRENT_REQ' }] }), { status: 200 }),
    );
    // Only VIES is stubbed: the conformance harness's own loopback calls go out as before.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('ec.europa.eu') ? outage(input, init) : realFetch(input, init),
    );

    const created = await call('/api/invoices', invoicesRoutes, '/api/invoices', 'POST', {
      contactId: 'pty_fr',
      issueDate: '2026-09-01',
      dueDate: '2026-10-01',
      items: [{ description: 'Goods', quantity: '1', unitPrice: '100', taxRateId: rateId.iclGoods }],
    });
    expect(created.status).toBe(201);
    const res = await call('/api/invoices', invoicesRoutes, `/api/invoices/${created.data.id}/finalize`, 'POST');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.data.warnings ?? [])).toContain('VIES is currently unavailable');
    // Retried once on the throttling error, then given up on (by each backend in a conformance run).
    expect(outage).toHaveBeenCalledTimes(2 * (conformanceTarget() ? 2 : 1));
    const cached = await db.select().from(schema.viesChecks).where(eq(schema.viesChecks.vatNumber, 'FR12345678901'));
    expect(cached).toHaveLength(0);
  }, 20_000);
});

describe('existing NL entities pick up the current seed rates', () => {
  it('adds ICL goederen, renames the services rate and fixes the laag box when the rates are listed', async () => {
    // Put the entity back to how it was seeded before: no goods rate, old name, old laag box, 0% verlegd.
    await db.delete(schema.taxRates).where(and(eq(schema.taxRates.entityId, entityId), eq(schema.taxRates.taxCategoryCode, 'eu_b2b_goods')));
    await db.update(schema.taxRates).set({ name: 'BTW Intracommunautair' })
      .where(and(eq(schema.taxRates.entityId, entityId), eq(schema.taxRates.name, 'BTW Intracommunautair diensten')));
    await db.update(schema.taxRates).set({ jurisdictionMetadata: { btwRubriek: '1c' } })
      .where(and(eq(schema.taxRates.entityId, entityId), eq(schema.taxRates.name, 'BTW Laag 9%')));
    await db.update(schema.taxRates).set({ rate: '0.0000' })
      .where(and(eq(schema.taxRates.entityId, entityId), eq(schema.taxRates.name, 'BTW Verlegd')));

    const list = await call('/api/tax-rates', taxRatesRoutes, '/api/tax-rates');
    expect(list.status).toBe(200);
    const rates = list.data as unknown as Array<{ name: string; rate: string; taxCategoryCode: string; jurisdictionMetadata: { btwRubriek: string } }>;
    const byName = (name: string) => rates.find((r) => r.name === name);
    expect(byName('BTW ICL goederen')).toMatchObject({ taxCategoryCode: 'eu_b2b_goods', jurisdictionMetadata: { btwRubriek: '3b' } });
    expect(byName('BTW Intracommunautair diensten')).toBeTruthy();
    expect(byName('BTW Intracommunautair')).toBeUndefined();
    expect(byName('BTW Laag 9%')?.jurisdictionMetadata).toEqual({ btwRubriek: '1b' });
    expect(Number(byName('BTW Verlegd')?.rate)).toBe(21);

    // Listing again changes nothing (no duplicate goods rate).
    const again = await call('/api/tax-rates', taxRatesRoutes, '/api/tax-rates');
    expect(again.data as unknown as unknown[]).toHaveLength(rates.length);
  });
});
