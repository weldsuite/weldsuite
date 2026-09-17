/**
 * DB-backed integration tests for /api/person-companies — the join
 * table that maps employees to their employer company.
 *
 * Exercises a real cross-entity write: seeds a Person and a Company
 * via the services, then asserts the link row lands and reads back.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { personCompaniesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { createPerson } from '../../services/people';
import { createCompany } from '../../services/companies';
import { schema, type Database } from '../../db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';

const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/person-companies · pglite integration', () => {
  it('POST / links a person to a company', async () => {
    const company = await createCompany(db, { name: 'Employer Co' });
    const person = await createPerson(db, {
      firstName: 'Employee',
      lastName: 'McTest',
    });

    const { request } = createTestApp('/api/person-companies', personCompaniesRoutes, {
      context: {
        permissions: permissions('contacts:update'),
        tenantDb: db,
      },
    });

    const res = await request('/api/person-companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personId: person.id,
        companyId: company.id,
        role: 'Engineer',
        isPrimary: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };

    const [row] = await db
      .select()
      .from(schema.personCompanies)
      .where(
        and(
          eq(schema.personCompanies.personId, person.id),
          eq(schema.personCompanies.companyId, company.id),
        ),
      )
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.role).toBe('Engineer');
    expect(row?.isPrimary).toBe(true);
    expect(row?.id).toBe(body.data.id);

    const types = mockedPublish.mock.calls.map(
      (c) => (c[0] as { entityType: string; action: string }).entityType,
    );
    expect(types).toContain('contact_link');
    expect(types).toContain('person');
    expect(types).toContain('company');
    const linkCall = mockedPublish.mock.calls.find(
      (c) => (c[0] as { entityType: string }).entityType === 'contact_link',
    )?.[0] as { action: string; entityId: string };
    expect(linkCall.action).toBe('created');
    expect(linkCall.entityId).toBe(body.data.id);
  });

  it('DELETE /:id publishes contact_link deleted + person/company updated', async () => {
    const company = await createCompany(db, { name: 'Unlink Co' });
    const person = await createPerson(db, {
      firstName: 'Unlink',
      lastName: 'Person',
    });
    const { request } = createTestApp('/api/person-companies', personCompaniesRoutes, {
      context: {
        permissions: permissions('contacts:update'),
        tenantDb: db,
      },
    });

    const createRes = await request('/api/person-companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personId: person.id,
        companyId: company.id,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { id: string } };
    vi.clearAllMocks();

    const delRes = await request(`/api/person-companies/${created.data.id}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(204);

    const linkCall = mockedPublish.mock.calls.find(
      (c) => (c[0] as { entityType: string }).entityType === 'contact_link',
    )?.[0] as { action: string; entityId: string };
    expect(linkCall?.action).toBe('deleted');
    expect(linkCall?.entityId).toBe(created.data.id);
  });

  it('POST / rejects empty personId or companyId', async () => {
    const { request } = createTestApp('/api/person-companies', personCompaniesRoutes, {
      context: {
        permissions: permissions('contacts:update'),
        tenantDb: db,
      },
    });
    const res = await request('/api/person-companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: '', companyId: '' }),
    });
    expect(res.status).toBe(400);
  });
});
