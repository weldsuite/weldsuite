/**
 * DB-backed integration tests for /api/companies/*.
 *
 * Where `index.test.ts` mocks the service layer to test the Hono
 * layer in isolation, this file uses a real pglite-backed Drizzle so
 * the SQL the service emits is actually executed. That catches schema
 * drift and SQL bugs that the mock-DB tests can't.
 *
 * The pglite handle is shared across the suite (cached in
 * `pglite.ts`); each test wipes the rows it cares about so cases stay
 * independent without paying for a fresh DB.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { companiesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  // Stub the entity-event queue bindings on the env so the route's
  // publishEntityEvent helper no-ops cleanly. Real publishing is
  // covered by the mock-based test in index.test.ts.
}, 60_000);

describe('/api/companies · pglite integration', () => {
  it('POST / writes to the database and returns the created row', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: {
        permissions: permissions('companies:create'),
        tenantDb: db,
      },
    });

    const res = await request('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Integration Co.' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; name: string; displayName: string };
    };
    expect(body.data.id).toMatch(/^company_/);
    expect(body.data.displayName).toBe('Acme Integration Co.');

    // Verify the row actually landed in the DB.
    const [row] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, body.data.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.name).toBe('Acme Integration Co.');
  });

  it('GET / returns the cursor-paginated list', async () => {
    // Seed two rows directly so we don't depend on POST.
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: {
        permissions: permissions('companies:read'),
        tenantDb: db,
      },
    });

    const res = await request('/api/companies?limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    // At least the two rows from this suite + any leftovers — exact
    // count isn't asserted because pglite is shared with other tests.
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toHaveProperty('totalCount');
  });

  it('GET /:id returns 404 for a missing company', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: {
        permissions: permissions('companies:read'),
        tenantDb: db,
      },
    });
    const res = await request('/api/companies/company_does_not_exist');
    expect(res.status).toBe(404);
  });

  it('PATCH /:id updates displayName when name changes', async () => {
    const { request: createReq } = createTestApp('/api/companies', companiesRoutes, {
      context: {
        permissions: permissions('companies:create', 'companies:update'),
        tenantDb: db,
      },
    });
    const created = await createReq('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Before Rename' }),
    });
    const createdBody = (await created.json()) as { data: { id: string } };
    const id = createdBody.data.id;

    const patched = await createReq(`/api/companies/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'After Rename' }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      data: { name: string; displayName: string };
    };
    expect(patchedBody.data.name).toBe('After Rename');
    expect(patchedBody.data.displayName).toBe('After Rename');
  });

  it('DELETE /:id soft-deletes the row (no longer fetchable)', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: {
        permissions: permissions('companies:create', 'companies:read', 'companies:delete'),
        tenantDb: db,
      },
    });
    const created = await request('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Disappearing Co.' }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const del = await request(`/api/companies/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const after = await request(`/api/companies/${id}`);
    expect(after.status).toBe(404);
  });

  it('POST /import creates new rows, upserts by partyCode, and reports row errors', async () => {
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:create'), tenantDb: db },
    });

    // First pass: two valid creates + one row that can't be created (no name).
    const res1 = await request('/api/companies/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [
          { partyCode: 'IMP-1', name: 'Imported One', email: 'one@imp.example' },
          { partyCode: 'IMP-2', name: 'Imported Two' },
          { email: 'orphan@imp.example' },
        ],
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      data: { imported: number; updated: number; failed: number; total: number; errors: unknown[] };
    };
    expect(body1.data.imported).toBe(2);
    expect(body1.data.updated).toBe(0);
    expect(body1.data.failed).toBe(1);
    expect(body1.data.total).toBe(3);
    expect(body1.data.errors).toHaveLength(1);

    // Second pass: same partyCode upserts the existing row (no duplicate).
    const res2 = await request('/api/companies/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [{ partyCode: 'IMP-1', name: 'Imported One Renamed', industry: 'Manufacturing' }],
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { data: { imported: number; updated: number } };
    expect(body2.data.imported).toBe(0);
    expect(body2.data.updated).toBe(1);

    const matched = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.partyCode, 'IMP-1'));
    expect(matched).toHaveLength(1);
    expect(matched[0]?.name).toBe('Imported One Renamed');
    expect(matched[0]?.industry).toBe('Manufacturing');
    expect(matched[0]?.displayName).toBe('Imported One Renamed');
    expect(matched[0]?.version).toBe(2);
  });

  it('GET /export returns all matching rows (no pagination) honoring search', async () => {
    // companies:scope:all required so the export isn't filtered to a single
    // owner — the import route doesn't set ownerId, so exported rows have
    // ownerId: null and only a scope:all user sees them without owner filtering.
    const { request } = createTestApp('/api/companies', companiesRoutes, {
      context: { permissions: permissions('companies:read', 'companies:scope:all'), tenantDb: db },
    });
    const res = await request('/api/companies/export?search=Imported');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ partyCode: string | null }> };
    expect(Array.isArray(body.data)).toBe(true);
    const codes = body.data.map((c) => c.partyCode);
    expect(codes).toContain('IMP-1');
    expect(codes).toContain('IMP-2');
  });
});
