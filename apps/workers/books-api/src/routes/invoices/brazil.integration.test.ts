/**
 * WeldBooks Brazil.
 *
 * A Lucro Presumido entity in São Paulo invoices a service to a company: ISS,
 * PIS and COFINS are inside the price (revenue deductions against their
 * payables), CBS/IBS of the 2026 test year are on the invoice and the tax
 * ledger only, and the customer's withholdings (IRRF, CSRF) lower what it owes
 * and become receivables. A Simples Nacional entity itemises no tax and books
 * its DAS from the monthly worksheet. Bills post supplier withholdings as
 * payables and creditable ICMS out of the cost.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { invoicesRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { accountingContactsRoutes } from '../accounting-contacts';
import { billsRoutes } from '../bills';
import { brTaxRoutes } from '../br-tax';

let db: Database;

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { message: string };
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; entityId: string }): Promise<Result> {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': opts.entityId },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  let json: { data?: unknown; error?: { message: string } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // HTML / file
  }
  return { status: res.status, data: json.data, error: json.error, text };
}

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  const byCode: Record<string, number> = {};
  for (const r of rows) byCode[r.code] = Math.round(((byCode[r.code] ?? 0) + Number(r.debit) - Number(r.credit)) * 100) / 100;
  return byCode;
}

async function createEntity(name: string, regime: string, vatNumber: string) {
  const res = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    entityId: 'none',
    body: {
      name,
      legalName: `${name} Ltda`,
      jurisdictionCode: 'BR',
      entityType: 'ltda',
      taxClassification: regime,
      vatNumber,
      address: { line1: 'Av. Paulista, 1000', city: 'São Paulo', state: 'SP', postalCode: '01310100', country: 'BR' },
      jurisdictionSettings: { municipalityCode: '3550308', municipalityName: 'São Paulo', issRate: 5, pixKey: '11222333000181' },
    },
  });
  expect(res.status, res.text).toBe(201);
  return res.data;
}

async function createContact(entityId: string, name: string, vatNumber: string, role = 'customer') {
  const res = await call('/api/accounting-contacts', accountingContactsRoutes, '/api/accounting-contacts', {
    method: 'POST',
    entityId,
    body: {
      fullName: name,
      companyName: name,
      vatNumber,
      role,
      billingAddress: { line1: 'Rua A, 1', city: 'São Paulo', state: 'SP', postalCode: '01000-000', country: 'BR' },
    },
  });
  expect(res.status, res.text).toBe(201);
  return res.data;
}

async function rateNamed(entityId: string, name: string) {
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  const rate = rates.find((r) => r.name === name);
  expect(rate, name).toBeTruthy();
  return rate!;
}

let presumido: { id: string; timezone: string; locale: string; baseCurrency: string; jurisdictionSettings: Record<string, unknown> };
let customer: { id: string; vatNumber: string };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  presumido = await createEntity('Weld Brasil', 'lucro_presumido', '11.222.333/0001-81');
  customer = await createContact(presumido.id, 'Cliente SA', '12ABC34501DE35');
}, 60_000);

describe('Brazilian entity setup', () => {
  it('defaults to BRL, pt-BR and the São Paulo time zone, with the state taken from the address', () => {
    expect(presumido).toMatchObject({ baseCurrency: 'BRL', locale: 'pt-BR', timezone: 'America/Sao_Paulo' });
    expect(presumido.jurisdictionSettings).toMatchObject({ uf: 'SP', municipalityCode: '3550308', pixCity: 'São Paulo' });
  });

  it('switches on the profiles of its regime only', async () => {
    expect((await rateNamed(presumido.id, 'Serviço — ISS 5% + PIS/COFINS')).isActive).toBe(true);
    expect((await rateNamed(presumido.id, 'Simples Nacional — Serviços (Anexo III)')).isActive).toBe(false);
  });

  it('refuses a CNPJ with wrong check digits and a regime the legal form cannot have', async () => {
    const bad = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      entityId: 'none',
      body: { name: 'Errada', jurisdictionCode: 'BR', vatNumber: '11.222.333/0001-82' },
    });
    expect(bad.status).toBe(400);
    expect(bad.error?.message).toMatch(/check digits/);
    const sa = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      entityId: 'none',
      body: { name: 'SA', jurisdictionCode: 'BR', entityType: 'sa', taxClassification: 'simples_nacional' },
    });
    expect(sa.status).toBe(400);
  });

  it('stores the alphanumeric CNPJ of a customer with its mask, and a CPF on the person', async () => {
    expect(customer.vatNumber).toBe('12.ABC.345/01DE-35');
    const person = await call('/api/accounting-contacts', accountingContactsRoutes, '/api/accounting-contacts', {
      method: 'POST',
      entityId: presumido.id,
      body: { fullName: 'Maria Silva', firstName: 'Maria', lastName: 'Silva', vatNumber: '52998224725' },
    });
    expect(person.status, person.text).toBe(201);
    expect(person.data.brFiscal).toEqual({ taxId: '529.982.247-25' });
    expect(person.data.vatNumber).toBeNull();
  });
});

describe('a Lucro Presumido service invoice', () => {
  let invoiceId: string;

  it('keeps ISS/PIS/COFINS inside the price and takes withholdings off the total', async () => {
    const rate = await rateNamed(presumido.id, 'Serviço — ISS 5% + PIS/COFINS');
    const created = await call('/api/invoices', invoicesRoutes, '/api/invoices', {
      method: 'POST',
      entityId: presumido.id,
      body: {
        contactId: customer.id,
        issueDate: '2026-10-05',
        dueDate: '2026-10-19',
        fiscalData: { withholdings: { irrf: 1.5, csrf: true } },
        items: [{ description: 'Consultoria', quantity: '1', unitPrice: '10000', taxRateId: rate.id, fiscalData: { serviceCode: '17.01' } }],
      },
    });
    expect(created.status, created.text).toBe(201);
    invoiceId = created.data.id;
    // 10.000 - IRRF 150 - PIS 65 - COFINS 300 - CSLL 100 = 9.385
    expect(created.data).toMatchObject({ subtotal: '10000.00', taxTotal: '-615.00', total: '9385.00' });
    const components = (created.data.taxBreakdown as Array<{ component: string; treatment: string; taxAmount: number }>).map((r) => [r.component, r.treatment, r.taxAmount]);
    expect(components).toEqual(
      expect.arrayContaining([
        ['iss', 'embedded', 500],
        ['pis', 'embedded', 65],
        ['cofins', 'embedded', 300],
        ['cbs', 'informational', 82.22],
        ['ibs', 'informational', 9.14],
        ['irrf', 'withheld', 150],
        ['csll_ret', 'withheld', 100],
      ]),
    );
  });

  it('posts revenue gross, the deductions against the payables and the withholdings as receivables', async () => {
    const finalized = await call('/api/invoices', invoicesRoutes, `/api/invoices/${invoiceId}/finalize`, { method: 'POST', entityId: presumido.id });
    expect(finalized.status, finalized.text).toBe(200);
    const lines = await entryLines(finalized.data.journalEntryId);
    expect(lines).toEqual({
      '1.1.2.01': 9385, // Clientes
      '1.1.4.05': 150, // IRRF a compensar
      '1.1.4.06': 65, // PIS retido
      '1.1.4.07': 300, // COFINS retida
      '1.1.4.08': 100, // CSLL retida
      '2.1.3.03': -65, // PIS a recolher
      '2.1.3.04': -300, // COFINS a recolher
      '2.1.3.05': -500, // ISS a recolher
      '3.1.1.02': -10000, // Receita de serviços
      '3.1.2.02': 65,
      '3.1.2.03': 300,
      '3.1.2.04': 500,
    });
    const taxLines = await db.select().from(schema.taxLines).where(eq(schema.taxLines.sourceId, invoiceId));
    expect(taxLines.map((t) => t.component).sort()).toEqual(['cbs', 'cofins', 'cofins_ret', 'csll_ret', 'ibs', 'irrf', 'iss', 'pis', 'pis_ret']);
  });

  it('prints the groups of taxes, the notice and the Pix code', async () => {
    const pdf = await call('/api/invoices', invoicesRoutes, `/api/invoices/${invoiceId}/pdf`, { entityId: presumido.id });
    expect(pdf.status).toBe(200);
    expect(pdf.text).toContain('Retenções');
    expect(pdf.text).toContain('Tributos incluídos no preço');
    expect(pdf.text).toContain('não substitui a nota fiscal');
    expect(pdf.text).toContain('br.gov.bcb.pix');
  });

  it('works out the month: ISS and PIS/COFINS net of what the customer withheld', async () => {
    const res = await call('/api/br-tax', brTaxRoutes, '/api/br-tax/apuracao?period=2026-10', { entityId: presumido.id });
    expect(res.status, res.text).toBe(200);
    const byCode = Object.fromEntries((res.data.taxes as Array<{ code: string; payable: number }>).map((t) => [t.code, t.payable]));
    expect(byCode).toMatchObject({ iss: 500, pis: 0, cofins: 0 });
    expect(res.data.withheldByCustomers).toMatchObject({ irrf: 150, pis: 65, cofins: 300, csll: 100 });
    expect(res.data.informational).toEqual({ cbs: 82.22, ibs: 9.14 });
    expect(res.data.status).toBe('open');
  });
});

describe('a Simples Nacional entity', () => {
  it('itemises no tax and books the DAS of the month', async () => {
    const simples = await createEntity('Weld Simples', 'simples_nacional', '11.444.777/0001-61');
    const client = await createContact(simples.id, 'Cliente Simples', '11222333000181');
    const rate = await rateNamed(simples.id, 'Simples Nacional — Serviços (Anexo III)');
    const created = await call('/api/invoices', invoicesRoutes, '/api/invoices', {
      method: 'POST',
      entityId: simples.id,
      body: {
        contactId: client.id,
        issueDate: '2026-09-10',
        dueDate: '2026-09-30',
        items: [{ description: 'Desenvolvimento', quantity: '1', unitPrice: '20000', taxRateId: rate.id }],
      },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.data).toMatchObject({ taxTotal: '0.00', total: '20000.00' });
    const finalized = await call('/api/invoices', invoicesRoutes, `/api/invoices/${created.data.id}/finalize`, { method: 'POST', entityId: simples.id });
    expect(finalized.status, finalized.text).toBe(200);

    const worksheet = await call('/api/br-tax', brTaxRoutes, '/api/br-tax/apuracao?period=2026-09', { entityId: simples.id });
    expect(worksheet.status, worksheet.text).toBe(200);
    // First month: RBT12 = 20.000 x 12 = 240.000, Anexo III faixa 2: (240.000 x 11,2% - 9.360) / 240.000 = 7,3%
    expect(worksheet.data.simples).toMatchObject({ rbt12: 240000, total: 1460 });

    const booked = await call('/api/br-tax', brTaxRoutes, '/api/br-tax/apuracao/book', { method: 'POST', entityId: simples.id, body: { period: '2026-09' } });
    expect(booked.status, booked.text).toBe(201);
    expect(await entryLines(booked.data.journalEntryId)).toEqual({ '2.1.3.06': -1460, '3.1.2.05': 1460 });
    const again = await call('/api/br-tax', brTaxRoutes, '/api/br-tax/apuracao/book', { method: 'POST', entityId: simples.id, body: { period: '2026-09' } });
    expect(again.status).toBe(400);
    const pdf = await call('/api/invoices', invoicesRoutes, `/api/invoices/${created.data.id}/pdf`, { entityId: simples.id });
    expect(pdf.text).toContain('optante pelo Simples Nacional');
  });
});

describe('a bill with withholdings and creditable ICMS', () => {
  it('posts the withholdings as payables and takes the ICMS credit out of the cost', async () => {
    const real = await createEntity('Weld Real', 'lucro_real', '11.444.777/0001-61');
    const supplier = await createContact(real.id, 'Fornecedor', '11222333000181', 'supplier');
    const purchase = await rateNamed(real.id, 'Compra de mercadoria para revenda — com créditos');
    const service = await rateNamed(real.id, 'Serviço tomado — com crédito de PIS/COFINS');
    const created = await call('/api/bills', billsRoutes, '/api/bills', {
      method: 'POST',
      entityId: real.id,
      body: {
        contactId: supplier.id,
        issueDate: '2026-10-02',
        dueDate: '2026-10-30',
        fiscalData: { withholdings: { irrf: 1.5 } },
        items: [
          { description: 'Mercadorias', quantity: '1', unitPrice: '1000', taxRateId: purchase.id },
          { description: 'Serviço de limpeza', quantity: '1', unitPrice: '2000', taxRateId: service.id },
        ],
      },
    });
    expect(created.status, created.text).toBe(201);
    // IRRF 1,5% on the 2.000 of services is kept back: the supplier is owed 2.970.
    expect(created.data.total).toBe('2970.00');
    const rows = (created.data.taxBreakdown as Array<{ component: string; taxAmount: number }>).map((r) => [r.component, r.taxAmount]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['icms', 180],
        ['pis', 13.53],
        ['cofins', 62.32],
        ['pis', 33],
        ['cofins', 152],
        ['irrf', 30],
      ]),
    );

    const approved = await call('/api/bills', billsRoutes, `/api/bills/${created.data.id}/approve`, { method: 'PATCH', entityId: real.id });
    expect(approved.status, approved.text).toBe(200);
    const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.id, created.data.id));
    expect(bill.journalEntryId).toBeTruthy();
    const lines = await entryLines(bill.journalEntryId!);
    expect(lines['2.1.1.01']).toBe(-2970); // Fornecedores
    expect(lines['2.1.4.01']).toBe(-30); // IRRF retido a recolher
    expect(lines['1.1.4.01']).toBe(180); // ICMS a recuperar
    expect(lines['1.1.4.03']).toBe(46.53); // PIS a recuperar
    expect(lines['1.1.4.04']).toBe(214.32); // COFINS a recuperar
    // The cost is net of the credits: 3.000 - 180 - 46,53 - 214,32
    const cost = Object.entries(lines).filter(([code]) => code.startsWith('4.')).reduce((sum, [, v]) => sum + v, 0);
    expect(Math.round(cost * 100) / 100).toBe(2559.15);
  });
});
