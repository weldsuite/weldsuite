/**
 * Deleting a contact is only for one the books never used; everything else is
 * archived (hidden from lists and pickers, history untouched). TASK-1119.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountingContactsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const ALL = ['invoices:read', 'invoices:create', 'invoices:update', 'customers:delete', 'customers:update'];

function request(path: string, init?: { method?: string; body?: unknown; perms?: string[] }) {
  const { request: send } = createTestApp('/api/accounting-contacts', accountingContactsRoutes, {
    context: { permissions: permissions(...(init?.perms ?? ALL)), tenantDb: db },
  });
  return send(path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function createContact(name: string): Promise<string> {
  const res = await request('/api/accounting-contacts', { method: 'POST', body: { name, role: 'customer' } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

async function errorOf(res: Response) {
  return ((await res.json()) as {
    error: { code: string; message: string; details?: { code?: string; references?: Record<string, number>; openBalance?: boolean; canArchive?: boolean } };
  }).error;
}

async function listNames(query = ''): Promise<string[]> {
  const res = await request(`/api/accounting-contacts${query}`);
  return ((await res.json()) as { data: Array<{ name: string }> }).data.map((c) => c.name);
}

describe('DELETE /api/accounting-contacts/:id', () => {
  it('deletes a contact nothing refers to', async () => {
    const id = await createContact('Never Used BV');
    const res = await request(`/api/accounting-contacts/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await request(`/api/accounting-contacts/${id}`)).status).toBe(404);
  });

  it('refuses when an invoice refers to the contact, naming what it is used by', async () => {
    const id = await createContact('Invoiced BV');
    await db.insert(schema.invoices).values({
      id: generateId('inv'),
      entityId: 'ent_x',
      contactId: id,
      status: 'sent',
      issueDate: new Date(),
      dueDate: new Date(),
    });
    await db.insert(schema.invoices).values({
      id: generateId('inv'),
      entityId: 'ent_x',
      contactId: id,
      status: 'draft',
      issueDate: new Date(),
      dueDate: new Date(),
    });

    const res = await request(`/api/accounting-contacts/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('2 invoices');
    expect(error.message).toContain('Archive it instead');
    expect(error.details).toMatchObject({ code: 'CONTACT_IN_USE', references: { invoices: 2 }, canArchive: true });

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, id));
    expect(party?.deletedAt).toBeNull();
  });

  it('refuses when a bill refers to the contact', async () => {
    const id = await createContact('Billed BV');
    await db.insert(schema.bills).values({
      id: generateId('bil'),
      entityId: 'ent_x',
      contactId: id,
      billNumber: 'B-1',
      status: 'draft',
      issueDate: new Date(),
      dueDate: new Date(),
    });
    const res = await request(`/api/accounting-contacts/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details?.references).toEqual({ bills: 1 });
  });

  it('refuses for a payment, a journal line, a payment run and a recurring invoice', async () => {
    const payment = await createContact('Paid BV');
    await db.insert(schema.payments).values({
      id: generateId('pay'),
      entityId: 'ent_x',
      type: 'sent',
      amount: '5.00',
      date: new Date(),
      contactId: payment,
    });
    expect((await errorOf(await request(`/api/accounting-contacts/${payment}`, { method: 'DELETE' }))).details?.references).toEqual({ payments: 1 });

    const line = await createContact('Ledger BV');
    await db.insert(schema.journalLines).values({
      id: generateId('jl'),
      entityId: 'ent_x',
      journalEntryId: 'je_x',
      accountId: 'acc_x',
      contactId: line,
    });
    expect((await errorOf(await request(`/api/accounting-contacts/${line}`, { method: 'DELETE' }))).details?.references).toEqual({ journalLines: 1 });

    const run = await createContact('Run BV');
    await db.insert(schema.paymentRuns).values({
      id: generateId('prn'),
      entityId: 'ent_x',
      bankAccountId: 'bka_x',
      method: 'check',
      paymentDate: '2026-02-01',
      items: [{ billId: 'bil_x', amount: 10, partyId: run }],
    });
    expect((await errorOf(await request(`/api/accounting-contacts/${run}`, { method: 'DELETE' }))).details?.references).toEqual({ paymentRuns: 1 });
  });

  it('refuses for an open balance even with no document rows', async () => {
    const id = await createContact('Balance BV');
    await db.update(schema.parties).set({ outstandingBalance: '12.50' }).where(eq(schema.parties.id, id));
    const res = await request(`/api/accounting-contacts/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).details).toMatchObject({ code: 'CONTACT_IN_USE', openBalance: true });
  });

  it('is guarded by the customer/supplier delete permissions, not the invoice ones', async () => {
    const id = await createContact('Guarded BV');
    const invoicesOnly = await request(`/api/accounting-contacts/${id}`, {
      method: 'DELETE',
      perms: ['invoices:read', 'invoices:delete'],
    });
    expect(invoicesOnly.status).toBe(403);
    const supplier = await request(`/api/accounting-contacts/${id}`, { method: 'DELETE', perms: ['suppliers:delete'] });
    expect(supplier.status).toBe(204);
  });
});

describe('archiving contacts', () => {
  it('archives and unarchives, hiding the contact from the default list', async () => {
    const id = await createContact('Archivable BV');
    await createContact('Still Active BV');

    const archived = await request(`/api/accounting-contacts/${id}/archive`, { method: 'POST' });
    expect(archived.status).toBe(200);
    const body = (await archived.json()) as { data: { archivedAt: string | null; status: string } };
    expect(body.data.status).toBe('archived');
    expect(body.data.archivedAt).toBeTruthy();

    expect(await listNames()).not.toContain('Archivable BV');
    expect(await listNames()).toContain('Still Active BV');
    expect(await listNames('?archived=only')).toEqual(['Archivable BV']);
    expect(await listNames('?archived=include')).toEqual(expect.arrayContaining(['Archivable BV', 'Still Active BV']));

    // Idempotent, and the history stays: an archived contact is still readable by id.
    expect((await request(`/api/accounting-contacts/${id}/archive`, { method: 'POST' })).status).toBe(200);
    expect((await request(`/api/accounting-contacts/${id}`)).status).toBe(200);

    const restored = await request(`/api/accounting-contacts/${id}/unarchive`, { method: 'POST' });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { data: { archivedAt: string | null; status: string } }).data).toMatchObject({
      archivedAt: null,
      status: 'active',
    });
    expect(await listNames()).toContain('Archivable BV');

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['archived', 'unarchived']));
  });

  it('archiving a used contact works where deleting is refused', async () => {
    const id = await createContact('Used And Archived BV');
    await db.insert(schema.invoices).values({
      id: generateId('inv'),
      entityId: 'ent_x',
      contactId: id,
      status: 'paid',
      issueDate: new Date(),
      dueDate: new Date(),
    });
    expect((await request(`/api/accounting-contacts/${id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await request(`/api/accounting-contacts/${id}/archive`, { method: 'POST' })).status).toBe(200);
  });

  it('needs an update permission and 404s for an unknown contact', async () => {
    const id = await createContact('Permission BV');
    expect((await request(`/api/accounting-contacts/${id}/archive`, { method: 'POST', perms: ['invoices:read'] })).status).toBe(403);
    expect((await request('/api/accounting-contacts/acn_missing/archive', { method: 'POST' })).status).toBe(404);
  });
});
