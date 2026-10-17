/**
 * Received NF-e (pglite, a fake KV, a stand-in for Focus NFe): upload an XML,
 * fetch with the incremental sync, manifest, turn into a draft bill, ignore.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ENCRYPTION_KEY, fakeKv } from '../../services/form-1099/test-fixtures';
import {
  CUSTOMER_CNPJ,
  ENTITY_CNPJ,
  createFocusStub,
  jsonResponse,
  seedBrEntity,
  type BrFixture,
} from '../../services/br-fiscal/integration-fixtures';
import { SAMPLE_KEY, SAMPLE_NFE_XML } from '../../services/br-fiscal/test-fixtures';
import { fiscalDocumentsRoutes } from '../fiscal-documents';
import { receivedFiscalDocumentsRoutes } from './index';

let db: Database;
let fx: BrFixture;
const kv = fakeKv();
const focus = createFocusStub();
const env = { DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY, WORKSPACE_CACHE: kv.kv, ENTITY_EVENTS: { send: async () => undefined } };

interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any;
}

async function call(mount: string, routes: typeof receivedFiscalDocumentsRoutes, method: string, path: string, body?: BodyInit | object, headers: Record<string, string> = {}): Promise<ApiResult> {
  const { request } = createTestApp(mount, routes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: env as any,
    context: { permissions: permissions('*'), tenantDb: db },
  });
  const isForm = body instanceof FormData;
  const res = await request(`${mount}${path}`, {
    method,
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), 'X-Accounting-Entity-Id': fx.entityId, ...headers },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { data?: unknown; error?: unknown }) : {};
  return { status: res.status, data: json.data, error: json.error };
}

const received = (method: string, path: string, body?: BodyInit | object) => call('/api/received-fiscal-documents', receivedFiscalDocumentsRoutes, method, path, body);

beforeAll(async () => {
  vi.stubGlobal('fetch', focus.fetch);
  db = (await createPgliteDb()).db;
  fx = await seedBrEntity(db, 'ent_buyer');
  // The buyer of the sample NF-e is the entity; the supplier is its issuer.
  await db.update(schema.entities).set({ taxIdentifiers: { vatNumber: CUSTOMER_CNPJ, registrationNumber: '140212370' } }).where(eq(schema.entities.id, fx.entityId));
  await db.insert(schema.companies).values({ id: 'cmp_supplier', name: 'Fornecedor & Filhos Ltda', displayName: 'Fornecedor & Filhos Ltda', vatNumber: ENTITY_CNPJ });
  await db.insert(schema.parties).values({ id: 'pty_supplier', kind: 'company', companyId: 'cmp_supplier', displayName: 'Fornecedor & Filhos Ltda', role: 'none' });
}, 180_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('upload', () => {
  it('reads an NF-e XML into a received document', async () => {
    const res = await received('POST', '/upload', { xml: SAMPLE_NFE_XML });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      accessKey: SAMPLE_KEY,
      kind: 'nfe',
      status: 'new',
      source: 'upload',
      issuerTaxId: '12345678000123',
      issuerName: 'Fornecedor & Filhos Ltda',
      number: '22',
      series: '1',
      issueDate: '2026-10-10',
      total: '317.00',
      hasXml: true,
    });
    expect(res.data).not.toHaveProperty('xml');
  });

  it('accepts the same note again without duplicating it, and also as a multipart file', async () => {
    expect((await received('POST', '/upload', { xml: SAMPLE_NFE_XML })).status).toBe(200);
    const form = new FormData();
    form.set('file', new Blob([SAMPLE_NFE_XML], { type: 'text/xml' }), 'nfe.xml');
    expect((await received('POST', '/upload', form)).status).toBe(200);
    const list = await received('GET', '');
    expect(list.data).toHaveLength(1);
  });

  it('refuses a note addressed to someone else, a file that is no NF-e and an empty body', async () => {
    const other = SAMPLE_NFE_XML.replace('<dest><CNPJ>99887766000155</CNPJ>', '<dest><CNPJ>11222333000181</CNPJ>').replace(SAMPLE_KEY, '41261012345678000123550010000000231923094167');
    const mismatch = await received('POST', '/upload', { xml: other });
    expect(mismatch.status).toBe(400);
    expect(mismatch.error.message).toMatch(/not to this entity/);
    expect((await received('POST', '/upload', { xml: '<invoice/>' })).error.message).toMatch(/not a readable NF-e/);
    expect((await received('POST', '/upload', {})).status).toBe(400);
  });
});

describe('reading', () => {
  it('lists with filters and shows the parsed items on the detail', async () => {
    const list = await received('GET', '?status=new&search=Fornecedor');
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).not.toHaveProperty('xml');
    expect((await received('GET', '?status=ignored')).data).toHaveLength(0);

    const detail = await received('GET', `/${list.data[0].id}`);
    expect(detail.data.parsed.nfe.items).toHaveLength(2);
    expect(detail.data.xml).toContain('<infNFe');
    expect((await received('GET', '/rfd_missing')).status).toBe(404);
  });
});

describe('manifestação', () => {
  it('needs a Focus token, then sends ciência and records it', async () => {
    const [doc] = await db.select().from(schema.receivedFiscalDocuments);
    expect((await received('POST', `/${doc.id}/manifest`, { type: 'ciencia' })).error.message).toMatch(/No Focus NFe token/);

    focus.on('GET', /\/v2\/hooks$/, () => jsonResponse([]));
    focus.on('POST', /\/v2\/hooks$/, () => jsonResponse({ id: 'hook1' }));
    const saved = await call('/api/fiscal-documents', fiscalDocumentsRoutes, 'PUT', '/settings', { environment: 'homologacao', token: 'tok-homolog-12345678' });
    expect(saved.status).toBe(200);

    focus.on('POST', /\/manifesto$/, () => jsonResponse({ status: 'evento_registrado', status_sefaz: '135', protocolo: '1', tipo: 'ciencia' }));
    const res = await received('POST', `/${doc.id}/manifest`, { type: 'ciencia' });
    expect(res.status).toBe(200);
    expect(res.data.manifestation).toBe('ciencia');
    expect(focus.callsTo('POST', /manifesto$/)[0]).toMatchObject({ url: `https://homologacao.focusnfe.com.br/v2/nfes_recebidas/${SAMPLE_KEY}/manifesto`, body: { tipo: 'ciencia' } });
  });

  it('asks for a reason when the operation was not carried out, and reports a refusal of the SEFAZ', async () => {
    const [doc] = await db.select().from(schema.receivedFiscalDocuments);
    expect((await received('POST', `/${doc.id}/manifest`, { type: 'nao_realizada' })).status).toBe(400);
    expect((await received('POST', `/${doc.id}/manifest`, { type: 'nao_realizada', reason: 'curto' })).status).toBe(400);
    focus.on('POST', /\/manifesto$/, () => jsonResponse({ status: 'erro', status_sefaz: '573', mensagem_sefaz: 'Rejeicao: Duplicidade de evento' }));
    const res = await received('POST', `/${doc.id}/manifest`, { type: 'confirmacao' });
    expect(res.status).toBe(400);
    expect(res.error.message).toBe('Rejeicao: Duplicidade de evento');
  });
});

describe('create bill', () => {
  it('needs the full XML, and a contact when the CNPJ matches none', async () => {
    const key = '35261099887766000155550010000000011000000012';
    await db.insert(schema.receivedFiscalDocuments).values({ id: 'rfd_summary', entityId: fx.entityId, accessKey: key, source: 'focus_nfe', status: 'new' });
    expect((await received('POST', '/rfd_summary/create-bill', {})).error.message).toMatch(/full XML of this NF-e is not available/);
  });

  it('creates a draft bill with the supplier found by CNPJ, one line per item and the freight', async () => {
    const [doc] = await db.select().from(schema.receivedFiscalDocuments).where(eq(schema.receivedFiscalDocuments.accessKey, SAMPLE_KEY));
    const res = await received('POST', `/${doc.id}/create-bill`, {});
    expect(res.status).toBe(201);
    const { bill, document } = res.data;
    expect(bill).toMatchObject({ status: 'draft', contactId: 'pty_supplier', contactName: 'Fornecedor & Filhos Ltda', currency: 'BRL', externalReference: '1/22', fiscalData: { accessKey: SAMPLE_KEY }, approvalStatus: 'pending' });
    expect(bill.dueDate).toContain('2026-11-10');
    expect(bill.items.map((i: { description: string }) => i.description)).toEqual(['Parafuso sextavado', 'Porca <M8>', 'Frete']);
    expect(bill.items[0]).toMatchObject({ ncm: '73181500', cfop: '2102', quantity: '10', unitPrice: '25', discountPercent: '4.00', fiscalData: { origin: '0', icmsRate: 12, ipiRate: 5 } });
    // 240 + 50 + freight 15 + 12 IPI on top: what the NF-e says.
    expect(bill.total).toBe('317.00');
    expect(bill.internalNotes).toBeNull();
    expect(document).toMatchObject({ status: 'imported', billId: bill.id });

    // The supplier's ICMS (12%) is booked as a credit by the BR engine from the line's rate; the Simples line has none.
    // (The engine's base for it adds the IPI, so its amount is not asserted against the NF-e's own vICMS.)
    const icms = bill.taxBreakdown.find((r: { component?: string }) => r.component === 'icms');
    expect(icms).toMatchObject({ taxRate: 12 });

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, 'pty_supplier'));
    expect(party.role).toBe('supplier');
    const [row] = await db.select().from(schema.bills).where(eq(schema.bills.id, bill.id));
    expect(row.status).toBe('draft');
  });

  it('refuses to import the same note twice', async () => {
    const [doc] = await db.select().from(schema.receivedFiscalDocuments).where(eq(schema.receivedFiscalDocuments.accessKey, SAMPLE_KEY));
    const res = await received('POST', `/${doc.id}/create-bill`, {});
    expect(res.status).toBe(409);
    expect((await received('POST', `/${doc.id}/ignore`)).status).toBe(409);
  });

  it('asks for the contact when the issuer is not one yet', async () => {
    await db.delete(schema.parties).where(eq(schema.parties.id, 'pty_supplier'));
    const other = SAMPLE_NFE_XML.replace(SAMPLE_KEY, '41261012345678000123550010000000241923094168');
    const upload = await received('POST', '/upload', { xml: other });
    const res = await received('POST', `/${upload.data.id}/create-bill`, {});
    expect(res.status).toBe(400);
    expect(res.error.message).toMatch(/No contact has the CNPJ 12345678000123/);
    const bad = await received('POST', `/${upload.data.id}/create-bill`, { contactId: 'pty_none' });
    expect(bad.status).toBe(404);
  });
});

describe('ignore', () => {
  it('marks a note as not needed', async () => {
    const res = await received('POST', '/rfd_summary/ignore');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ignored');
  });
});

describe('sync', () => {
  it('fetches what Focus has received since the last sync, keeping the high-water mark', async () => {
    const key = '35261011222333000181550010000000091000000093';
    focus.on('GET', /\/v2\/nfes_recebidas\?cnpj=99887766000155$/, () =>
      jsonResponse(
        [{ chave_nfe: key, nome_emitente: 'Outro Fornecedor SA', documento_emitente: '11222333000181', valor_total: '88.50', data_emissao: '2026-10-12T10:00:00-03:00', situacao: 'autorizada', manifestacao_destinatario: null, nfe_completa: false, tipo_nfe: '1', versao: 5 }],
        200,
        { 'X-Total-Count': '1', 'X-Max-Version': '5' },
      ),
    );
    const first = await received('POST', '/sync');
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ fetched: 1, created: 1, updated: 0, xmlFetched: 0, hasMore: false, version: 5 });

    const [row] = await db.select().from(schema.receivedFiscalDocuments).where(eq(schema.receivedFiscalDocuments.accessKey, key));
    expect(row).toMatchObject({ status: 'new', source: 'focus_nfe', issuerName: 'Outro Fornecedor SA', issuerTaxId: '11222333000181', total: '88.50', issueDate: '2026-10-12', number: '9', series: '1', manifestation: null });

    // The next sync asks from the stored version; a changed note (full XML now there) updates the row and downloads the XML.
    focus.on('GET', /\/v2\/nfes_recebidas\?cnpj=99887766000155&versao=5$/, () =>
      jsonResponse([{ chave_nfe: key, nome_emitente: 'Outro Fornecedor SA', documento_emitente: '11222333000181', valor_total: '88.50', data_emissao: '2026-10-12T10:00:00-03:00', manifestacao_destinatario: 'ciencia', nfe_completa: true, versao: 6 }], 200, { 'X-Total-Count': '1', 'X-Max-Version': '6' }),
    );
    focus.on('GET', new RegExp(`/v2/nfes_recebidas/${key}\\.xml$`), () => new Response('not an nfe', { status: 200 }));
    const second = await received('POST', '/sync');
    expect(second.data).toMatchObject({ fetched: 1, created: 0, updated: 1, xmlFetched: 1, version: 6 });
    const [updated] = await db.select().from(schema.receivedFiscalDocuments).where(eq(schema.receivedFiscalDocuments.accessKey, key));
    expect(updated.manifestation).toBe('ciencia');
    // A file that is not readable keeps the raw text and says why instead of failing the sync.
    expect(updated.xml).toBe('not an nfe');
    expect((updated.parsed as { parseError?: string }).parseError).toBeTruthy();

    const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, fx.entityId));
    expect(entity.jurisdictionSettings).toMatchObject({ receivedNfeVersion: 6, receivedNfeVersionEnv: 'homologacao' });
  });
});
