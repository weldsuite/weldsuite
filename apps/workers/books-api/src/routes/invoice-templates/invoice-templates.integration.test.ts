/**
 * Invoice templates (the invoice designer): CRUD, the one-default-per-entity
 * rule, deleting a template detaching it from invoices, the template an invoice
 * resolves to, and invoices accepting a template of their own entity only.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { InvoiceTemplateDocument } from '@weldsuite/books-domain/invoice-template/schema';
import { invoiceTemplatesRoutes } from './index';
import { invoicesRoutes } from '../invoices';
import { resolveInvoiceTemplate } from '../../services/invoice-templates';

let db: Database;

const ENTITY_A = 'ent_tpl_a';
const ENTITY_B = 'ent_tpl_b';

/** The smallest valid document: one line-items table. */
function documentOf(paperSize: 'a4' | 'letter' = 'a4', marker = 'base'): InvoiceTemplateDocument {
  return {
    version: 1,
    paperSize,
    margins: { top: 40, bottom: 40 },
    theme: { font: 'helvetica', accent: '#1d4ed8', text: '#111827', muted: '#6b7280', fontSize: 9 },
    blocks: [
      { id: 'title', type: 'text', x: 40, y: 40, w: 200, h: 24, text: marker },
      {
        id: 'items',
        type: 'lineItems',
        x: 40,
        y: 200,
        w: 515,
        h: 300,
        columns: [
          { key: 'description', width: 0 },
          { key: 'amount', width: 20, align: 'right' },
        ],
      },
    ],
  };
}

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { message: string };
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
  const json = (text ? JSON.parse(text) : {}) as { data?: unknown; error?: { message: string } };
  return { status: res.status, data: json.data, error: json.error };
}

const templates = (path = '', opts: { method?: string; body?: unknown; entityId?: string } = {}) =>
  call('/api/invoice-templates', invoiceTemplatesRoutes, `/api/invoice-templates${path}`, opts);
const invoices = (path = '', opts: { method?: string; body?: unknown; entityId?: string } = {}) =>
  call('/api/invoices', invoicesRoutes, `/api/invoices${path}`, opts);

const createTemplate = (entityId: string, name: string, extra: Record<string, unknown> = {}) =>
  templates('', { method: 'POST', body: { entityId, name, document: documentOf(), ...extra } });

const invoiceBody = (extra: Record<string, unknown> = {}) => ({
  contactId: 'ctt_tpl',
  issueDate: '2026-04-01',
  dueDate: '2026-04-15',
  items: [{ description: 'Consulting', quantity: '1', unitPrice: '100.00' }],
  ...extra,
});

async function defaultsOf(entityId: string): Promise<string[]> {
  const rows = await db.select().from(schema.invoiceTemplates).where(eq(schema.invoiceTemplates.entityId, entityId));
  return rows.filter((r) => r.isDefault).map((r) => r.id);
}

beforeAll(async () => {
  ({ db } = await createPgliteDb());
  for (const id of [ENTITY_A, ENTITY_B]) {
    await db.insert(schema.entities).values({
      id,
      name: `Template Co ${id}`,
      jurisdictionCode: 'IN',
      baseCurrency: 'INR',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
    });
  }
}, 60_000);

