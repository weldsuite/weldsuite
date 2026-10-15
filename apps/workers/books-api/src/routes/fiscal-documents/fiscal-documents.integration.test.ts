/**
 * Fiscal documents end to end (pglite, a fake KV, a stand-in for Focus NFe):
 * settings and webhook registration -> issue -> webhook refresh -> correction
 * -> cancel -> issue again, plus the refusals.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ENCRYPTION_KEY, fakeKv } from '../../services/form-1099/test-fixtures';
import { createFocusStub, jsonResponse, seedBrEntity, seedInvoice, type BrFixture } from '../../services/br-fiscal/integration-fixtures';
import { createPublicFiscalWebhookRoutes } from '../public-fiscal-webhooks';
import { fiscalDocumentsRoutes } from './index';
import type { Env, Variables } from '../../types';

const KEY = '41261012345678000123550010000000221923094166';
const TOKEN = 'tok-homolog-12345678';

let db: Database;
let fx: BrFixture;
const kv = fakeKv();
const focus = createFocusStub();
const sent: Array<Record<string, unknown>> = [];
const env = {
  DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  WORKSPACE_CACHE: kv.kv,
  ENTITY_EVENTS: { send: async (message: Record<string, unknown>) => void sent.push(message) },
};

interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any;
  text: string;
}

async function api(method: string, path: string, body?: unknown, perms: string[] = ['*']): Promise<ApiResult> {
  const { request } = createTestApp('/api/fiscal-documents', fiscalDocumentsRoutes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: env as any,
    context: { permissions: permissions(...perms), tenantDb: db },
  });
  const res = await request(`/api/fiscal-documents${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': fx.entityId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { data?: unknown; error?: unknown }) : {};
  return { status: res.status, data: json.data, error: json.error, text };
}

const publicApp = new Hono<{ Bindings: Env; Variables: Variables }>();
publicApp.route(
  '/public/fiscal-webhooks',
  createPublicFiscalWebhookRoutes({ openTenant: async () => ({ db, workspaceId: 'ws_test', suspended: false }), fetch: focus.fetch }),
);

async function webhook(token: string, secret: string, body: unknown) {
  return publicApp.request(
    `/public/fiscal-webhooks/${token}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: secret }, body: JSON.stringify(body) },
    env as unknown as Record<string, unknown>,
  );
}

const goods = { description: 'Produto exemplo', quantity: '2', unitPrice: '100', profile: 'venda_mercadoria', ncm: '49111090' };
const service = { description: 'Desenvolvimento de software', quantity: '1', unitPrice: '1500', profile: 'servico_iss_5', fiscalData: { serviceCode: '01.07' } };

beforeAll(async () => {
  vi.stubGlobal('fetch', focus.fetch);
  db = (await createPgliteDb()).db;
  fx = await seedBrEntity(db);
}, 180_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

/** The webhook URL token and secret of the first registration, for the webhook calls of the issuing tests. */
const hook = { token: '', secret: '' };

