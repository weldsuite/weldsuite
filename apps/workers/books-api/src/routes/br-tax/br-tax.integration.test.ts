/**
 * Brazil's tax worksheet and exports (pglite): the apuração of a Lucro
 * Presumido quarter, a Simples Nacional month and a MEI month, booking them,
 * the SPED ECD of a fiscal year, the withholdings a service sale suggests,
 * and the refusals. Invoices, the tax ledger and journal entries are written
 * directly, so the worksheets don't depend on the invoice flow.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { brTaxRoutes } from './index';

let db: Database;

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { message: string };
  text: string;
  headers: Headers;
  bytes: Uint8Array;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, entityId: string, method = 'GET', body?: unknown): Promise<Result> {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': entityId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const latin1 = res.headers.get('content-type')?.includes('ISO-8859-1');
  const text = new TextDecoder(latin1 ? 'latin1' : 'utf-8').decode(bytes);
  const json = res.headers.get('content-type')?.includes('json') && text ? (JSON.parse(text) as { data?: unknown; error?: { message: string } }) : {};
  return { status: res.status, data: json.data, error: json.error, text, headers: res.headers, bytes };
}

const br = (entityId: string, path: string, method = 'GET', body?: unknown) => call('/api/br-tax', brTaxRoutes, `/api/br-tax${path}`, entityId, method, body);

async function createEntity(name: string, entityType: string, regime: string, vatNumber: string) {
  const res = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'none', 'POST', {
    name,
    legalName: `${name} Ltda`,
    jurisdictionCode: 'BR',
    entityType,
    taxClassification: regime,
    vatNumber,
    address: { line1: 'Av. Paulista, 1000', city: 'São Paulo', state: 'SP', postalCode: '01310100', country: 'BR' },
    jurisdictionSettings: { municipalityCode: '3550308', municipalityName: 'São Paulo', issRate: 5 },
  });
  expect(res.status, res.text).toBe(201);
  return res.data.id as string;
}

async function rateOf(entityId: string, profile: string): Promise<string> {
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  const rate = rates.find((r) => (r.jurisdictionMetadata as { br?: { profile?: string } } | null)?.br?.profile === profile);
  return rate!.id;
}

async function accountId(entityId: string, code: string): Promise<string> {
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  return accounts.find((a) => a.code === code)!.id;
}

let seq = 0;
/** A finalized invoice of one service line. */
async function invoice(entityId: string, profile: string, issueDate: string, amount: number) {
  seq += 1;
  const id = `inv_br_${seq}`;
  await db.insert(schema.invoices).values({
    id,
    entityId,
    invoiceNumber: `INV-${seq}`,
    type: 'standard',
    status: 'finalized',
    contactId: 'pty_cliente',
    issueDate: new Date(`${issueDate}T12:00:00Z`),
    dueDate: new Date(`${issueDate}T12:00:00Z`),
    currency: 'BRL',
    subtotal: amount.toFixed(2),
    total: amount.toFixed(2),
    balanceDue: amount.toFixed(2),
    taxBreakdown: [],
  });
  await db.insert(schema.invoiceItems).values({
    id: `${id}_l0`,
    entityId,
    invoiceId: id,
    description: 'Consultoria',
    quantity: '1',
    unitPrice: amount.toFixed(2),
    lineTotal: amount.toFixed(2),
    taxRateId: await rateOf(entityId, profile),
    sortOrder: 0,
  });
}

/** One tax-ledger row of a sale. */
async function ledger(entityId: string, component: string, taxDate: string, base: number, tax: number, direction = 'sales') {
  seq += 1;
  await db.insert(schema.taxLines).values({
    id: `txl_br_${seq}`,
    entityId,
    sourceType: 'invoice',
    journalEntryId: `je_br_${seq}`,
    taxDate,
    direction,
    component,
    rate: '0',
    taxableAmount: base.toFixed(2),
    taxAmount: tax.toFixed(2),
    currency: 'BRL',
    baseTaxableAmount: base.toFixed(2),
    baseTaxAmount: tax.toFixed(2),
  });
}

/** A posted journal entry. */
async function entry(entityId: string, date: string, lines: Array<[string, number, number]>, description = 'Lançamento manual') {
  seq += 1;
  const id = `je_post_${seq}`;
  await db.insert(schema.journalEntries).values({ id, entityId, entryNumber: `JE-${seq}`, date: new Date(`${date}T12:00:00Z`), description, status: 'posted' });
  let n = 0;
  for (const [code, debit, credit] of lines) {
    n += 1;
    await db.insert(schema.journalLines).values({
      id: `${id}_${n}`,
      entityId,
      journalEntryId: id,
      accountId: await accountId(entityId, code),
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
    });
  }
}

