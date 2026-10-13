/**
 * A new person contact whose email matches an existing CRM person is attached
 * to that person only when it is a bare mail identity or the same name. Any
 * other match is refused with the person's name so the user chooses: link to
 * them, or create a separate person. TIN and bank data never go onto a person
 * nobody picked. TASK-1111.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { accountingContactsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPerson } from '@weldsuite/crm-domain/people';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const env = { DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32) };

function post(body: Record<string, unknown>) {
  const { request } = createTestApp('/api/accounting-contacts', accountingContactsRoutes, {
    context: { permissions: permissions('invoices:read', 'invoices:create', 'invoices:update'), tenantDb: db },
    env,
  });
  return request('/api/accounting-contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface Created {
  data: { id: string; personId: string | null; name: string; tinLast4?: string | null };
}
interface Failure {
  error: { code: string; message: string; details?: { code?: string; existingPerson?: { id: string; name: string; email: string }; contactId?: string } };
}

async function peopleWithEmail(email: string) {
  const rows = await db.select().from(schema.people);
  return rows.filter((p) => p.email?.toLowerCase() === email.toLowerCase());
}

describe('creating a person contact with an email a CRM person already has', () => {
  it('reuses a bare mail identity (no name) silently', async () => {
    const bare = await createPerson(db, { email: 'bare@example.com' });
    const res = await post({ name: 'Bea Bare', firstName: 'Bea', lastName: 'Bare', email: 'bare@example.com' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Created;
    expect(data.personId).toBe(bare.id);
    expect(await peopleWithEmail('bare@example.com')).toHaveLength(1);
  });

  it('reuses a person with the same name, whatever the case', async () => {
    const person = await createPerson(db, { email: 'same@example.com', firstName: 'Sam', lastName: 'Same' });
    const res = await post({ name: 'SAM SAME', firstName: 'sam', lastName: 'same', email: 'same@example.com' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Created).data.personId).toBe(person.id);
  });

  it('refuses another name with a 409 that names the existing person, and attaches nothing', async () => {
    const other = await createPerson(db, { email: 'other@example.com', firstName: 'Olivia', lastName: 'Other' });
    const res = await post({
      name: 'Dave Different',
      firstName: 'Dave',
      lastName: 'Different',
      email: 'other@example.com',
      role: 'supplier',
      tinType: 'ssn',
      tin: '123-45-6789',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Failure;
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('Olivia Other');
    expect(body.error.details).toMatchObject({
      code: 'PERSON_EMAIL_EXISTS',
      existingPerson: { id: other.id, name: 'Olivia Other', email: 'other@example.com' },
    });

    // No contact, no TIN, and Olivia's record is untouched.
    const wrapped = await db.select().from(schema.parties).where(eq(schema.parties.personId, other.id));
    expect(wrapped).toHaveLength(0);
    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, other.id));
    expect(person?.firstName).toBe('Olivia');
    expect(person?.lastName).toBe('Other');
  });

  it('links to the person when the user picks them, keeping the person\'s own name', async () => {
    const other = await createPerson(db, { email: 'link@example.com', firstName: 'Lena', lastName: 'Link' });
    const res = await post({
      name: 'Dave Different',
      firstName: 'Dave',
      lastName: 'Different',
      email: 'link@example.com',
      phone: '555-0199',
      linkPersonId: other.id,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Created;
    expect(data.personId).toBe(other.id);
    expect(data.name).toBe('Lena Link');

    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, other.id));
    expect(person?.firstName).toBe('Lena');
    expect(person?.lastName).toBe('Link');
    // Only what the person did not have is filled in.
    expect(person?.directPhone).toBe('555-0199');
  });

  it('creates a separate person when the user asks for one', async () => {
    const other = await createPerson(db, { email: 'twin@example.com', firstName: 'Tina', lastName: 'Twin' });
    const res = await post({
      name: 'Tom Twin',
      firstName: 'Tom',
      lastName: 'Twin',
      email: 'twin@example.com',
      createSeparatePerson: true,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Created;
    expect(data.personId).not.toBeNull();
    expect(data.personId).not.toBe(other.id);
    expect(data.name).toBe('Tom Twin');
    expect(await peopleWithEmail('twin@example.com')).toHaveLength(2);
  });

  it('a person that another contact already wraps is a plain duplicate, not a choice', async () => {
    const first = await post({ name: 'Wrapped Wendy', firstName: 'Wrapped', lastName: 'Wendy', email: 'wrapped@example.com' });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as Created;

    const again = await post({ name: 'Someone Else', firstName: 'Someone', lastName: 'Else', email: 'wrapped@example.com' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as Failure).error.details?.contactId).toBe(firstBody.data.id);
  });

  it('refuses a link to a person that does not exist', async () => {
    const res = await post({ name: 'Ghost Link', firstName: 'Ghost', lastName: 'Link', linkPersonId: 'person_missing' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Failure).error.details).toMatchObject({ code: 'PERSON_NOT_FOUND' });
  });
});
