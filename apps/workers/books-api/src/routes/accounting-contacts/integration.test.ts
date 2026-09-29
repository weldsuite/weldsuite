/**
 * DB-backed integration tests for /api/accounting-contacts.
 *
 * The platform contact form posts `name` (not `fullName`), `taxNumber` and
 * blank strings for untouched optional inputs. The route accepts that
 * payload and returns rows with a `name` the list, detail and invoice
 * customer picker can render.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountingContactsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app(perms: string[]) {
  return createTestApp('/api/accounting-contacts', accountingContactsRoutes, {
    context: { permissions: permissions(...perms), tenantDb: db },
  });
}

/** The exact body the WeldBooks "New customer" form sent during QA. */
const formPayload = {
  role: 'customer',
  name: 'Acme Test BV',
  companyName: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  taxNumber: 'NL123456789B01',
  kvkNumber: '',
  iban: '',
  bic: '',
  paymentTermsDays: 30,
  notes: '',
};

describe('/api/accounting-contacts · pglite integration', () => {
  it('POST / accepts the platform form payload (name, blank strings)', async () => {
    const { request } = app(['invoices:create']);
    const res = await request('/api/accounting-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formPayload),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string; role: string } };
    expect(body.data.name).toBe('Acme Test BV');
    expect(body.data.role).toBe('customer');

    const [row] = await db
      .select()
      .from(schema.parties)
      .where(eq(schema.parties.id, body.data.id))
      .limit(1);
    expect(row?.displayName).toBe('Acme Test BV');
    expect(row?.role).toBe('customer');
  });

  it('GET / and GET /:id return the name the UI renders', async () => {
    const create = await app(['invoices:create']).request('/api/accounting-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...formPayload, name: 'Listed Customer BV' }),
    });
    const { data: created } = (await create.json()) as { data: { id: string } };

    const { request } = app(['invoices:read']);
    const listRes = await request('/api/accounting-contacts?role=customer');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: Array<{ id: string; name: string }> };
    expect(list.data.find((r) => r.id === created.id)?.name).toBe('Listed Customer BV');

    const getRes = await request(`/api/accounting-contacts/${created.id}`);
    const detail = (await getRes.json()) as { data: { name: string } };
    expect(detail.data.name).toBe('Listed Customer BV');
  });

  it('PATCH /:id renames via `name`', async () => {
    const create = await app(['invoices:create']).request('/api/accounting-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formPayload),
    });
    const { data: created } = (await create.json()) as { data: { id: string } };

    const res = await app(['invoices:update']).request(`/api/accounting-contacts/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...formPayload, name: 'Renamed BV' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data.name).toBe('Renamed BV');

    const [row] = await db
      .select()
      .from(schema.parties)
      .where(eq(schema.parties.id, created.id))
      .limit(1);
    expect(row?.displayName).toBe('Renamed BV');
  });

  it('POST / returns a standard error body when the name is missing', async () => {
    const { request } = app(['invoices:create']);
    const res = await request('/api/accounting-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...formPayload, name: '' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('fullName');
  });

  it('POST / still rejects a malformed email', async () => {
    const { request } = app(['invoices:create']);
    const res = await request('/api/accounting-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...formPayload, email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });
});
