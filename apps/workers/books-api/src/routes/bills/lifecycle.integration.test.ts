/**
 * A bill's life past creation: the list (filters, search, paging), the
 * detail, editing a draft (lines re-taxed, header fields), deleting it,
 * rejecting (a draft, and an approved bill whose posting is reversed),
 * pre-filling a bill from a processed document, and the stored attachment.
 * Refusals included.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { billsRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';

let db: Database;
let entityId = '';
const ORG = 'org_test_default';
const ATTACHMENT_KEY = `workspaces/${ORG}/accounting/inbox/m1/invoice.pdf`;

/** An R2-shaped bucket the harness can serve. */
function memoryBucket() {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  return {
    objects,
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        key,
        size: object.body.byteLength,
        etag: 'e1',
        httpEtag: '"e1"',
        httpMetadata: { contentType: object.contentType },
        customMetadata: {},
        body: new Blob([object.body]).stream(),
        writeHttpMetadata(headers: Headers) {
          if (object.contentType) headers.set('content-type', object.contentType);
        },
        async arrayBuffer() {
          return object.body.buffer;
        },
        async text() {
          return new TextDecoder().decode(object.body);
        },
      };
    },
    async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) {
      const body = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
      objects.set(key, { body, contentType: options?.httpMetadata?.contentType });
      return { key };
    },
    async head(key: string) {
      return objects.has(key) ? { key, size: objects.get(key)!.body.byteLength } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

const bucket = memoryBucket();

function app(perms: string[]) {
  return createTestApp('/api/bills', billsRoutes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: { PRIVATE_STORAGE: bucket } as any,
    context: { permissions: permissions(...perms), tenantDb: db },
  });
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': entityId },
  body: JSON.stringify(body),
});

async function newBill(extra: Record<string, unknown> = {}): Promise<{ id: string; total: string }> {
  const res = await app(['bills:create']).request(
    '/api/bills',
    json('POST', {
      contactId: 'acn_bill_vendor',
      issueDate: '2026-03-10',
      dueDate: '2026-04-09',
      items: [{ description: 'Paper', quantity: '2', unitPrice: '50.00', taxRateId: 'txr_bill_21' }],
      ...extra,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string; total: string } }).data;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const { request } = createTestApp('/api/accounting-entities', accountingEntitiesRoutes, {
    context: { permissions: permissions('*'), tenantDb: db },
  });
  const res = await request('/api/accounting-entities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bills Lifecycle BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' }),
  });
  expect(res.status).toBe(201);
  entityId = ((await res.json()) as { data: { id: string } }).data.id;
  await db.insert(schema.taxRates).values({
    id: 'txr_bill_21',
    entityId,
    jurisdictionCode: 'NL',
    name: 'BTW 21%',
    taxCategoryCode: 'standard',
    rate: '21.00',
    type: 'purchase',
    isActive: true,
  } as typeof schema.taxRates.$inferInsert);
  await db.insert(schema.parties).values({ id: 'acn_bill_vendor', displayName: 'Paper Supplier', role: 'none' });
  await db.insert(schema.parties).values({ id: 'acn_bill_other', displayName: 'Other Supplier', role: 'customer' });
  await bucket.put(ATTACHMENT_KEY, new TextEncoder().encode('%PDF-1.4 bill'), { httpMetadata: { contentType: 'application/pdf' } });
}, 120_000);