describe('settings', () => {
  let webhookUrl = '';
  let secret = '';

  it('refuses an entity outside Brazil', async () => {
    await db.insert(schema.entities).values({ id: 'ent_nl', name: 'Bedrijf', jurisdictionCode: 'NL' });
    const { request } = createTestApp('/api/fiscal-documents', fiscalDocumentsRoutes, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: env as any,
      context: { permissions: permissions('*'), tenantDb: db },
    });
    const res = await request('/api/fiscal-documents/settings', { headers: { 'X-Accounting-Entity-Id': 'ent_nl' } });
    expect(res.status).toBe(400);
  });

  it('starts in homologação without credentials', async () => {
    const res = await api('GET', '/settings');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ provider: 'focus_nfe', environment: 'homologacao', hasCredentials: false, nfseStandard: 'nacional', webhook: { registered: false } });
  });

  it('needs accounts:update to change settings', async () => {
    expect((await api('PUT', '/settings', { environment: 'homologacao' }, ['accounts:read'])).status).toBe(403);
  });

  it('rejects a token Focus refuses, and stores nothing', async () => {
    focus.on('GET', /\/v2\/hooks$/, () => new Response('HTTP Basic: Access denied', { status: 401 }));
    const res = await api('PUT', '/settings', { environment: 'homologacao', token: 'wrong-token-1234' });
    expect(res.status).toBe(400);
    expect(res.error.message).toMatch(/rejected this token/);
    const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, fx.entityId));
    expect(entity.fiscalCredentialsEncrypted).toBeNull();
  });

  it('seals the token, registers the hooks and never returns the token', async () => {
    focus.on('GET', /\/v2\/hooks$/, () => jsonResponse([]));
    let hookId = 0;
    focus.on('POST', /\/v2\/hooks$/, () => jsonResponse({ id: `hook${++hookId}` }));
    const res = await api('PUT', '/settings', { environment: 'homologacao', token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ environment: 'homologacao', hasCredentials: true, credentialEnvironments: ['homologacao'], webhook: { registered: true, events: ['nfe', 'nfse', 'nfsen'] } });
    expect(res.data.webhookUrl).toMatch(/^http:\/\/localhost\/public\/fiscal-webhooks\/[\w-]{43}$/);
    expect(res.text).not.toContain(TOKEN);

    const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, fx.entityId));
    expect(entity.fiscalCredentialsEncrypted).toBeTruthy();
    expect(entity.fiscalCredentialsEncrypted).not.toContain(TOKEN);
    expect(JSON.stringify(entity.jurisdictionSettings)).not.toContain(res.data.webhookUrl.split('/').pop());

    const hooks = focus.callsTo('POST', /\/v2\/hooks$/);
    expect(hooks.map((h) => h.body?.event)).toEqual(['nfe', 'nfse', 'nfsen']);
    expect(hooks[0].headers.Authorization).toBe(`Basic ${btoa(`${TOKEN}:`)}`);
    webhookUrl = res.data.webhookUrl;
    secret = String(hooks[0].body?.authorization);
    expect(hooks.every((h) => h.body?.url === webhookUrl && h.body?.authorization === secret)).toBe(true);
    expect([...kv.store.keys()].filter((k) => k.startsWith('fiscalhook:'))).toHaveLength(1);
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'fiscal_settings'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].changes)).not.toContain(TOKEN);
  });

  it('keeps the webhook URL and secret working for the webhook route', async () => {
    const token = webhookUrl.split('/').pop() as string;
    expect((await webhook('x'.repeat(43), secret, { ref: 'a' })).status).toBe(404);
    expect((await webhook(token, 'wrong-secret', { ref: 'a' })).status).toBe(401);
    // An unknown reference is acknowledged and nothing happens.
    const calls = focus.calls.length;
    const res = await webhook(token, secret, { ref: 'unknown-ref' });
    expect(res.status).toBe(200);
    expect(focus.calls).toHaveLength(calls);
    // So is a body that is not JSON.
    expect((await webhook(token, secret, 'not json')).status).toBe(200);
    // Bodies over 64 KB are refused.
    expect((await webhook(token, secret, { ref: 'a'.repeat(70_000) })).status).toBe(413);
    hook.token = token;
    hook.secret = secret;
  });
});

