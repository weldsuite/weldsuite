/**
 * The wrapping `parties` row of a supplier company or person holds a TIN and
 * a vendor ACH account number as ciphertext (`sensitiveEncrypted`). The CRM
 * only ever reads the party id, so none of its endpoints may carry that column
 * (or its blob), and the party sync a company/person write triggers must leave
 * it in place.
 *
 * pglite-backed, like integration.test.ts next to it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { companiesRoutes } from './index';
import { peopleRoutes } from '../people';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const BLOB = 'ct-party-tin-blob-crm-5e21';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_user_test_default',
    userId: 'user_test_default',
    name: 'Test User',
    role: 'MEMBER',
  });
}, 60_000);

function expectNoCiphertext(text: string, context: string) {
  expect(text, `${context}: blob`).not.toContain(BLOB);
  expect(text, `${context}: column`).not.toContain('sensitiveEncrypted');
}

describe('CRM endpoints never carry a party ciphertext', () => {
  it('companies: list, get, export and update leave sensitiveEncrypted out and in place', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: {
        permissions: permissions('companies:create', 'companies:read', 'companies:update', 'companies:scope:all'),
        tenantDb: db,
      },
    });

    const created = await request('/api/companies', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Vendor Co With TIN', isSupplier: true }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.companyId, id));
    expect(party, 'a supplier company gets a wrapping party').toBeDefined();
    await db.update(schema.parties).set({ sensitiveEncrypted: BLOB, tinLast4: '4321' }).where(eq(schema.parties.id, party!.id));

    expectNoCiphertext(await (await request(`/api/companies/${id}`)).text(), 'get');
    expectNoCiphertext(await (await request('/api/companies?limit=50')).text(), 'list');
    expectNoCiphertext(await (await request('/api/companies/export?search=Vendor')).text(), 'export');

    const patched = await request(`/api/companies/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Vendor Co Renamed' }),
    });
    expect(patched.status).toBe(200);
    expectNoCiphertext(await patched.text(), 'patch');

    // The party sync a company write runs must not clear the blob.
    const [after] = await db.select().from(schema.parties).where(eq(schema.parties.id, party!.id));
    expect(after?.sensitiveEncrypted).toBe(BLOB);
    expect(after?.displayName).toBe('Vendor Co Renamed');
  });

  it('people: list, get and update leave sensitiveEncrypted out and in place', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: {
        permissions: permissions('people:create', 'people:read', 'people:update', 'people:scope:all'),
        tenantDb: db,
      },
    });

    const created = await request('/api/people', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ firstName: 'Sam', lastName: 'Sole', isSupplier: true }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.personId, id));
    expect(party, 'a supplier person gets a wrapping party').toBeDefined();
    await db.update(schema.parties).set({ sensitiveEncrypted: BLOB, tinLast4: '8765' }).where(eq(schema.parties.id, party!.id));

    expectNoCiphertext(await (await request(`/api/people/${id}`)).text(), 'get');
    expectNoCiphertext(await (await request('/api/people?limit=50')).text(), 'list');

    const patched = await request(`/api/people/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ firstName: 'Samuel' }),
    });
    expect(patched.status).toBe(200);
    expectNoCiphertext(await patched.text(), 'patch');

    const [after] = await db.select().from(schema.parties).where(eq(schema.parties.id, party!.id));
    expect(after?.sensitiveEncrypted).toBe(BLOB);
  });
});