let presumido = '';
let simples = '';
let mei = '';
let nl = '';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  presumido = await createEntity('Consultoria', 'ltda', 'lucro_presumido', '11.222.333/0001-81');
  simples = await createEntity('Pequena', 'ltda', 'simples_nacional', '11.444.777/0001-61');
  mei = await createEntity('Micro', 'mei', 'mei', '45.723.174/0001-10');
  await db.insert(schema.entities).values({ id: 'ent_nl', name: 'Bedrijf', jurisdictionCode: 'NL' });
  nl = 'ent_nl';
  await db.insert(schema.companies).values([
    { id: 'cmp_cliente', name: 'Cliente SA', displayName: 'Cliente SA', vatNumber: '99.887.766/0001-55' },
    { id: 'cmp_pessoa', name: 'Pessoa', displayName: 'Pessoa', vatNumber: '123.456.789-09' },
  ]);
  await db.insert(schema.parties).values([
    { id: 'pty_cliente', kind: 'company', companyId: 'cmp_cliente', displayName: 'Cliente SA', role: 'customer' },
    { id: 'pty_pessoa', kind: 'company', companyId: 'cmp_pessoa', displayName: 'Pessoa', role: 'customer' },
  ]);
}, 180_000);

describe('apuração', () => {
  it('needs a YYYY-MM period and a Brazilian entity', async () => {
    expect((await br(presumido, '/apuracao')).error?.message).toBe('Required');
    expect((await br(presumido, '/apuracao?period=2026-13')).error?.message).toBe('Use a YYYY-MM period');
    expect((await br(nl, '/apuracao?period=2026-09')).error?.message).toBe('This is only available for Brazilian entities');
    expect((await br(presumido, '/apuracao/book', 'POST', { period: '09/2026' })).status).toBe(400);
  });

  it('works out a Lucro Presumido quarter: the month taxes and IRPJ / CSLL, then books it', async () => {
    await invoice(presumido, 'servico_iss_5', '2026-08-10', 100_000);
    await ledger(presumido, 'iss', '2026-09-10', 20_000, 1000);
    await ledger(presumido, 'pis', '2026-09-10', 19_000, 123.5);
    await ledger(presumido, 'cofins', '2026-09-10', 19_000, 570);
    await ledger(presumido, 'irrf', '2026-09-10', 20_000, 300);
    await ledger(presumido, 'pis_ret', '2026-09-10', 20_000, 130);
    await ledger(presumido, 'irrf', '2026-09-12', 5000, 75, 'purchase');
    await ledger(presumido, 'iss_ret', '2026-09-12', 5000, 100, 'purchase');

    const res = await br(presumido, '/apuracao?period=2026-09');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ period: '2026-09', regime: 'lucro_presumido', status: 'open', simples: null, mei: null });
    expect(res.data.taxes.map((t: { code: string }) => t.code)).toEqual(['iss', 'pis', 'cofins']);
    expect(res.data.quarterly).toMatchObject({ quarter: 3, irpjBase: 32_000, irpj: 4800, lc224Applied: false });
    expect(res.data.withholdingsToPay.map((w: { code: string }) => w.code)).toEqual(['irrf', 'iss']);

    const booked = await br(presumido, '/apuracao/book', 'POST', { period: '2026-09' });
    expect(booked.status, booked.text).toBe(201);
    expect(booked.data.journalEntryId).toBeTruthy();

    const after = await br(presumido, '/apuracao?period=2026-09');
    expect(after.data).toMatchObject({ status: 'booked', taxReturnId: booked.data.taxReturnId, journalEntryId: booked.data.journalEntryId });
    expect((await br(presumido, '/apuracao/book', 'POST', { period: '2026-09' })).error?.message).toBe('The apuração of 2026-09 is already booked');
  });

  it('works out a Simples Nacional month and books the DAS', async () => {
    await invoice(simples, 'sn_servicos_iii', '2026-10-05', 20_000);
    const res = await br(simples, '/apuracao?period=2026-10');
    expect(res.status).toBe(200);
    expect(res.data.simples).toMatchObject({ rbt12: 240_000, overSublimit: false, dueDate: '2026-11-20' });
    expect(res.data.simples.lines[0]).toMatchObject({ anexo: 'III', faixa: 2 });
    const booked = await br(simples, '/apuracao/book', 'POST', { period: '2026-10' });
    expect(booked.status, booked.text).toBe(201);
    expect(booked.data.journalEntryId).toBeTruthy();
  });

  it('works out the DAS-MEI, and books a month without movement', async () => {
    const res = await br(mei, '/apuracao?period=2026-10');
    expect(res.data.mei).toMatchObject({ amount: 86.05, inss: 81.05, icms: 0, iss: 5 });
    const empty = await br(presumido, '/apuracao/book', 'POST', { period: '2026-07' });
    expect(empty.status).toBe(201);
    expect(empty.data.journalEntryId).toBeNull();
  });
});