describe('issuing', () => {
  it('refuses a draft invoice, a mixed invoice and a credit note without an authorized NF-e', async () => {
    await seedInvoice(db, fx, 'inv_draft', [goods], { status: 'draft' });
    expect((await api('POST', '/issue', { invoiceId: 'inv_draft' })).error.message).toMatch(/Finalize the invoice/);

    await seedInvoice(db, fx, 'inv_mixed', [goods, service]);
    const mixed = await api('POST', '/issue', { invoiceId: 'inv_mixed' });
    expect(mixed.status).toBe(400);
    expect(mixed.error.message).toMatch(/mixes goods and services/);

    await seedInvoice(db, fx, 'inv_cn', [goods], { type: 'credit_note', creditNoteForInvoiceId: 'inv_goods' });
    expect((await api('POST', '/issue', { invoiceId: 'inv_cn' })).error.message).toMatch(/issue the NF-e of the invoice it credits first/);
    expect((await api('POST', '/issue', { invoiceId: 'inv_none' })).status).toBe(404);
  });

  it('lists what is missing for the NF-e before anything is sent', async () => {
    await seedInvoice(db, fx, 'inv_nontm', [{ ...goods, ncm: '' }]);
    const before = focus.calls.length;
    const res = await api('POST', '/issue', { invoiceId: 'inv_nontm' });
    expect(res.status).toBe(400);
    expect(res.error.details.missing).toEqual(expect.arrayContaining(['line 1: NCM (8 digits)']));
    expect(focus.calls).toHaveLength(before);
    expect(await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.sourceId, 'inv_nontm'))).toHaveLength(0);
  });

  it('issues an NF-e: a processing row with the payload, an event and an audit row', async () => {
    await seedInvoice(db, fx, 'inv_goods', [goods]);
    focus.on('POST', /\/v2\/nfe\?ref=/, (call) => jsonResponse({ cnpj_emitente: '12345678000123', ref: new URL(call.url).searchParams.get('ref'), status: 'processando_autorizacao' }, 202));
    const res = await api('POST', '/issue', { invoiceId: 'inv_goods' });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ sourceType: 'invoice', sourceId: 'inv_goods', kind: 'nfe', provider: 'focus_nfe', providerRef: 'inv_goods-1', environment: 'homologacao', status: 'processing' });

    const call = focus.callsTo('POST', /\/v2\/nfe\?ref=inv_goods-1$/)[0];
    expect(call.url).toBe('https://homologacao.focusnfe.com.br/v2/nfe?ref=inv_goods-1');
    expect(call.headers.Authorization).toBe(`Basic ${btoa(`${TOKEN}:`)}`);
    expect(call.body).toMatchObject({ natureza_operacao: 'Venda de mercadoria', cnpj_emitente: '12345678000123', regime_tributario_emitente: 3 });
    const items = call.body?.items as Array<Record<string, unknown>>;
    // 18% ICMS inside the price in SP, PIS/COFINS 0.65% / 3% on the rest, the 2026 IBS/CBS test rates.
    expect(items[0]).toMatchObject({ icms_situacao_tributaria: '00', icms_aliquota: 18, icms_valor: 36, pis_situacao_tributaria: '01', cbs_aliquota: 0.9 });
    expect(call.body?.nome_destinatario).toBe('NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL');

    expect(sent.some((m) => JSON.stringify(m).includes('fiscal_document') && JSON.stringify(m).includes('created'))).toBe(true);
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, res.data.id));
    expect(audit.map((a) => a.action)).toEqual(['issued']);
    expect(JSON.stringify(res.data)).not.toContain(TOKEN);
  });

  it('refuses a second document while one is being authorized', async () => {
    const res = await api('POST', '/issue', { invoiceId: 'inv_goods' });
    expect(res.status).toBe(409);
    expect(res.error.message).toMatch(/still being authorized/);
  });

  it('lists a document with its payloads left out, and shows them on the detail', async () => {
    const list = await api('GET', '?sourceType=invoice&sourceId=inv_goods');
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).not.toHaveProperty('requestPayload');
    const detail = await api('GET', `/${list.data[0].id}`);
    expect(detail.data.requestPayload).toHaveProperty('items');
    expect((await api('GET', '/fdoc_missing')).status).toBe(404);
  });

  it('takes the authorization from the webhook, re-reading the document from Focus', async () => {
    focus.on('GET', /\/v2\/nfe\/inv_goods-1\?completa=1$/, () =>
      jsonResponse({
        cnpj_emitente: '12345678000123',
        ref: 'inv_goods-1',
        status: 'autorizado',
        status_sefaz: '100',
        mensagem_sefaz: 'Autorizado o uso da NF-e',
        chave_nfe: `NFe${KEY}`,
        numero: '22',
        serie: '1',
        caminho_xml_nota_fiscal: `/arquivos/12345678000123/202610/XMLs/${KEY}-nfe.xml`,
        caminho_danfe: `/arquivos/12345678000123/202610/DANFEs/${KEY}.pdf`,
        protocolo_nota_fiscal: { numero_protocolo: '141260000000001', data_recebimento: '2026-10-15T10:01:00-03:00' },
        requisicao_nota_fiscal: { huge: 'echo' },
      }),
    );
    const res = await webhook(hook.token, hook.secret, { ref: 'inv_goods-1', status: 'autorizado' });
    expect(res.status).toBe(200);

    const [doc] = await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.providerRef, 'inv_goods-1'));
    expect(doc).toMatchObject({
      status: 'authorized',
      number: '22',
      series: '1',
      accessKey: KEY,
      protocol: '141260000000001',
      xmlUrl: `https://homologacao.focusnfe.com.br/arquivos/12345678000123/202610/XMLs/${KEY}-nfe.xml`,
      pdfUrl: `https://homologacao.focusnfe.com.br/arquivos/12345678000123/202610/DANFEs/${KEY}.pdf`,
      statusMessage: 'Autorizado o uso da NF-e',
    });
    expect(doc.authorizedAt?.toISOString()).toBe('2026-10-15T13:01:00.000Z');
    // Our own request is not echoed back into the response column.
    expect(doc.responsePayload).not.toHaveProperty('requisicao_nota_fiscal');
    expect(sent.some((m) => JSON.stringify(m).includes('fiscal_document') && JSON.stringify(m).includes('updated'))).toBe(true);
  });

  it('refreshes on demand and does not publish when nothing changed', async () => {
    const [doc] = await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.providerRef, 'inv_goods-1'));
    const events = sent.length;
    const res = await api('POST', `/${doc.id}/refresh`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('authorized');
    expect(sent).toHaveLength(events);
  });

  it('sends a carta de correção on the authorized NF-e', async () => {
    const [doc] = await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.providerRef, 'inv_goods-1'));
    expect((await api('POST', `/${doc.id}/correction`, { text: 'curto' })).status).toBe(400);
    focus.on('POST', /\/carta_correcao$/, () =>
      jsonResponse({ status: 'autorizado', status_sefaz: '135', mensagem_sefaz: 'Evento registrado e vinculado a NF-e', caminho_xml_carta_correcao: '/arquivos/cce.xml', caminho_pdf_carta_correcao: '/arquivos/cce.pdf', numero_carta_correcao: 1 }),
    );
    const res = await api('POST', `/${doc.id}/correction`, { text: 'Correcao do endereco de entrega do destinatario' });
    expect(res.status).toBe(200);
    expect(res.data.correction).toMatchObject({ number: 1, xmlUrl: 'https://homologacao.focusnfe.com.br/arquivos/cce.xml' });
    expect(res.data.document.responsePayload.corrections).toHaveLength(1);
  });

  it('cancels an authorized document with a justification and then issues a new one', async () => {
    const [doc] = await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.providerRef, 'inv_goods-1'));
    expect((await api('POST', `/${doc.id}/cancel`, { reason: 'curto' })).status).toBe(400);

    focus.on('DELETE', /\/v2\/nfe\/inv_goods-1$/, () => jsonResponse({ status: 'cancelado', status_sefaz: '135', mensagem_sefaz: 'Evento registrado e vinculado a NF-e', caminho_xml_cancelamento: '/arquivos/can.xml' }));
    const res = await api('POST', `/${doc.id}/cancel`, { reason: 'Erro na emissao da nota fiscal' });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: 'cancelled', cancelReason: 'Erro na emissao da nota fiscal' });
    expect(res.data.cancelledAt).toBeTruthy();
    expect(focus.callsTo('DELETE', /inv_goods-1$/)[0].body).toEqual({ justificativa: 'Erro na emissao da nota fiscal' });

    expect((await api('POST', `/${doc.id}/cancel`, { reason: 'Erro na emissao da nota fiscal' })).error.message).toMatch(/Only an authorized/);

    const again = await api('POST', '/issue', { invoiceId: 'inv_goods' });
    expect(again.status).toBe(201);
    expect(again.data.providerRef).toBe('inv_goods-2');
  });

  it('keeps a rejected attempt and says why', async () => {
    await seedInvoice(db, fx, 'inv_rej', [goods]);
    focus.on('POST', /\/v2\/nfe\?ref=inv_rej-1$/, () =>
      jsonResponse({ codigo: 'erro_validacao_schema', mensagem: 'Erro na validação do Schema XML', erros: [{ mensagem: 'Municipio inexistente', campo: 'codigo_municipio_destinatario' }] }, 422),
    );
    const res = await api('POST', '/issue', { invoiceId: 'inv_rej' });
    expect(res.status).toBe(400);
    expect(res.error.message).toContain('Municipio inexistente');
    expect(res.error.details).toMatchObject({ provider: 'focus_nfe', codigo: 'erro_validacao_schema' });

    const [doc] = await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.sourceId, 'inv_rej'));
    expect(doc.status).toBe('rejected');
    expect(doc.statusMessage).toContain('Municipio inexistente');

    // The rejected document does not block the next attempt: new row, new reference.
    focus.on('POST', /\/v2\/nfe\?ref=inv_rej-2$/, () => jsonResponse({ status: 'processando_autorizacao' }, 202));
    const retry = await api('POST', '/issue', { invoiceId: 'inv_rej' });
    expect(retry.status).toBe(201);
    expect(retry.data.providerRef).toBe('inv_rej-2');
  });

  it('lets only one of two simultaneous requests issue the same invoice', async () => {
    await seedInvoice(db, fx, 'inv_race', [goods]);
    focus.on('POST', /\/v2\/nfe\?ref=inv_race-1$/, () => jsonResponse({ status: 'processando_autorizacao' }, 202));
    const results = await Promise.all([api('POST', '/issue', { invoiceId: 'inv_race' }), api('POST', '/issue', { invoiceId: 'inv_race' })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.sourceId, 'inv_race'))).toHaveLength(1);
  });

  it('settles an attempt lost to a network failure before sending another', async () => {
    await seedInvoice(db, fx, 'inv_net', [goods]);
    focus.on('POST', /\/v2\/nfe\?ref=inv_net-1$/, () => {
      throw new TypeError('fetch failed');
    });
    expect((await api('POST', '/issue', { invoiceId: 'inv_net' })).status).toBe(502);
    const [lost] = await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.sourceId, 'inv_net'));
    expect(lost.status).toBe('error');

    // Focus did get it after all: asking about it settles the row, and no second document is sent.
    focus.on('GET', /\/v2\/nfe\/inv_net-1\?completa=1$/, () => jsonResponse({ ref: 'inv_net-1', status: 'processando_autorizacao' }));
    const posts = focus.callsTo('POST', /\/v2\/nfe\?ref=inv_net/).length;
    const res = await api('POST', '/issue', { invoiceId: 'inv_net' });
    expect(res.status).toBe(409);
    expect(focus.callsTo('POST', /\/v2\/nfe\?ref=inv_net/)).toHaveLength(posts);
  });
});

