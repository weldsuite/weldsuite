/**
 * The document inbox around OCR: listing, counts, reading, linking,
 * rejecting, deleting, matching a stored OCR result to a contact again
 * (/rematch), the create-bill redirect, and their refusals.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingDocumentsRoutes } from './index';

let db: Database;

const ocr = (vendor: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  vendor: { name: null, address: null, taxNumber: null, kvkNumber: null, iban: null, bic: null, ...vendor },
  invoiceNumber: 'F-1',
  invoiceDate: '2026-03-01',
  dueDate: null,
  currency: 'EUR',
  lineItems: [],
  subtotal: 100,
  taxBreakdown: [{ rate: 21, taxableAmount: 100, taxAmount: 21 }],
  totalTax: 21,
  total: 121,
  paymentReference: null,
  iban: null,
  confidence: { overall: 0.9, fields: {} },
  rawText: null,
  ...extra,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db
    .insert(schema.parties)
    .values({ id: 'acn_iban', displayName: 'Iban Supplier', role: 'supplier', iban: 'NL91ABNA0417164300' });
  const base = { fileKey: 'workspaces/org_test_default/accounting/a.pdf', mimeType: 'application/pdf' };
  await db.insert(schema.documents).values([
    { id: 'doc_pending', fileName: 'pending.pdf', status: 'pending', ...base },
    { id: 'doc_iban', fileName: 'iban.pdf', status: 'processed', ocrResult: ocr({ iban: 'NL91ABNA0417164300' }), ...base },
    { id: 'doc_none', fileName: 'none.pdf', status: 'processed', ocrResult: ocr({}), ...base },
    { id: 'doc_receipt', fileName: 'r.jpg', status: 'processed', type: 'receipt', source: 'scan', ...base },
    { id: 'doc_gone', fileName: 'gone.pdf', status: 'pending', deletedAt: new Date(), ...base },
  ] as Array<typeof schema.documents.$inferInsert>);
}, 60_000);

function app(perms: string[]) {
  return createTestApp('/api/accounting-documents', accountingDocumentsRoutes, {
    context: { permissions: permissions(...perms), tenantDb: db },
  });
}

const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('reading the inbox', () => {
  it('lists live documents, filtered by status, type and source', async () => {
    const all = await app(['invoices:read']).request('/api/accounting-documents');
    expect(all.status).toBe(200);
    const ids = ((await all.json()) as { data: Array<{ id: string }> }).data.map((d) => d.id);
    expect(ids).toContain('doc_pending');
    expect(ids).not.toContain('doc_gone');

    const receipts = await app(['invoices:read']).request('/api/accounting-documents?type=receipt&source=scan&status=processed');
    expect(((await receipts.json()) as { data: Array<{ id: string }> }).data.map((d) => d.id)).toEqual(['doc_receipt']);
  });

  it('counts documents per status', async () => {
    const res = await app(['invoices:read']).request('/api/accounting-documents/stats');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ status: string; count: number }> };
    expect(data.find((s) => s.status === 'processed')?.count).toBe(3);
  });

  it('reads one document, and 404s a deleted or unknown one', async () => {
    const res = await app(['invoices:read']).request('/api/accounting-documents/doc_pending');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { fileName: string } }).data.fileName).toBe('pending.pdf');
    expect((await app(['invoices:read']).request('/api/accounting-documents/doc_gone')).status).toBe(404);
    expect((await app([]).request('/api/accounting-documents/doc_pending')).status).toBe(403);
  });
});

describe('POST /:id/rematch', () => {
  const rematch = (id: string) =>
    app(['invoices:update']).request(`/api/accounting-documents/${id}/rematch`, { method: 'POST' });

  it('matches the contact with the IBAN on the document', async () => {
    const res = await rematch('doc_iban');
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ data: { id: 'doc_iban', matchedContactId: 'acn_iban' } });
  });

  it('matches nobody without anything to match on', async () => {
    const res = await rematch('doc_none');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { matchedContactId: string | null } }).data.matchedContactId).toBeNull();
  });

  it('refuses a document without an OCR result, and an unknown one', async () => {
    expect((await rematch('doc_pending')).status).toBe(400);
    expect((await rematch('doc_nobody')).status).toBe(404);
  });
});

describe('POST /:id/create-bill', () => {
  it('points at the bills route', async () => {
    const res = await app(['invoices:create']).request('/api/accounting-documents/doc_iban/create-bill', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('linking, rejecting and deleting', () => {
  it('links a document to a bill', async () => {
    const res = await app(['invoices:update']).request(
      '/api/accounting-documents/doc_iban/link',
      patch({ linkedEntityType: 'bill', linkedEntityId: 'bil_1' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ data: { id: 'doc_iban', status: 'linked' } });
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, 'doc_iban'));
    expect(row?.linkedEntityId).toBe('bil_1');
  });

  it('refuses a bad link body and an unknown document', async () => {
    const bad = await app(['invoices:update']).request(
      '/api/accounting-documents/doc_iban/link',
      patch({ linkedEntityType: 'order' }),
    );
    expect(bad.status).toBe(400);
    const missing = await app(['invoices:update']).request(
      '/api/accounting-documents/doc_nobody/link',
      patch({ linkedEntityType: 'bill', linkedEntityId: 'bil_1' }),
    );
    expect(missing.status).toBe(404);
  });

  it('rejects a document', async () => {
    const res = await app(['invoices:update']).request('/api/accounting-documents/doc_none/reject', { method: 'PATCH' });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, 'doc_none'));
    expect(row?.status).toBe('rejected');
    const missing = await app(['invoices:update']).request('/api/accounting-documents/doc_nobody/reject', { method: 'PATCH' });
    expect(missing.status).toBe(404);
  });

  it('deletes a document softly, once', async () => {
    const del = () => app(['invoices:delete']).request('/api/accounting-documents/doc_receipt', { method: 'DELETE' });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
    const denied = await app(['invoices:update']).request('/api/accounting-documents/doc_receipt', { method: 'DELETE' });
    expect(denied.status).toBe(403);
  });
});