describe('withholdings', () => {
  it('suggests CSRF and IRRF on a professional service to a company', async () => {
    const res = await br(presumido, '/withholdings/suggest?contactId=pty_cliente&serviceKind=professional');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ csrf: true, irrf: 1.5 });
    expect((await br(presumido, '/withholdings/suggest?contactId=pty_cliente&serviceKind=cleaning_security')).data).toEqual({ csrf: true, irrf: 1 });
    expect((await br(presumido, '/withholdings/suggest?contactId=pty_cliente')).data).toEqual({ csrf: true });
  });

  it('suggests nothing to a person or from a Simples provider, and refuses an unknown kind', async () => {
    expect((await br(presumido, '/withholdings/suggest?contactId=pty_pessoa&serviceKind=professional')).data).toEqual({});
    expect((await br(simples, '/withholdings/suggest?contactId=pty_cliente&serviceKind=professional')).data).toEqual({});
    expect((await br(presumido, '/withholdings/suggest?serviceKind=plumbing')).status).toBe(400);
    expect((await br(nl, '/withholdings/suggest')).status).toBe(400);
  });
});

describe('SPED ECD', () => {
  const contador = { name: 'Ana Contadora', taxId: '123.456.789-09', code: '900', qualification: 'Contador', crc: 'SP-123456/O', crcUf: 'SP', email: 'ana@contabil.com.br', legalRepresentative: false };
  const socio = { name: 'João Sócio', taxId: '987.654.321-00', code: '205', qualification: 'Administrador', legalRepresentative: true };

  it('builds the year’s file in ISO-8859-1, with a generated closing entry', async () => {
    await entry(presumido, '2025-11-10', [['1.1.1.01', 500, 0], ['2.3.1.01', 0, 500]], 'Capital');
    await entry(presumido, '2026-03-15', [['1.1.1.01', 1500, 0], ['3.1.1.01', 0, 1500]], 'Serviços prestados | março');
    await entry(presumido, '2026-05-20', [['4.2.1.01', 300, 0], ['1.1.1.01', 0, 300]]);

    const res = await br(presumido, '/ecd', 'POST', { year: 2026, signatories: [contador, socio] });
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=ISO-8859-1');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="ECD-11222333000181-2026.txt"');
    expect(JSON.parse(decodeURIComponent(res.headers.get('x-warnings') ?? ''))).toEqual([]);
    expect(res.text.startsWith('|0000|LECD|01012026|31122026|Consultoria Ltda|11222333000181|SP|')).toBe(true);
    expect(res.text).toContain('|I200|ENC-2026|31122026|');
    expect(res.text).toContain('Serviços prestados   março');
    // ç is one Latin-1 byte.
    expect(res.bytes).toContain(0xe7);
  });

  it('warns about missing signatories and refuses what it can not build', async () => {
    const res = await br(presumido, '/ecd', 'POST', { year: 2025, signatories: [socio] });
    expect(res.status).toBe(200);
    expect(JSON.parse(decodeURIComponent(res.headers.get('x-warnings') ?? ''))).toEqual(['The ECD must be signed by a contador (code 900): add one.']);

    expect((await br(presumido, '/ecd', 'POST', { year: 1999, signatories: [] })).status).toBe(400);
    expect((await br(presumido, '/ecd', 'POST', { year: 2026, signatories: [{ ...contador, taxId: 'x', code: '9' }] })).status).toBe(400);
    expect((await br(nl, '/ecd', 'POST', { year: 2026, signatories: [contador] })).status).toBe(400);

    const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, mei));
    await db.update(schema.entities).set({ jurisdictionSettings: { ...(entity.jurisdictionSettings as object), uf: null } }).where(eq(schema.entities.id, mei));
    expect((await br(mei, '/ecd', 'POST', { year: 2026, signatories: [contador] })).error?.message).toBe("The entity's state (UF) is missing");
  });
});