describe('credit notes', () => {
  it('issues the devolução of an invoice whose NF-e is authorized, referencing its key', async () => {
    await seedInvoice(db, fx, 'inv_orig', [{ ...goods, cfop: '5102' }]);
    await db.insert(schema.fiscalDocuments).values({
      id: 'fdoc_orig',
      entityId: fx.entityId,
      sourceType: 'invoice',
      sourceId: 'inv_orig',
      kind: 'nfe',
      provider: 'focus_nfe',
      providerRef: 'inv_orig-1',
      environment: 'homologacao',
      status: 'authorized',
      accessKey: KEY,
    });
    await seedInvoice(db, fx, 'inv_orig_cn', [{ ...goods, cfop: '5102' }], { type: 'credit_note', creditNoteForInvoiceId: 'inv_orig' });
    // The token was removed by the settings tests above; put one back.
    focus.on('GET', /\/v2\/hooks$/, () => jsonResponse([]));
    focus.on('POST', /\/v2\/hooks$/, () => jsonResponse({ id: 'hookX' }));
    expect((await api('PUT', '/settings', { environment: 'homologacao', token: TOKEN })).status).toBe(200);
    focus.on('POST', /\/v2\/nfe\?ref=inv_orig_cn-1$/, () => jsonResponse({ status: 'processando_autorizacao' }, 202));

    const res = await api('POST', '/issue', { invoiceId: 'inv_orig_cn' });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ sourceType: 'credit_note', kind: 'nfe' });
    expect(res.data.requestPayload).toMatchObject({
      tipo_documento: 0,
      finalidade_emissao: 4,
      notas_referenciadas: [{ chave_nfe: KEY }],
      formas_pagamento: [{ forma_pagamento: '90', valor_pagamento: 0 }],
    });
    expect(res.data.requestPayload.items[0].cfop).toBe('1202');
  });
});

