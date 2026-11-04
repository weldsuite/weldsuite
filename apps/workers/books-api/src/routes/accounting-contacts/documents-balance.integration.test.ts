/**
 * The read-only views of a contact's documents and the role routes:
 * GET /:id/invoices, /:id/bills, /:id/balance (receivable and payable, the
 * overdue part of each), POST /:id/promote-role and the no-op
 * POST /import-from-crm. Refusals included.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountingContactsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
const CONTACT = 'acn_docs_balance';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values({ id: 'ent_docs', name: 'Docs BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
  await db.insert(schema.parties).values({ id: CONTACT, kind: 'company', displayName: 'Docs Supplier', role: 'none' });
  const past = new Date('2020-01-31T00:00:00Z');
  const future = new Date('2099-01-31T00:00:00Z');
  await db.insert(schema.invoices).values([
    {
      id: 'inv_docs_1',
      entityId: 'ent_docs',
      invoiceNumber: 'INV-1',
      contactId: CONTACT,
      issueDate: new Date('2020-01-01T00:00:00Z'),
      dueDate: past,
      total: '121.00',
      balanceDue: '121.00',
    },
    {
      id: 'inv_docs_2',
      entityId: 'ent_docs',
      invoiceNumber: 'INV-2',
      contactId: CONTACT,
      issueDate: new Date('2026-02-01T00:00:00Z'),
      dueDate: future,
      total: '50.00',
      balanceDue: '50.00',
    },
    {
      id: 'inv_docs_gone',
      entityId: 'ent_docs',
      invoiceNumber: 'INV-3',
      contactId: CONTACT,
      issueDate: new Date('2026-03-01T00:00:00Z'),
      dueDate: past,
      total: '999.00',
      balanceDue: '999.00',
      deletedAt: new Date(),
    },
  ]);
  await db.insert(schema.bills).values({
    id: 'bil_docs_1',
    entityId: 'ent_docs',
    billNumber: 'B-1',
    contactId: CONTACT,
    issueDate: new Date('2020-01-01T00:00:00Z'),
    dueDate: past,
    total: '30.25',
    balanceDue: '30.25',
  });
}, 60_000);

function app(perms: string[]) {
  return createTestApp('/api/accounting-contacts', accountingContactsRoutes, {
    context: { permissions: permissions(...perms), tenantDb: db },
  });
}

describe('GET /:id/invoices and /:id/bills', () => {
  it('lists the live invoices of a contact, newest issue date first', async () => {
    const res = await app(['invoices:read']).request(`/api/accounting-contacts/${CONTACT}/invoices`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((row) => row.id)).toEqual(['inv_docs_2', 'inv_docs_1']);
  });

  it('lists the live bills of a contact', async () => {
    const res = await app(['invoices:read']).request(`/api/accounting-contacts/${CONTACT}/bills`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; total: string }> };
    expect(data).toHaveLength(1);
    expect(data[0]!.total).toBe('30.25');
  });

  it('answers an empty list for an unknown contact', async () => {
    const res = await app(['invoices:read']).request('/api/accounting-contacts/acn_nobody/bills');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('needs invoices:read', async () => {
    const res = await app([]).request(`/api/accounting-contacts/${CONTACT}/invoices`);
    expect(res.status).toBe(403);
  });
});

describe('GET /:id/balance', () => {
  it('sums what is open and what of it is overdue', async () => {
    const res = await app(['invoices:read']).request(`/api/accounting-contacts/${CONTACT}/balance`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { receivable: { totalOutstanding: string; totalOverdue: string }; payable: { totalOutstanding: string } };
    };
    expect(Number(data.receivable.totalOutstanding)).toBe(171);
    expect(Number(data.receivable.totalOverdue)).toBe(121);
    expect(Number(data.payable.totalOutstanding)).toBe(30.25);
  });

  it('answers zeros for a contact without documents', async () => {
    const res = await app(['invoices:read']).request('/api/accounting-contacts/acn_nobody/balance');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { receivable: { totalOutstanding: string } } };
    expect(data.receivable.totalOutstanding).toBe('0');
  });
});

describe('POST /:id/promote-role', () => {
  const promote = (id: string, body: unknown, perms = ['invoices:update']) =>
    app(perms).request(`/api/accounting-contacts/${id}/promote-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('moves the role forward only', async () => {
    let res = await promote(CONTACT, { promoteTo: 'supplier' });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ data: { id: CONTACT, role: 'supplier', changed: true } });

    res = await promote(CONTACT, { promoteTo: 'supplier' });
    expect(((await res.json()) as { data: { changed: boolean } }).data.changed).toBe(false);

    res = await promote(CONTACT, { promoteTo: 'customer' });
    expect(((await res.json()) as { data: { role: string } }).data.role).toBe('both');
    const [row] = await db.select().from(schema.parties).where(eq(schema.parties.id, CONTACT));
    expect(row?.role).toBe('both');
  });

  it('refuses an unknown role, an unknown party and a caller without invoices:update', async () => {
    expect((await promote(CONTACT, { promoteTo: 'owner' })).status).toBe(400);
    expect((await promote('acn_nobody', { promoteTo: 'customer' })).status).toBe(404);
    expect((await promote(CONTACT, { promoteTo: 'customer' }, ['invoices:read'])).status).toBe(403);
  });
});

describe('POST /import-from-crm', () => {
  it('imports nothing: contacts and customers are one table', async () => {
    const res = await app(['invoices:create']).request('/api/accounting-contacts/import-from-crm', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { imported: number } }).data.imported).toBe(0);
  });
});
