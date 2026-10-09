/**
 * DB-backed integration tests for /api/people/*. Mirrors
 * `routes/companies/integration.test.ts` — see that file for the
 * rationale.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { peopleRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  // The route defaults a new row's ownerId to the acting user
  // (`data.ownerId ?? userId`), and createPerson/updatePerson now validate
  // ownerId/accountManagerId against workspace_members (TASK-914). In
  // production the acting user is always a real member (Clerk +
  // workspaceDbMiddleware guarantee it); here the harness's default test
  // identity isn't backed by a row, so seed one.
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_user_test_default',
    userId: 'user_test_default',
    name: 'Test User',
    role: 'MEMBER',
  });
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

  it('POST / promotes a hidden non-CRM identity with the same email (200), 409 for a CRM duplicate', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: {
        permissions: permissions('people:create', 'people:read', 'people:update'),
        tenantDb: db,
      },
    });
    const post = (body: unknown) =>
      request('/api/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Hidden mail-only identity (what WeldMail auto-creates for a new "To").
    const email = 'guest-promote@route.example';
    const [hidden] = await db
      .insert(schema.people)
      .values({ id: 'person_route_hidden', email, displayName: email, inCrm: false })
      .returning();

    const promote = await post({ firstName: 'Gus', lastName: 'Guest', email });
    expect(promote.status).toBe(200);
    const promoted = (await promote.json()) as { data: { id: string; inCrm: boolean; firstName: string } };
    expect(promoted.data.id).toBe(hidden!.id);
    expect(promoted.data.inCrm).toBe(true);
    expect(promoted.data.firstName).toBe('Gus');

    // Now a real CRM person — a second create is a genuine duplicate.
    const dup = await post({ firstName: 'Gus', email });
    expect(dup.status).toBe(409);
    const dupBody = (await dup.json()) as { error: { details: { existingPersonId: string } } };
    expect(dupBody.error.details.existingPersonId).toBe(hidden!.id);
  });

  it('PATCH /:id returns 409 when the new email belongs to another CRM person', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:create', 'people:update'), tenantDb: db },
    });
    const json = { 'Content-Type': 'application/json' };
    const a = (await (
      await request('/api/people', { method: 'POST', headers: json, body: JSON.stringify({ firstName: 'A', email: 'patch-a@route.example' }) })
    ).json()) as { data: { id: string } };
    const b = (await (
      await request('/api/people', { method: 'POST', headers: json, body: JSON.stringify({ firstName: 'B', email: 'patch-b@route.example' }) })
    ).json()) as { data: { id: string } };

    const clash = await request(`/api/people/${b.data.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ email: 'Patch-A@route.example' }),
    });
    expect(clash.status).toBe(409);
    const body = (await clash.json()) as { error: { details: { existingPersonId: string } } };
    expect(body.error.details.existingPersonId).toBe(a.data.id);

    const ok = await request(`/api/people/${b.data.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ email: 'patch-b2@route.example' }),
    });
    expect(ok.status).toBe(200);
  });

  it('PATCH /:id rejects a free-text lifecycleStage (400) and accepts a canonical one', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: { permissions: permissions('people:create', 'people:update'), tenantDb: db },
    });
    const json = { 'Content-Type': 'application/json' };
    const p = (await (
      await request('/api/people', { method: 'POST', headers: json, body: JSON.stringify({ firstName: 'Life' }) })
    ).json()) as { data: { id: string } };

    const bad = await request(`/api/people/${p.data.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ lifecycleStage: 'zzz-free' }),
    });
    expect(bad.status).toBe(400);

    const good = await request(`/api/people/${p.data.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ lifecycleStage: 'customer' }),
    });
    expect(good.status).toBe(200);
    const cleared = await request(`/api/people/${p.data.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ lifecycleStage: null }),
    });
    expect(cleared.status).toBe(200);
  });

  it('POST /:id/chat/messages mirrors the message into the person Activity feed', async () => {
    const { request } = createTestApp('/api/people', peopleRoutes, {
      context: {
        permissions: permissions('people:create', 'people:read', 'channels:create'),
        tenantDb: db,
      },
    });
    const json = { 'Content-Type': 'application/json' };
    const person = (await (
      await request('/api/people', { method: 'POST', headers: json, body: JSON.stringify({ firstName: 'Chatty' }) })
    ).json()) as { data: { id: string } };

    const res = await request(`/api/people/${person.data.id}/chat/messages`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ content: 'Called them, will follow up Monday' }),
    });
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(schema.crmActivities)
      .where(eq(schema.crmActivities.personId, person.data.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'comment',
      subject: 'Called them, will follow up Monday',
      status: 'completed',
      personId: person.data.id,
    });
    expect(rows[0]!.customerId).toBeNull();
  });
});
