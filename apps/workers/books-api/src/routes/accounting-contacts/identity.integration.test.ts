/**
 * DB-backed tests for the identity a contact wraps: a company or person row
 * carries the email, phone, VAT/registration number and notes; the party
 * carries addresses, payment terms and the other accounting fields. Reads
 * merge both (TASK-691: these fields used to be dropped on save).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountingContactsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPerson } from '@weldsuite/crm-domain/people';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const ALL = ['invoices:read', 'invoices:create', 'invoices:update'];

function request(path: string, init?: { method?: string; body?: unknown }) {
  const { request: send } = createTestApp('/api/accounting-contacts', accountingContactsRoutes, {
    context: { permissions: permissions(...ALL), tenantDb: db },
  });
  return send(path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

interface ContactBody {
  id: string;
  name: string;
  kind: string | null;
  companyId: string | null;
  personId: string | null;
  role: string;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  vatNumber: string | null;
  registrationNumber: string | null;
  taxNumber: string | null;
  kvkNumber: string | null;
  notes: string | null;
  paymentTermsDays: number | null;
  currency: string | null;
  iban: string | null;
  billingAddress: Record<string, string> | null;
  shippingAddress: Record<string, string> | null;
}

async function json(res: Response): Promise<{ data: ContactBody }> {
  return (await res.json()) as { data: ContactBody };
}

describe('/api/accounting-contacts · wrapped identity', () => {
  it('a company contact stores email, phone, VAT, registration, notes, terms and both addresses', async () => {
    const res = await request('/api/accounting-contacts', {
      method: 'POST',
      body: {
        role: 'customer',
        name: 'Acme Holding BV',
        email: 'billing@acme.example',
        phone: '+31 20 123 4567',
        taxNumber: 'NL123456789B01',
        kvkNumber: '12345678',
        notes: 'Invoices to the finance team',
        paymentTermsDays: 14,
        currency: 'eur',
        iban: 'nl91 abna 0417 1643 00',
        // Legacy Dutch shape in, shared shape out.
        billingAddress: { street: 'Damrak', houseNumber: '1', postalCode: '1012 LG', city: 'Amsterdam', country: 'nl' },
        shippingAddress: { line1: '500 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', county: 'Travis' },
      },
    });
    expect(res.status).toBe(201);
    const { data: created } = await json(res);
    expect(created.kind).toBe('company');
    expect(created.companyId).toBeTruthy();
    expect(created.name).toBe('Acme Holding BV');
    expect(created.email).toBe('billing@acme.example');
    expect(created.vatNumber).toBe('NL123456789B01');

    const [company] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, created.companyId!))
      .limit(1);
    expect(company?.email).toBe('billing@acme.example');
    expect(company?.phone).toBe('+31 20 123 4567');
    expect(company?.vatNumber).toBe('NL123456789B01');
    expect(company?.registrationNumber).toBe('12345678');
    expect(company?.notes).toBe('Invoices to the finance team');
    expect(company?.isSupplier).toBe(false);

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, created.id)).limit(1);
    expect(party?.paymentTerms).toBe('14');
    expect(party?.currency).toBe('EUR');
    expect(party?.iban).toBe('NL91ABNA0417164300');
    expect(party?.billingAddress).toEqual({ line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' });

    const get = await request(`/api/accounting-contacts/${created.id}`);
    expect(get.status).toBe(200);
    const { data } = await json(get);
    expect(data).toMatchObject({
      name: 'Acme Holding BV',
      companyName: 'Acme Holding BV',
      email: 'billing@acme.example',
      phone: '+31 20 123 4567',
      vatNumber: 'NL123456789B01',
      registrationNumber: '12345678',
      taxNumber: 'NL123456789B01',
      kvkNumber: '12345678',
      notes: 'Invoices to the finance team',
      paymentTermsDays: 14,
      billingAddress: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
      shippingAddress: { line1: '500 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', county: 'Travis' },
    });
  });

  it('a separate company name becomes the legal name; `name` stays the display name', async () => {
    const res = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { name: 'Acme', companyName: 'Acme Holding B.V.' },
    });
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data.name).toBe('Acme');
    expect(data.companyName).toBe('Acme Holding B.V.');
  });

  it('a person contact stores its names, email and phone on a people row', async () => {
    const res = await request('/api/accounting-contacts', {
      method: 'POST',
      body: {
        name: 'Mary Ann Smith',
        lastName: 'Smith',
        email: 'mary@example.com',
        phone: '+1 512 555 0100',
        paymentTermsDays: 30,
      },
    });
    expect(res.status).toBe(201);
    const { data: created } = await json(res);
    expect(created.kind).toBe('person');
    expect(created.personId).toBeTruthy();
    expect(created.companyId).toBeNull();

    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, created.personId!)).limit(1);
    expect(person?.firstName).toBe('Mary Ann');
    expect(person?.lastName).toBe('Smith');
    expect(person?.directPhone).toBe('+1 512 555 0100');

    const { data } = await json(await request(`/api/accounting-contacts/${created.id}`));
    expect(data).toMatchObject({
      name: 'Mary Ann Smith',
      firstName: 'Mary Ann',
      lastName: 'Smith',
      companyName: null,
      email: 'mary@example.com',
      phone: '+1 512 555 0100',
      vatNumber: null,
      paymentTermsDays: 30,
    });
  });

  it('a VAT number makes the contact a company even with first/last names', async () => {
    const res = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { name: 'Jan Jansen', firstName: 'Jan', lastName: 'Jansen', vatNumber: 'NL001234567B01' },
    });
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data.kind).toBe('company');
    expect(data.vatNumber).toBe('NL001234567B01');
  });

  it('a person contact refuses a VAT number on update', async () => {
    const { data: created } = await json(
      await request('/api/accounting-contacts', {
        method: 'POST',
        body: { name: 'Pat Person', firstName: 'Pat', lastName: 'Person' },
      }),
    );
    const res = await request(`/api/accounting-contacts/${created.id}`, {
      method: 'PATCH',
      body: { vatNumber: 'NL123456789B01' },
    });
    expect(res.status).toBe(400);
  });

  it('reuses a mail-only person with the same email instead of failing', async () => {
    const guest = await createPerson(db, { email: 'guest@example.com', firstName: 'Guest', inCrm: false });

    const res = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { name: 'Guest Example', firstName: 'Guest', lastName: 'Example', email: 'GUEST@example.com', phone: '555-0101' },
    });
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data.personId).toBe(guest.id);
    expect(data.phone).toBe('555-0101');

    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, guest.id)).limit(1);
    expect(person?.inCrm).toBe(true);
    expect(person?.lastName).toBe('Example');

    // A second contact for the same person is a duplicate.
    const again = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { name: 'Guest Again', firstName: 'Guest', lastName: 'Again', email: 'guest@example.com' },
    });
    expect(again.status).toBe(409);
    const conflict = (await again.json()) as { error: { details: { contactId: string } } };
    expect(conflict.error.details.contactId).toBe(data.id);
  });

  it('update writes identity fields to the company and clears blanked ones', async () => {
    const { data: created } = await json(
      await request('/api/accounting-contacts', {
        method: 'POST',
        body: { name: 'Clear Me BV', email: 'old@clear.example', phone: '123', notes: 'keep?' },
      }),
    );

    const res = await request(`/api/accounting-contacts/${created.id}`, {
      method: 'PUT',
      body: {
        name: 'Clear Me Renamed BV',
        email: '',
        phone: '456',
        notes: '',
        taxNumber: 'NL999999999B99',
        paymentTermsDays: 45,
        billingAddress: { line1: '1 Infinite Loop', city: 'Cupertino', state: 'CA', postalCode: '95014', country: 'US' },
      },
    });
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({
      name: 'Clear Me Renamed BV',
      email: null,
      phone: '456',
      notes: null,
      vatNumber: 'NL999999999B99',
      paymentTermsDays: 45,
      billingAddress: { line1: '1 Infinite Loop', city: 'Cupertino', state: 'CA', postalCode: '95014', country: 'US' },
    });

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, created.id)).limit(1);
    expect(party?.displayName).toBe('Clear Me Renamed BV');
    expect(party?.companyId).toBe(created.companyId);
  });

  it('the first update of a legacy party with no identity creates and links one', async () => {
    const id = generateId('acn');
    await db.insert(schema.parties).values({
      id,
      displayName: 'Legacy Supplier BV',
      role: 'supplier',
      paymentTerms: '30',
    });

    const before = await json(await request(`/api/accounting-contacts/${id}`));
    expect(before.data.kind).toBeNull();
    expect(before.data.name).toBe('Legacy Supplier BV');
    expect(before.data.email).toBeNull();
    expect(before.data.paymentTermsDays).toBe(30);

    const res = await request(`/api/accounting-contacts/${id}`, {
      method: 'PATCH',
      body: { email: 'ap@legacy.example', taxNumber: 'NL111111111B11' },
    });
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.kind).toBe('company');
    expect(data.companyId).toBeTruthy();
    expect(data.name).toBe('Legacy Supplier BV');
    expect(data.email).toBe('ap@legacy.example');
    expect(data.vatNumber).toBe('NL111111111B11');
    expect(data.role).toBe('supplier');

    const [company] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, data.companyId!))
      .limit(1);
    expect(company?.name).toBe('Legacy Supplier BV');
    expect(company?.email).toBe('ap@legacy.example');
  });

  it('GET / returns the merged identity fields for every row', async () => {
    const { data: company } = await json(
      await request('/api/accounting-contacts', {
        method: 'POST',
        body: { role: 'supplier', name: 'Listed Vendor Inc', email: 'ap@vendor.example', vatNumber: 'US-EIN-1' },
      }),
    );
    const { data: person } = await json(
      await request('/api/accounting-contacts', {
        method: 'POST',
        body: { role: 'both', name: 'Listed Person', firstName: 'Listed', lastName: 'Person', email: 'listed@person.example' },
      }),
    );

    const res = await request('/api/accounting-contacts?role=supplier&pageSize=100');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ContactBody[]; pagination: { totalCount: number } };
    const byId = new Map(body.data.map((row) => [row.id, row]));
    expect(byId.get(company.id)).toMatchObject({ name: 'Listed Vendor Inc', email: 'ap@vendor.example', vatNumber: 'US-EIN-1' });
    expect(byId.get(person.id)).toMatchObject({ name: 'Listed Person', email: 'listed@person.example', firstName: 'Listed' });
    expect(body.data.every((row) => row.role === 'supplier' || row.role === 'both')).toBe(true);

    const search = (await (await request('/api/accounting-contacts?search=listed%20vendor')).json()) as {
      data: ContactBody[];
    };
    expect(search.data.map((row) => row.id)).toEqual([company.id]);
  });
});