describe('reading bills', () => {
  it('lists the entity bills, filtered and searched, newest first', async () => {
    const first = await newBill({ billNumber: 'SUP-100', externalReference: 'REF-A' });
    await newBill({ billNumber: 'SUP-101', issueDate: '2026-05-01', dueDate: '2026-05-31' });

    const all = await app(['bills:read']).request('/api/bills', { headers: { 'X-Accounting-Entity-Id': entityId } });
    expect(all.status).toBe(200);
    const listed = (await all.json()) as { data: Array<{ id: string; contactName: string }>; pagination: { totalCount: number } };
    expect(listed.pagination.totalCount).toBeGreaterThanOrEqual(2);
    expect(listed.data[0]!.contactName).toBe('Paper Supplier');

    const searched = await app(['bills:read']).request('/api/bills?search=REF-A', { headers: { 'X-Accounting-Entity-Id': entityId } });
    expect(((await searched.json()) as { data: Array<{ id: string }> }).data.map((b) => b.id)).toEqual([first.id]);

    const ranged = await app(['bills:read']).request('/api/bills?from=2026-04-01&to=2026-12-31&status=draft&pageSize=1', {
      headers: { 'X-Accounting-Entity-Id': entityId },
    });
    const page = (await ranged.json()) as { data: Array<{ billNumber: string }>; pagination: { hasMore: boolean } };
    expect(page.data.map((b) => b.billNumber)).toEqual(['SUP-101']);
  });

  it('reads a bill with its lines and payments', async () => {
    const bill = await newBill();
    const res = await app(['bills:read']).request(`/api/bills/${bill.id}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { items: Array<{ taxAmount: string }>; payments: unknown[]; total: string } };
    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.taxAmount).toBe('21.00');
    expect(data.payments).toEqual([]);
    expect(data.total).toBe('121.00');
  });

  it('needs bills:read', async () => {
    expect((await app([]).request('/api/bills')).status).toBe(403);
  });
});

describe('editing a draft', () => {
  it('replaces the lines and taxes them again (PUT and PATCH)', async () => {
    const bill = await newBill();
    const res = await app(['bills:update']).request(
      `/api/bills/${bill.id}`,
      json('PATCH', {
        notes: 'Second delivery',
        items: [{ description: 'Ink', quantity: '1', unitPrice: '200', taxRateId: 'txr_bill_21' }],
      }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { total: string; balanceDue: string; items: unknown[]; notes: string } };
    expect(data.total).toBe('242.00');
    expect(data.balanceDue).toBe('242');
    expect(data.items).toHaveLength(1);
    expect(data.notes).toBe('Second delivery');

    const put = await app(['bills:update']).request(
      `/api/bills/${bill.id}`,
      json('PUT', { contactId: 'acn_bill_other', dueDate: '2026-06-30', reference: 'PO-9' }),
    );
    expect(put.status).toBe(200);
    const updated = ((await put.json()) as { data: { contactName: string; reference: string } }).data;
    expect(updated.contactName).toBe('Other Supplier');
    expect(updated.reference).toBe('PO-9');
  });

  it('refuses a bad body, an unknown bill and a bill that is no draft', async () => {
    const bill = await newBill();
    const bad = await app(['bills:update']).request(`/api/bills/${bill.id}`, json('PATCH', { items: [{ description: '' }] }));
    expect(bad.status).toBe(400);
    expect((await app(['bills:update']).request('/api/bills/bil_nobody', json('PATCH', { notes: 'x' }))).status).toBe(404);

    await db.update(schema.bills).set({ status: 'approved' }).where(eq(schema.bills.id, bill.id));
    const approved = await app(['bills:update']).request(`/api/bills/${bill.id}`, json('PATCH', { notes: 'x' }));
    expect(approved.status).toBe(400);
  });
});

describe('deleting a draft', () => {
  it('deletes a draft once and refuses anything else', async () => {
    const bill = await newBill();
    const del = () => app(['bills:delete']).request(`/api/bills/${bill.id}`, { method: 'DELETE' });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);

    const approved = await newBill();
    await db.update(schema.bills).set({ status: 'approved' }).where(eq(schema.bills.id, approved.id));
    expect((await app(['bills:delete']).request(`/api/bills/${approved.id}`, { method: 'DELETE' })).status).toBe(400);
    expect((await app(['bills:update']).request(`/api/bills/${approved.id}`, { method: 'DELETE' })).status).toBe(403);
  });
});

describe('rejecting', () => {
  const reject = (id: string, body: unknown) => app(['bills:update']).request(`/api/bills/${id}/reject`, json('PATCH', body));

  it('rejects a draft', async () => {
    const bill = await newBill();
    const res = await reject(bill.id, { reason: 'Duplicate' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { status: string; approvalStatus: string } };
    expect(data).toMatchObject({ status: 'cancelled', approvalStatus: 'rejected' });
  });

  it('reverses an approved bill when it is rejected', async () => {
    const bill = await newBill();
    const approve = await app(['bills:update']).request(`/api/bills/${bill.id}/approve`, { method: 'PATCH' });
    expect(approve.status).toBe(200);
    const journalEntryId = ((await approve.json()) as { data: { journalEntryId: string } }).data.journalEntryId;
    expect(journalEntryId).toBeTruthy();

    const res = await reject(bill.id, { reason: 'Wrong supplier' });
    expect(res.status).toBe(200);
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, journalEntryId));
    expect(entry?.status).toBe('reversed');
    const [row] = await db.select().from(schema.bills).where(eq(schema.bills.id, bill.id));
    expect(row?.rejectionReason).toBe('Wrong supplier');

    const again = await app(['bills:update']).request(`/api/bills/${bill.id}/approve`, { method: 'PATCH' });
    expect(again.status).toBe(200);
  });

  it('refuses a bill with payments, an empty reason and an unknown bill', async () => {
    const bill = await newBill();
    await db.update(schema.bills).set({ amountPaid: '10.00' }).where(eq(schema.bills.id, bill.id));
    expect((await reject(bill.id, { reason: 'x' })).status).toBe(400);
    expect((await reject(bill.id, { reason: '' })).status).toBe(400);
    expect((await reject('bil_nobody', { reason: 'x' })).status).toBe(404);
  });
});

describe('POST /from-document/:documentId', () => {
  it('pre-fills a bill from a processed document', async () => {
    await db.insert(schema.documents).values({
      id: 'doc_bill_ocr',
      fileName: 'receipt.jpg',
      fileKey: `workspaces/${ORG}/accounting/receipt.jpg`,
      status: 'processed',
      matchedContactId: 'acn_bill_vendor',
      ocrResult: { vendor: { name: 'Corner Shop' }, invoiceDate: '12-3-2026', total: 60.5, taxBreakdown: [{ rate: 21 }] },
    } as typeof schema.documents.$inferInsert);
    const res = await app(['bills:create']).request('/api/bills/from-document/doc_bill_ocr', { method: 'POST' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { contactName: string; issueDate: string; items: Array<{ unitPrice: string }> } };
    expect(data.contactName).toBe('Corner Shop');
    expect(data.issueDate).toBe('2026-03-12');
    expect(data.items[0]!.unitPrice).toBe('50');
  });

  it('refuses a document without OCR, and an unknown one', async () => {
    await db.insert(schema.documents).values({
      id: 'doc_bill_raw',
      fileName: 'raw.pdf',
      fileKey: `workspaces/${ORG}/accounting/raw.pdf`,
      status: 'pending',
    } as typeof schema.documents.$inferInsert);
    expect((await app(['bills:create']).request('/api/bills/from-document/doc_bill_raw', { method: 'POST' })).status).toBe(400);
    expect((await app(['bills:create']).request('/api/bills/from-document/doc_nobody', { method: 'POST' })).status).toBe(404);
  });
});

describe('GET /:id/attachments/:index', () => {
  it('streams a stored attachment of the bill', async () => {
    const bill = await newBill();
    await db
      .update(schema.bills)
      .set({ attachmentKeys: [ATTACHMENT_KEY, 'workspaces/org_other/x.pdf'] })
      .where(eq(schema.bills.id, bill.id));
    const res = await app(['bills:read']).request(`/api/bills/${bill.id}/attachments/0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('inline; filename="invoice.pdf"');
    expect(await res.text()).toBe('%PDF-1.4 bill');

    expect((await app(['bills:read']).request(`/api/bills/${bill.id}/attachments/1`)).status).toBe(403);
    expect((await app(['bills:read']).request(`/api/bills/${bill.id}/attachments/5`)).status).toBe(404);
    expect((await app(['bills:read']).request(`/api/bills/${bill.id}/attachments/x`)).status).toBe(400);
    expect((await app(['bills:read']).request('/api/bills/bil_nobody/attachments/0')).status).toBe(404);
  });
});