describe('services', () => {
  it('issues an NFS-e Nacional with a DPS number from the entity sequence', async () => {
    await seedInvoice(db, fx, 'inv_srv1', [service]);
    await seedInvoice(db, fx, 'inv_srv2', [service]);
    focus.on('POST', /\/v2\/nfsen\?ref=/, () => jsonResponse({ status: 'processando_autorizacao' }, 202));
    const first = await api('POST', '/issue', { invoiceId: 'inv_srv1' });
    const second = await api('POST', '/issue', { invoiceId: 'inv_srv2' });
    expect(first.status).toBe(201);
    expect(first.data.kind).toBe('nfsen');
    expect(first.data.requestPayload).toMatchObject({
      numero_dps: 1,
      serie_dps: 1,
      cnpj_prestador: '12345678000123',
      codigo_tributacao_nacional_iss: '010701',
      valor_servico: 1500,
      percentual_aliquota_relativa_municipio: 5,
      tributacao_iss: 1,
      tipo_retencao_iss: 1,
    });
    expect(second.data.requestPayload.numero_dps).toBe(2);
  });

  it('refuses a credit note on a service and takes the NFS-e Nacional URL from the answer', async () => {
    focus.on('GET', /\/v2\/nfsen\/inv_srv1-1$/, () =>
      jsonResponse({ ref: 'inv_srv1-1', status: 'autorizado', numero: '15', codigo_verificacao: 'ABC123', data_emissao: '2026-10-15T10:00:00-03:00', url: 'https://www.nfse.gov.br/consultapublica/?tpc=1&chave=1', url_danfse: 'https://focusnfe.s3.amazonaws.com/x.pdf', caminho_xml_nota_fiscal: '/arquivos/x.xml' }),
    );
    const [doc] = await db.select().from(schema.fiscalDocuments).where(eq(schema.fiscalDocuments.providerRef, 'inv_srv1-1'));
    const res = await api('POST', `/${doc.id}/refresh`);
    expect(res.data).toMatchObject({ status: 'authorized', number: '15', verificationCode: 'ABC123', publicUrl: 'https://www.nfse.gov.br/consultapublica/?tpc=1&chave=1', pdfUrl: 'https://focusnfe.s3.amazonaws.com/x.pdf' });

    await seedInvoice(db, fx, 'inv_srv_cn', [service], { type: 'credit_note', creditNoteForInvoiceId: 'inv_srv1' });
    expect((await api('POST', '/issue', { invoiceId: 'inv_srv_cn' })).error.message).toMatch(/Cancel the original NFS-e/);
    // The carta de correção only exists for the NF-e.
    expect((await api('POST', `/${doc.id}/correction`, { text: 'Correcao do endereco de entrega do destinatario' })).error.message).toMatch(/only exists for the NF-e/);
  });

  it('uses the municipal NFS-e when the entity chose it', async () => {
    const res = await api('PUT', '/settings', { environment: 'homologacao', nfseStandard: 'municipal' });
    expect(res.data.nfseStandard).toBe('municipal');
    // Not changing the token leaves it (and the hooks) alone.
    expect(res.data.hasCredentials).toBe(true);
    await seedInvoice(db, fx, 'inv_srv3', [service]);
    focus.on('POST', /\/v2\/nfse\?ref=/, () => jsonResponse({ status: 'processando_autorizacao' }, 201));
    const issued = await api('POST', '/issue', { invoiceId: 'inv_srv3' });
    expect(issued.data.kind).toBe('nfse');
    expect(issued.data.requestPayload).toMatchObject({ prestador: { cnpj: '12345678000123' }, servico: { item_lista_servico: '0107', valor_servicos: 1500 } });
  });

  it('removes the token and its hooks', async () => {
    focus.on('DELETE', /\/v2\/hooks\//, () => jsonResponse({ deleted: true }));
    const deletedBefore = focus.callsTo('DELETE', /\/v2\/hooks\//).length;
    const res = await api('PUT', '/settings', { environment: 'homologacao', token: null });
    expect(res.data).toMatchObject({ hasCredentials: false, webhook: { registered: false } });
    expect(focus.callsTo('DELETE', /\/v2\/hooks\//).length - deletedBefore).toBe(3);
    expect([...kv.store.keys()].filter((k) => k.startsWith('fiscalhook:'))).toHaveLength(0);
    // Without a token nothing can be issued.
    await seedInvoice(db, fx, 'inv_notoken', [goods]);
    expect((await api('POST', '/issue', { invoiceId: 'inv_notoken' })).error.message).toMatch(/No Focus NFe token/);
  });
});