describe('/api/invoice-templates', () => {
  it('makes the first template of an entity its default, and a second one not', async () => {
    const first = await createTemplate(ENTITY_A, 'Classic');
    expect(first.status).toBe(201);
    expect(first.data.isDefault).toBe(true);
    expect(first.data.entityId).toBe(ENTITY_A);
    expect(first.data.document.paperSize).toBe('a4');

    const second = await createTemplate(ENTITY_A, 'Modern');
    expect(second.status).toBe(201);
    expect(second.data.isDefault).toBe(false);
    expect(await defaultsOf(ENTITY_A)).toEqual([first.data.id]);

    // Another entity's first template is its own default.
    const other = await createTemplate(ENTITY_B, 'Other entity');
    expect(other.data.isDefault).toBe(true);
    expect(await defaultsOf(ENTITY_A)).toEqual([first.data.id]);
  });

  it('flips the default when a second template is created or patched as the default', async () => {
    const entity = 'ent_tpl_flip';
    await db.insert(schema.entities).values({ id: entity, name: 'Flip Co', jurisdictionCode: 'IN', baseCurrency: 'INR', locale: 'en-IN' });

    const a = await createTemplate(entity, 'A');
    const b = await createTemplate(entity, 'B', { isDefault: true });
    expect(b.data.isDefault).toBe(true);
    expect(await defaultsOf(entity)).toEqual([b.data.id]);

    const patched = await templates(`/${a.data.id}`, { method: 'PATCH', body: { isDefault: true } });
    expect(patched.status).toBe(200);
    expect(patched.data.isDefault).toBe(true);
    expect(await defaultsOf(entity)).toEqual([a.data.id]);
  });

  it('lists the default first, then by name, for the entity in the query or header', async () => {
    const entity = 'ent_tpl_list';
    await db.insert(schema.entities).values({ id: entity, name: 'List Co', jurisdictionCode: 'IN', baseCurrency: 'INR', locale: 'en-IN' });
    await createTemplate(entity, 'Zeta');
    await createTemplate(entity, 'Alpha');
    await createTemplate(entity, 'Mid', { isDefault: true });

    const byQuery = await templates(`?entityId=${entity}`);
    expect(byQuery.status).toBe(200);
    expect(byQuery.data.map((t: { name: string }) => t.name)).toEqual(['Mid', 'Alpha', 'Zeta']);

    const byHeader = await templates('', { entityId: entity });
    expect(byHeader.data.map((t: { name: string }) => t.name)).toEqual(['Mid', 'Alpha', 'Zeta']);
  });

  it('mirrors document.paperSize into the paper_size column', async () => {
    const created = await createTemplate(ENTITY_A, 'Letter layout', { document: documentOf('letter') });
    expect(created.status).toBe(201);
    const [row] = await db.select().from(schema.invoiceTemplates).where(eq(schema.invoiceTemplates.id, created.data.id));
    expect(row?.paperSize).toBe('letter');

    const patched = await templates(`/${created.data.id}`, { method: 'PATCH', body: { document: documentOf('a4', 'changed') } });
    expect(patched.status).toBe(200);
    const [after] = await db.select().from(schema.invoiceTemplates).where(eq(schema.invoiceTemplates.id, created.data.id));
    expect(after?.paperSize).toBe('a4');
    expect(patched.data.document.blocks[0].text).toBe('changed');
  });

  it('rejects an invalid document with 400', async () => {
    const noTable = documentOf();
    noTable.blocks = noTable.blocks.filter((b) => b.type !== 'lineItems');
    const res = await createTemplate(ENTITY_A, 'No table', { document: noTable });
    expect(res.status).toBe(400);

    const duplicateIds = documentOf();
    duplicateIds.blocks = [...duplicateIds.blocks, { ...duplicateIds.blocks[0] }];
    expect((await createTemplate(ENTITY_A, 'Dupes', { document: duplicateIds })).status).toBe(400);

    expect((await createTemplate(ENTITY_A, 'Bad doc', { document: { version: 1 } })).status).toBe(400);

    const existing = await createTemplate(ENTITY_A, 'To patch');
    const patch = await templates(`/${existing.data.id}`, { method: 'PATCH', body: { document: { ...documentOf(), blocks: [] } } });
    expect(patch.status).toBe(400);
  });

  it('refuses an unknown entity with 400 and an unknown template with 404', async () => {
    expect((await createTemplate('ent_does_not_exist', 'Nowhere')).status).toBe(400);
    expect((await templates('/itpl_missing')).status).toBe(404);
    expect((await templates('/itpl_missing', { method: 'PATCH', body: { name: 'x' } })).status).toBe(404);
    expect((await templates('/itpl_missing', { method: 'DELETE' })).status).toBe(404);
    expect((await templates('/itpl_missing/duplicate', { method: 'POST' })).status).toBe(404);
  });

  it('duplicates as "<name> (copy)", never as the default', async () => {
    const entity = 'ent_tpl_dup';
    await db.insert(schema.entities).values({ id: entity, name: 'Dup Co', jurisdictionCode: 'IN', baseCurrency: 'INR', locale: 'en-IN' });
    const source = await createTemplate(entity, 'Original');
    expect(source.data.isDefault).toBe(true);

    const copy = await templates(`/${source.data.id}/duplicate`, { method: 'POST' });
    expect(copy.status).toBe(201);
    expect(copy.data.name).toBe('Original (copy)');
    expect(copy.data.isDefault).toBe(false);
    expect(copy.data.id).not.toBe(source.data.id);
    expect(copy.data.document).toEqual(source.data.document);
    expect(await defaultsOf(entity)).toEqual([source.data.id]);
  });

  it('deleting a template clears invoices.template_id and promotes no new default', async () => {
    const entity = 'ent_tpl_del';
    await db.insert(schema.entities).values({ id: entity, name: 'Delete Co', jurisdictionCode: 'IN', baseCurrency: 'INR', locale: 'en-IN' });
    const keep = await createTemplate(entity, 'Keep');
    const doomed = await createTemplate(entity, 'Doomed', { isDefault: true });

    const onDoomed = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody({ templateId: doomed.data.id }) });
    const onKeep = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody({ templateId: keep.data.id }) });
    expect(onDoomed.status).toBe(201);
    expect(onKeep.status).toBe(201);

    const res = await templates(`/${doomed.data.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await templates(`/${doomed.data.id}`)).status).toBe(404);

    const [detached] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, onDoomed.data.id));
    const [kept] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, onKeep.data.id));
    expect(detached?.templateId).toBeNull();
    expect(kept?.templateId).toBe(keep.data.id);
    // The default was deleted; the other template is not promoted.
    expect(await defaultsOf(entity)).toEqual([]);
  });
});

describe('resolveInvoiceTemplate', () => {
  const entity = 'ent_tpl_resolve';
  const otherEntity = 'ent_tpl_resolve_other';
  let ownId: string;
  let defaultId: string;
  let foreignId: string;

  beforeAll(async () => {
    for (const id of [entity, otherEntity]) {
      await db.insert(schema.entities).values({ id, name: id, jurisdictionCode: 'IN', baseCurrency: 'INR', locale: 'en-IN' });
    }
  });

  it('returns null when the entity has no templates', async () => {
    expect(await resolveInvoiceTemplate(db, { entityId: entity })).toBeNull();
    expect(await resolveInvoiceTemplate(db, { templateId: 'itpl_missing', entityId: entity })).toBeNull();
  });

  it('prefers the invoice template, then the entity default', async () => {
    const def = await createTemplate(entity, 'Default', { document: documentOf('a4', 'default') });
    const own = await createTemplate(entity, 'Own', { document: documentOf('letter', 'own') });
    const foreign = await createTemplate(otherEntity, 'Foreign', { document: documentOf('a4', 'foreign') });
    defaultId = def.data.id;
    ownId = own.data.id;
    foreignId = foreign.data.id;

    const picked = await resolveInvoiceTemplate(db, { templateId: ownId, entityId: entity });
    expect(picked?.paperSize).toBe('letter');
    expect((picked?.blocks[0] as { text: string }).text).toBe('own');

    const fallback = await resolveInvoiceTemplate(db, { templateId: null, entityId: entity });
    expect((fallback?.blocks[0] as { text: string }).text).toBe('default');
    expect(defaultId).toBeTruthy();
  });

  it('falls back to the default when the template is missing or belongs to another entity', async () => {
    const missing = await resolveInvoiceTemplate(db, { templateId: 'itpl_gone', entityId: entity });
    expect((missing?.blocks[0] as { text: string }).text).toBe('default');

    const foreign = await resolveInvoiceTemplate(db, { templateId: foreignId, entityId: entity });
    expect((foreign?.blocks[0] as { text: string }).text).toBe('default');
  });

  it('returns null once the default is gone, even when other templates exist', async () => {
    await templates(`/${defaultId}`, { method: 'DELETE' });
    expect(await resolveInvoiceTemplate(db, { entityId: entity })).toBeNull();
    // An explicit pick still wins.
    expect(await resolveInvoiceTemplate(db, { templateId: ownId, entityId: entity })).not.toBeNull();
  });
});

describe('/api/invoices · templateId', () => {
  const entity = 'ent_tpl_inv';
  const otherEntity = 'ent_tpl_inv_other';
  let own: string;
  let foreign: string;

  beforeAll(async () => {
    for (const id of [entity, otherEntity]) {
      await db.insert(schema.entities).values({ id, name: id, jurisdictionCode: 'IN', baseCurrency: 'INR', locale: 'en-IN' });
    }
    own = (await createTemplate(entity, 'Mine')).data.id;
    foreign = (await createTemplate(otherEntity, 'Not mine')).data.id;
  });

  it('stores a template of the invoice entity and refuses one of another entity or none at all', async () => {
    const ok = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody({ templateId: own }) });
    expect(ok.status).toBe(201);
    expect(ok.data.templateId).toBe(own);

    const wrongEntity = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody({ templateId: foreign }) });
    expect(wrongEntity.status).toBe(400);

    const unknown = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody({ templateId: 'itpl_nope' }) });
    expect(unknown.status).toBe(400);

    const none = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody() });
    expect(none.status).toBe(201);
    expect(none.data.templateId).toBeNull();
  });

  it('PATCH sets, validates and clears the template of a draft', async () => {
    const draft = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody() });
    const id = draft.data.id as string;

    const set = await invoices(`/${id}`, { method: 'PATCH', body: { templateId: own } });
    expect(set.status).toBe(200);
    const [stored] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(stored?.templateId).toBe(own);

    const wrong = await invoices(`/${id}`, { method: 'PATCH', body: { templateId: foreign } });
    expect(wrong.status).toBe(400);
    const [unchanged] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(unchanged?.templateId).toBe(own);

    const cleared = await invoices(`/${id}`, { method: 'PATCH', body: { templateId: null } });
    expect(cleared.status).toBe(200);
    const [after] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(after?.templateId).toBeNull();
  });

  it('prints the document with the template, and with the built-in layout when the entity has none', async () => {
    const printed = async (invoiceId: string) => {
      const { request } = createTestApp('/api/invoices', invoicesRoutes, { context: { permissions: permissions('*'), tenantDb: db } });
      const res = await request(`/api/invoices/${invoiceId}/pdf`);
      expect(res.status).toBe(200);
      return res.text();
    };

    const designed = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody({ templateId: own }) });
    const designedHtml = await printed(designed.data.id);
    expect(designedHtml).toContain('<svg');
    expect(designedHtml).toContain('>base</text>');

    const plainEntity = 'ent_tpl_plain';
    await db.insert(schema.entities).values({ id: plainEntity, name: plainEntity, jurisdictionCode: 'IN', baseCurrency: 'INR', locale: 'en-IN' });
    const plain = await invoices('', { method: 'POST', entityId: plainEntity, body: invoiceBody() });
    expect(await printed(plain.data.id)).not.toContain('<svg');
  });

  it('duplicating an invoice keeps its template', async () => {
    const draft = await invoices('', { method: 'POST', entityId: entity, body: invoiceBody({ templateId: own }) });
    const copy = await invoices(`/${draft.data.id}/duplicate`, { method: 'POST' });
    expect(copy.status).toBe(201);
    const [stored] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, copy.data.id));
    expect(stored?.templateId).toBe(own);
  });
});
