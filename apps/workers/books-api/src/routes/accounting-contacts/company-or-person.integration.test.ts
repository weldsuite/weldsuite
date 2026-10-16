/**
 * DB-backed tests for what a contact is: a company or a person. The client
 * picks the kind, can link an existing CRM company or person instead of
 * creating one, and gives a company contact a contact person (the company's
 * CRM billing contact).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { accountingContactsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createCompany, updateCompany } from '@weldsuite/crm-domain/companies';
import { createPerson } from '@weldsuite/crm-domain/people';
import { loadContactSnapshot } from '../../lib/contact-snapshot';

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

interface ContactPersonBody {
  personId: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
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
  vatNumber: string | null;
  contactPerson: ContactPersonBody | null;
}

async function json(res: Response): Promise<{ data: ContactBody }> {
  return (await res.json()) as { data: ContactBody };
}

async function create(body: Record<string, unknown>): Promise<ContactBody> {
  const res = await request('/api/accounting-contacts', { method: 'POST', body });
  expect(res.status).toBe(201);
  return (await json(res)).data;
}

async function billingLinks(companyId: string) {
  return db
    .select()
    .from(schema.personCompanies)
    .where(and(eq(schema.personCompanies.companyId, companyId), isNull(schema.personCompanies.endedAt)));
}

describe('/api/accounting-contacts · company or person', () => {
  it('honours the chosen kind over what the fields suggest', async () => {
    // Without a kind, first and last names alone make a person.
    const company = await create({ kind: 'company', name: 'Jansen Installaties', firstName: 'Jan', lastName: 'Jansen' });
    expect(company.kind).toBe('company');
    expect(company.companyName).toBe('Jansen Installaties');

    const person = await create({ kind: 'person', name: 'Pat Doe', firstName: 'Pat', lastName: 'Doe' });
    expect(person.kind).toBe('person');
    expect(person.firstName).toBe('Pat');
  });

  it('refuses a VAT number or a contact person on a person contact', async () => {
    const vat = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { kind: 'person', name: 'Sam Sole', firstName: 'Sam', vatNumber: 'NL123456789B01' },
    });
    expect(vat.status).toBe(400);

    const contactPerson = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { kind: 'person', name: 'Sam Sole', firstName: 'Sam', contactPerson: { firstName: 'Other' } },
    });
    expect(contactPerson.status).toBe(400);
  });

  it('links an existing CRM company instead of creating another, and only once', async () => {
    const crm = await createCompany(db, { name: 'Existing Holding BV', tradingName: 'Existing', email: 'crm@existing.example' });
    const before = await db.select({ id: schema.companies.id }).from(schema.companies);

    const contact = await create({
      kind: 'company',
      companyId: crm.id,
      role: 'customer',
      name: 'Existing',
      companyName: 'Existing Holding BV',
      vatNumber: 'NL555555555B01',
    });
    expect(contact.companyId).toBe(crm.id);
    expect(contact.name).toBe('Existing');
    // CRM fields the form left blank are kept; the ones it sent are written to the company.
    expect(contact.email).toBe('crm@existing.example');
    expect(contact.vatNumber).toBe('NL555555555B01');

    const after = await db.select({ id: schema.companies.id }).from(schema.companies);
    expect(after).toHaveLength(before.length);

    const again = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { kind: 'company', companyId: crm.id, name: 'Existing' },
    });
    expect(again.status).toBe(409);
    const conflict = (await again.json()) as { error: { details: { contactId: string } } };
    expect(conflict.error.details.contactId).toBe(contact.id);
  });

  it('links an existing CRM person, bringing a mail-only one into the CRM', async () => {
    const guest = await createPerson(db, { firstName: 'Mila', email: 'mila@example.com', inCrm: false });
    const contact = await create({ kind: 'person', personId: guest.id, name: 'Mila Visser', firstName: 'Mila', lastName: 'Visser' });
    expect(contact.personId).toBe(guest.id);
    expect(contact.lastName).toBe('Visser');

    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, guest.id)).limit(1);
    expect(person?.inCrm).toBe(true);
  });

  it('refuses linking a record of the other kind, or one that does not exist', async () => {
    const crm = await createCompany(db, { name: 'Wrong Kind BV' });
    const wrongKind = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { kind: 'person', companyId: crm.id, name: 'Wrong Kind' },
    });
    expect(wrongKind.status).toBe(400);

    const missing = await request('/api/accounting-contacts', {
      method: 'POST',
      body: { kind: 'company', companyId: 'company_missing', name: 'Missing' },
    });
    expect(missing.status).toBe(400);
  });

  it('a new contact person becomes the company\'s CRM billing contact', async () => {
    const contact = await create({
      kind: 'company',
      name: 'Billing Co',
      companyName: 'Billing Co BV',
      contactPerson: { firstName: 'Fleur', lastName: 'de Vries', email: 'fleur@billing.example', phone: '' },
    });
    expect(contact.contactPerson).toMatchObject({
      name: 'Fleur de Vries',
      firstName: 'Fleur',
      lastName: 'de Vries',
      email: 'fleur@billing.example',
      phone: null,
    });
    // The person is the contact person, not the contact.
    expect(contact.firstName).toBeNull();

    const links = await billingLinks(contact.companyId!);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ personId: contact.contactPerson!.personId, role: 'billing', isPrimary: true });
  });

  it('changing the contact person moves the billing role; removing it keeps the person at the company', async () => {
    const contact = await create({
      kind: 'company',
      name: 'Switch Co',
      contactPerson: { firstName: 'First', email: 'first@switch.example' },
    });
    const first = contact.contactPerson!.personId;
    const second = await createPerson(db, { firstName: 'Second', email: 'second@switch.example' });

    const res = await request(`/api/accounting-contacts/${contact.id}`, {
      method: 'PATCH',
      body: { contactPerson: { personId: second.id, phone: '+31 6 1234 5678' } },
    });
    expect(res.status).toBe(200);
    const { data: switched } = await json(res);
    expect(switched.contactPerson).toMatchObject({ personId: second.id, phone: '+31 6 1234 5678' });

    const links = await billingLinks(contact.companyId!);
    expect(links.find((l) => l.personId === first)?.role).toBeNull();
    expect(links.find((l) => l.personId === second.id)?.role).toBe('billing');

    const cleared = await json(
      await request(`/api/accounting-contacts/${contact.id}`, { method: 'PATCH', body: { contactPerson: null } }),
    );
    expect(cleared.data.contactPerson).toBeNull();
    expect(await billingLinks(contact.companyId!)).toHaveLength(2);
  });

  it('editing the contact person writes to that CRM person', async () => {
    const contact = await create({ kind: 'company', name: 'Edit Co', contactPerson: { firstName: 'Old', email: 'old@edit.example' } });
    const personId = contact.contactPerson!.personId;
    const { data } = await json(
      await request(`/api/accounting-contacts/${contact.id}`, {
        method: 'PATCH',
        body: { contactPerson: { personId, firstName: 'New', lastName: 'Name', email: '' } },
      }),
    );
    expect(data.contactPerson).toMatchObject({ personId, name: 'New Name', email: null });
  });

  it('a contact person with the email of a CRM person reuses that person', async () => {
    const known = await createPerson(db, { firstName: 'Known', email: 'known@example.com' });
    const contact = await create({
      kind: 'company',
      name: 'Reuse Co',
      contactPerson: { firstName: 'Known', lastName: 'Person', email: 'KNOWN@example.com' },
    });
    expect(contact.contactPerson?.personId).toBe(known.id);
    expect(contact.contactPerson?.lastName).toBe('Person');
  });

  it('a contact keeps its kind', async () => {
    const contact = await create({ kind: 'company', name: 'Fixed Kind BV' });
    const res = await request(`/api/accounting-contacts/${contact.id}`, {
      method: 'PATCH',
      body: { kind: 'person', firstName: 'Not', lastName: 'Allowed' },
    });
    expect(res.status).toBe(400);
  });

  it('lists the contacts of one kind', async () => {
    const company = await create({ kind: 'company', name: 'Kind Filter BV' });
    const person = await create({ kind: 'person', name: 'Kind Filter', firstName: 'Kind', lastName: 'Filter' });
    const res = await request('/api/accounting-contacts?kind=person&search=kind%20filter');
    const body = (await res.json()) as { data: ContactBody[] };
    expect(body.data.map((row) => row.id)).toEqual([person.id]);
    expect(body.data.some((row) => row.id === company.id)).toBe(false);
  });

  it('documents go to the contact person when the company has no email address', async () => {
    const contact = await create({
      kind: 'company',
      name: 'No Email BV',
      contactPerson: { firstName: 'Ap', email: 'ap@noemail.example' },
    });
    expect((await loadContactSnapshot(db, contact.id)).email).toBe('ap@noemail.example');

    await request(`/api/accounting-contacts/${contact.id}`, { method: 'PATCH', body: { email: 'invoices@noemail.example' } });
    expect((await loadContactSnapshot(db, contact.id)).email).toBe('invoices@noemail.example');
  });

  it('a CRM rename follows to the contact, and the supplier flag adds the supplier role', async () => {
    const contact = await create({
      kind: 'company',
      role: 'customer',
      name: 'Renamed In CRM BV',
      billingAddress: { line1: 'Billing street 1', city: 'Utrecht', country: 'NL' },
    });
    await updateCompany(db, contact.companyId!, {
      name: 'Renamed In CRM Holding BV',
      tradingName: '',
      isSupplier: true,
      primaryAddress: { line1: 'Head office 9', city: 'Amsterdam', country: 'NL' },
    });

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, contact.id)).limit(1);
    expect(party?.displayName).toBe('Renamed In CRM Holding BV');
    expect(party?.role).toBe('both');
    expect(party?.billingAddress).toMatchObject({ line1: 'Billing street 1', city: 'Utrecht' });
  });
});
