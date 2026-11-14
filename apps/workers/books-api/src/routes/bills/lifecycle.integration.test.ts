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

describe('POST /:id/record-payment', () => {
  const pay = (id: string, body: unknown, perms = ['banking:create']) =>
    app(perms).request(`/api/bills/${id}/record-payment`, json('POST', body));
  const approve = (id: string) => app(['bills:update']).request(`/api/bills/${id}/approve`, { method: 'PATCH' });
  const detail = async (id: string) =>
    ((await (await app(['bills:read']).request(`/api/bills/${id}`)).json()) as {
      data: { status: string; amountPaid: string; balanceDue: string; payments: Array<{ id: string; allocatedAmount: string }> };
    }).data;

  it('pays an approved bill in two parts: partial, then paid, the payments listed on the bill', async () => {
    const bill = await newBill();
    expect((await approve(bill.id)).status).toBe(200);

    const part = await pay(bill.id, { amount: '40.00', date: '2026-03-20', paymentMethod: 'bank_transfer', reference: 'INV-1' });
    expect(part.status).toBe(201);
    const first = ((await part.json()) as { data: { paymentId: string; journalEntryId: string; amountPaid: string; balanceDue: string; status: string } }).data;
    expect(first).toMatchObject({ amountPaid: '40.00', balanceDue: '81.00', status: 'partial' });
    expect(first.paymentId).toBeTruthy();
    expect(first.journalEntryId).toBeTruthy();

    const rest = await pay(bill.id, { amount: '81.00', date: '2026-03-25' });
    expect(rest.status).toBe(201);
    expect(((await rest.json()) as { data: unknown }).data).toMatchObject({ amountPaid: '121.00', balanceDue: '0.00', status: 'paid' });

    // The payments reach the bill through their allocations (the payment itself carries no bill id when it covers several documents).
    const read = await detail(bill.id);
    expect(read).toMatchObject({ status: 'paid', amountPaid: '121.00' });
    expect(read.payments.map((p) => p.allocatedAmount).sort()).toEqual(['40.00', '81.00']);

    // Dr 1600 payable / Cr bank.
    const lines = await db
      .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
      .from(schema.journalLines)
      .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
      .where(eq(schema.journalLines.journalEntryId, first.journalEntryId));
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.code === '1600')).toMatchObject({ debit: '40.00' });
    expect(lines.find((l) => l.code !== '1600')).toMatchObject({ credit: '40.00' });
  });

  it('refuses to pay more than is open, a draft, a cancelled bill, an unknown bill and a caller without banking:create', async () => {
    const bill = await newBill();
    const draft = await pay(bill.id, { amount: '10.00', date: '2026-03-20' });
    expect(draft.status).toBe(400);
    expect(((await draft.json()) as { error: { message: string } }).error.message).toMatch(/must be approved before it can be paid/);

    expect((await approve(bill.id)).status).toBe(200);
    const over = await pay(bill.id, { amount: '121.01', date: '2026-03-20' });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: { message: string } }).error.message).toMatch(/more than its open balance/);
    expect((await detail(bill.id)).amountPaid).toBe('0.00');

    const rejected = await newBill();
    await app(['bills:update']).request(`/api/bills/${rejected.id}/reject`, json('PATCH', { reason: 'Duplicate' }));
    expect((await pay(rejected.id, { amount: '10.00', date: '2026-03-20' })).status).toBe(400);

    expect((await pay('bil_nobody', { amount: '10.00', date: '2026-03-20' })).status).toBe(404);
    expect((await pay(bill.id, { amount: '10.00', date: '2026-03-20' }, ['bills:update'])).status).toBe(403);
    expect((await pay(bill.id, { date: '2026-03-20' })).status).toBe(400);
  });
});

describe('the account a bill line without an account posts to', () => {
  const defaultFor = async (contactId?: string) => {
    const res = await app(['bills:read']).request(
      `/api/bills/default-expense-account${contactId ? `?contactId=${contactId}` : ''}`,
      { headers: { 'X-Accounting-Entity-Id': entityId } },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { defaultExpenseAccount: { id: string; code: string; name: string } | null } }).data.defaultExpenseAccount;
  };

  it("is the entity's general expense account, until the supplier has a default of its own", async () => {
    const general = await defaultFor();
    expect(general).toMatchObject({ code: '4600' });

    const bill = await newBill();
    const read = await app(['bills:read']).request(`/api/bills/${bill.id}`);
    expect(((await read.json()) as { data: { defaultExpenseAccount: unknown } }).data.defaultExpenseAccount).toEqual(general);

    const [supplierAccount] = (await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId))).filter(
      (a) => a.type === 'expense' && a.code !== '4600',
    );
    await db.update(schema.parties).set({ defaultExpenseAccountId: supplierAccount!.id }).where(eq(schema.parties.id, 'acn_bill_vendor'));
    const own = { id: supplierAccount!.id, code: supplierAccount!.code, name: supplierAccount!.name };
    expect(await defaultFor('acn_bill_vendor')).toEqual(own);
    expect(await defaultFor('acn_bill_other')).toEqual(general);
    const again = await app(['bills:read']).request(`/api/bills/${bill.id}`);
    expect(((await again.json()) as { data: { defaultExpenseAccount: unknown } }).data.defaultExpenseAccount).toEqual(own);
    await db.update(schema.parties).set({ defaultExpenseAccountId: null }).where(eq(schema.parties.id, 'acn_bill_vendor'));
  });

  it('needs bills:read', async () => {
    expect((await app([]).request('/api/bills/default-expense-account', { headers: { 'X-Accounting-Entity-Id': entityId } })).status).toBe(403);
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
