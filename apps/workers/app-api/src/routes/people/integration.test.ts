/**
 * DB-backed integration tests for /api/people/*. Mirrors
 * `routes/companies/integration.test.ts` — see that file for the
 * rationale.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { peopleRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/people · pglite integration', () => {
  it('POST / writes a person and derives displayName', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:create'), tenantDb: db },
    });

    const res = await request('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Jane', lastName: 'Integration' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; displayName: string };
    };
    expect(body.data.id).toMatch(/^person_/);
    expect(body.data.displayName).toBe('Jane Integration');

    const [row] = await db
      .select()
      .from(schema.people)
      .where(eq(schema.people.id, body.data.id))
      .limit(1);
    expect(row?.firstName).toBe('Jane');
    expect(row?.lastName).toBe('Integration');
  });

  it('GET /:id returns 404 when the row was soft-deleted', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: {
        permissions: permissions(
          'people:create',
          'people:read',
          'people:delete',
        ),
        tenantDb: db,
      },
    });
    const created = await request('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Disappearing', lastName: 'Person' }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const del = await request(`/api/people/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const after = await request(`/api/people/${id}`);
    expect(after.status).toBe(404);
  });

  it('POST /import creates new rows, upserts by partyCode, and reports row errors', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:create'), tenantDb: db },
    });

    // Two valid creates + one row with no name/email that can't be created.
    const res1 = await request('/api/people/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [
          { partyCode: 'PIMP-1', firstName: 'Imp', lastName: 'Person', email: 'imp1@imp.example' },
          { partyCode: 'PIMP-2', fullName: 'Imp Two' },
          { title: 'Nobody' },
        ],
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      data: { imported: number; updated: number; failed: number; total: number; errors: unknown[] };
    };
    expect(body1.data.imported).toBe(2);
    expect(body1.data.failed).toBe(1);
    expect(body1.data.total).toBe(3);

    // Re-import same partyCode → upsert, no duplicate.
    const res2 = await request('/api/people/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [{ partyCode: 'PIMP-1', firstName: 'Imp', lastName: 'Renamed', title: 'CTO' }],
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { data: { imported: number; updated: number } };
    expect(body2.data.imported).toBe(0);
    expect(body2.data.updated).toBe(1);

    const matched = await db
      .select()
      .from(schema.people)
      .where(eq(schema.people.partyCode, 'PIMP-1'));
    expect(matched).toHaveLength(1);
    expect(matched[0]?.lastName).toBe('Renamed');
    expect(matched[0]?.displayName).toBe('Imp Renamed');
    expect(matched[0]?.title).toBe('CTO');
    expect(matched[0]?.version).toBe(2);
  });

  it('GET /export returns all matching rows (no pagination) honoring search', async () => {
    // people:scope:all required so the export isn't filtered to a single
    // owner — the import route doesn't set ownerId, so exported rows have
    // ownerId: null and only a scope:all user sees them without owner filtering.
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:read', 'people:scope:all'), tenantDb: db },
    });
    const res = await request('/api/people/export?search=Imp');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ partyCode: string | null }> };
    expect(Array.isArray(body.data)).toBe(true);
    const codes = body.data.map((p) => p.partyCode);
    expect(codes).toContain('PIMP-1');
    expect(codes).toContain('PIMP-2');
  });
});
