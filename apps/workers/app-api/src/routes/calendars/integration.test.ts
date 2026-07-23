/**
 * DB-backed integration tests for /api/calendars.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { calendarsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/calendars · pglite integration', () => {
  it('POST / writes a calendar with ownerId from auth context', async () => {
    const { request } = createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:create'),
        userId: 'user_calendar_owner',
        tenantDb: db,
      },
    });

    const res = await request('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Work', color: '#3b82f6' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^cal_/);

    const [row] = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.id, body.data.id))
      .limit(1);
    expect(row?.name).toBe('Work');
    expect(row?.ownerId).toBe('user_calendar_owner');
  });

  it('POST / accepts an explicit ownerId override', async () => {
    const { request } = createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:create'),
        userId: 'user_caller',
        tenantDb: db,
      },
    });

    const res = await request('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Team', ownerId: 'user_team_lead' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.calendars)
      .where(eq(schema.calendars.id, body.data.id))
      .limit(1);
    expect(row?.ownerId).toBe('user_team_lead');
  });

  it('POST / rejects empty name', async () => {
    const { request } = createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:create'),
        userId: 'user_test',
        tenantDb: db,
      },
    });
    const res = await request('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  // ── Scope-isolation tests ────────────────────────────────────────────────

  it('GET / non-elevated user only sees own calendars', async () => {
    // Seed: one calendar owned by user_alice, one by user_bob
    const aliceId = 'user_scope_alice_cal';
    const bobId = 'user_scope_bob_cal';

    const { request: reqAlice } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:create'), userId: aliceId, tenantDb: db },
    });
    const { request: reqBob } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:create'), userId: bobId, tenantDb: db },
    });

    await reqAlice('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice Calendar' }),
    });
    await reqBob('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob Calendar' }),
    });

    // Alice lists — should see only her own
    const { request: listAlice } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:read'), userId: aliceId, tenantDb: db },
    });
    const listRes = await listAlice('/api/calendars');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { ownerId: string }[] };
    expect(listBody.data.every((r) => r.ownerId === aliceId)).toBe(true);
  });

  it('GET /:id non-elevated user gets 404 for another owner\'s calendar', async () => {
    // Seed a calendar owned by user_charlie
    const charlieId = 'user_scope_charlie_cal';
    const { request: seed } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:create'), userId: charlieId, tenantDb: db },
    });
    const seedRes = await seed('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Charlie Calendar' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const calId = seedBody.data.id;

    // Dave tries to read it
    const { request: reqDave } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:read'), userId: 'user_scope_dave_cal', tenantDb: db },
    });
    const res = await reqDave(`/api/calendars/${calId}`);
    expect(res.status).toBe(404);
  });

  it('GET /:id elevated user (calendars:scope:all) can read any calendar', async () => {
    // Seed a calendar owned by user_erin
    const erinId = 'user_scope_erin_cal';
    const { request: seed } = createTestApp('/api/calendars', calendarsRoutes, {
      context: { permissions: permissions('calendars:create'), userId: erinId, tenantDb: db },
    });
    const seedRes = await seed('/api/calendars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Erin Calendar' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const calId = seedBody.data.id;

    // Admin reads it
    const { request: reqAdmin } = createTestApp('/api/calendars', calendarsRoutes, {
      context: {
        permissions: permissions('calendars:read', 'calendars:scope:all'),
        userId: 'user_scope_admin_cal',
        tenantDb: db,
      },
    });
    const res = await reqAdmin(`/api/calendars/${calId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; ownerId: string } };
    expect(body.data.ownerId).toBe(erinId);
  });
});
