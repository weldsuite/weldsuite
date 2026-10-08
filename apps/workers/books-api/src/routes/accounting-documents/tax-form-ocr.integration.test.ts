/**
 * Tax forms never reach OCR: a document filed as a tax form, or attached to a
 * vendor's W-9 or a customer's exemption certificate, is refused before any
 * AI call (they carry TINs and SSNs).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingDocumentsRoutes } from './index';
import { seedEntityAndVendors, type Fixture } from '../../services/form-1099/test-fixtures';

let db: Database;
let fx: Fixture;

const process = (id: string) =>
  fx.call('/api/accounting-documents', accountingDocumentsRoutes, `/${id}/process`, {
    method: 'POST',
    perms: ['invoices:update'],
  });

async function newDocument(id: string, type = 'purchase_invoice') {
  await db.insert(schema.documents).values({
    id,
    entityId: fx.entityId,
    type,
    fileName: `${id}.pdf`,
    fileKey: `docs/${id}.pdf`,
    mimeType: 'application/pdf',
  } as typeof schema.documents.$inferInsert);
}

async function status(id: string) {
  const [row] = await db.select({ status: schema.documents.status }).from(schema.documents).where(eq(schema.documents.id, id));
  return row?.status;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  fx = await seedEntityAndVendors(db);
}, 180_000);

describe('OCR refuses tax forms', () => {
  it('refuses a document filed as a tax form', async () => {
    await newDocument('doc_taxform', 'tax_form');
    const res = await process('doc_taxform');
    expect(res.status).toBe(400);
    expect(res.text).toContain('never sent to OCR');
    expect(await status('doc_taxform')).not.toBe('processing');
  });

  it("refuses a scan attached to a vendor's W-9", async () => {
    await newDocument('doc_w9scan');
    const partyId = Object.values(fx.parties)[0]!;
    await db.update(schema.parties).set({ w9: { legalName: 'Vendor', documentId: 'doc_w9scan' } }).where(eq(schema.parties.id, partyId));
    const res = await process('doc_w9scan');
    expect(res.status).toBe(400);
    expect(res.text).toContain('never sent to OCR');
  });

  it('refuses a scan attached to an exemption certificate', async () => {
    await newDocument('doc_certscan');
    await db.insert(schema.exemptionCertificates).values({
      id: 'exc_scan',
      entityId: fx.entityId,
      partyId: Object.values(fx.parties)[0]!,
      states: ['TX'],
      reason: 'resale',
      documentId: 'doc_certscan',
    });
    const res = await process('doc_certscan');
    expect(res.status).toBe(400);
    expect(res.text).toContain('never sent to OCR');
  });
});
