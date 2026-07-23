/**
 * DB-backed integration tests for /api/meetings.
 *
 * The route now defaults `organizerId` from `c.get('userId')` when the body
 * omits it — tests no longer need to pass an explicit `organizerId`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { meetingsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/meetings · pglite integration', () => {
  it('POST / writes a meeting row with organizerId from auth context', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:create'),
        userId: 'user_mtg_creator',
        tenantDb: db,
      },
    });

    const res = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'E2E Sync' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^mtg_/);

    const [row] = await db
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, body.data.id))
      .limit(1);
    expect(row?.title).toBe('E2E Sync');
    expect(row?.organizerId).toBe('user_mtg_creator');
  });

  it('POST / accepts explicit organizerId override', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:create'),
        userId: 'user_mtg_caller',
        tenantDb: db,
      },
    });

    const res = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Delegated Meeting', organizerId: 'user_mtg_delegate' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, body.data.id))
      .limit(1);
    expect(row?.organizerId).toBe('user_mtg_delegate');
  });

  it('POST / rejects empty title', async () => {
    const { request } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), tenantDb: db },
    });
    const res = await request('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
  });

  // ── Scope-isolation tests ────────────────────────────────────────────────

  it('GET / non-elevated user only sees own meetings', async () => {
    const aliceId = 'user_scope_alice_mtg';
    const bobId = 'user_scope_bob_mtg';

    const { request: reqAlice } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: aliceId, tenantDb: db },
    });
    const { request: reqBob } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: bobId, tenantDb: db },
    });

    await reqAlice('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alice Meeting' }),
    });
    await reqBob('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bob Meeting' }),
    });

    const { request: listAlice } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), userId: aliceId, tenantDb: db },
    });
    const listRes = await listAlice('/api/meetings');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { organizerId: string }[] };
    expect(listBody.data.every((r) => r.organizerId === aliceId)).toBe(true);
  });

  it('GET /:id non-elevated user gets 404 for another organizer\'s meeting', async () => {
    const charlieId = 'user_scope_charlie_mtg';
    const { request: seed } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: charlieId, tenantDb: db },
    });
    const seedRes = await seed('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Charlie Meeting' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const mtgId = seedBody.data.id;

    const { request: reqDave } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:read'), userId: 'user_scope_dave_mtg', tenantDb: db },
    });
    const res = await reqDave(`/api/meetings/${mtgId}`);
    expect(res.status).toBe(404);
  });

  it('GET /:id elevated user (meetings:scope:all) can read any meeting', async () => {
    const erinId = 'user_scope_erin_mtg';
    const { request: seed } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: erinId, tenantDb: db },
    });
    const seedRes = await seed('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Erin Meeting' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const mtgId = seedBody.data.id;

    const { request: reqAdmin } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:read', 'meetings:scope:all'),
        userId: 'user_scope_admin_mtg',
        tenantDb: db,
      },
    });
    const res = await reqAdmin(`/api/meetings/${mtgId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; organizerId: string } };
    expect(body.data.organizerId).toBe(erinId);
  });

  it('PATCH /:id/host-controls rejects non-organizer regardless of scope', async () => {
    // Organizer creates the meeting
    const organizerId = 'user_scope_hc_organizer';
    const { request: seed } = createTestApp('/api/meetings', meetingsRoutes, {
      context: { permissions: permissions('meetings:create'), userId: organizerId, tenantDb: db },
    });
    const seedRes = await seed('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Host Control Test Meeting' }),
    });
    const seedBody = (await seedRes.json()) as { data: { id: string } };
    const mtgId = seedBody.data.id;

    // Admin user with scope:all tries host-controls — should still get 403
    // because host-controls enforces exact organizer identity, not scope
    const { request: reqAdmin } = createTestApp('/api/meetings', meetingsRoutes, {
      context: {
        permissions: permissions('meetings:read', 'meetings:scope:all'),
        userId: 'user_scope_admin_hc',
        tenantDb: db,
      },
    });
    const res = await reqAdmin(`/api/meetings/${mtgId}/host-controls`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowScreenShare: false }),
    });
    expect(res.status).toBe(403);
  });
});
