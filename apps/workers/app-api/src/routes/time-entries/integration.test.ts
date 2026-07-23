/**
 * DB-backed integration tests for /api/time-entries.
 *
 * Ownership model under test:
 *   - GET /           always scoped to the caller's own entries.
 *   - GET /:id        owner-only; another user's entry returns 404.
 *   - PATCH /:id      owner-only; another user's entry returns 404.
 *   - DELETE /:id     owner-only; another user's entry returns 404.
 *   - PATCH /:id/approve  cross-user (manager workflow) — NOT blocked.
 *   - PATCH /:id/reject   cross-user (manager workflow) — NOT blocked.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { timeEntriesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

// Helper: insert a raw time entry for a given user.
async function seedEntry(
  database: Database,
  id: string,
  userId: string,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date();
  await database
    .insert(schema.timeEntries)
    .values({
      id,
      userId,
      date: '2026-06-01',
      duration: '60',
      billable: true,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as typeof schema.timeEntries.$inferInsert)
    .onConflictDoNothing();
}

describe('/api/time-entries · pglite integration', () => {
  // -----------------------------------------------------------------------
  // POST / — create always stamps the caller's userId
  // -----------------------------------------------------------------------

  it('POST / creates an entry stamped with the caller userId', async () => {
    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:create'),
        userId: 'user_creator',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-06-01', duration: 90 }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^time_/);

    const [row] = await db
      .select()
      .from(schema.timeEntries)
      .where(
        and(
          eq(schema.timeEntries.id, body.data.id),
          eq(schema.timeEntries.userId, 'user_creator'),
        ),
      )
      .limit(1);
    expect(row?.userId).toBe('user_creator');
    expect(Number(row?.duration)).toBe(90);
  });

  // -----------------------------------------------------------------------
  // GET / — list is always scoped to own entries
  // -----------------------------------------------------------------------

  it('GET / returns only the caller\'s own entries', async () => {
    await seedEntry(db, 'time_alice_list', 'user_alice');
    await seedEntry(db, 'time_bob_list', 'user_bob');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read'),
        userId: 'user_alice',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain('time_alice_list');
    expect(ids).not.toContain('time_bob_list');
    for (const row of body.data) {
      expect(row.userId).toBe('user_alice');
    }
  });

  it('GET / ignores the userId query param (not yet granted)', async () => {
    // Even if the caller passes userId=user_alice in the query string while
    // logged in as user_carol, they must only see their own entries.
    await seedEntry(db, 'time_alice_qs', 'user_alice');
    await seedEntry(db, 'time_carol_qs', 'user_carol');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read'),
        userId: 'user_carol',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries?userId=user_alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain('time_alice_qs');
    expect(ids).toContain('time_carol_qs');
  });

  // -----------------------------------------------------------------------
  // GET /:id — owner-only
  // -----------------------------------------------------------------------

  it('GET /:id returns the entry for the owning user', async () => {
    await seedEntry(db, 'time_get_own', 'user_dave');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read'),
        userId: 'user_dave',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_get_own');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('time_get_own');
  });

  it('GET /:id returns 404 when the entry belongs to a different user', async () => {
    await seedEntry(db, 'time_get_other', 'user_eve');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read'),
        userId: 'user_frank',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_get_other');
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // PATCH /:id — owner-only
  // -----------------------------------------------------------------------

  it('PATCH /:id updates the entry for the owning user', async () => {
    await seedEntry(db, 'time_patch_own', 'user_grace');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:update'),
        userId: 'user_grace',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_patch_own', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Updated by owner' }),
    });
    expect(res.status).toBe(200);
  });

  it('PATCH /:id returns 404 when the caller does not own the entry', async () => {
    await seedEntry(db, 'time_patch_other', 'user_henry');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:update'),
        userId: 'user_iris',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_patch_other', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Should be blocked' }),
    });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // DELETE /:id — owner-only
  // -----------------------------------------------------------------------

  it('DELETE /:id soft-deletes the entry for the owning user', async () => {
    await seedEntry(db, 'time_delete_own', 'user_jack');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:delete'),
        userId: 'user_jack',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_delete_own', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('DELETE /:id returns 404 when the caller does not own the entry', async () => {
    await seedEntry(db, 'time_delete_other', 'user_karen');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:delete'),
        userId: 'user_leo',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_delete_other', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // PATCH /:id/approve — cross-user (manager workflow), must NOT be blocked
  // -----------------------------------------------------------------------

  it('PATCH /:id/approve approves an entry owned by a different user (manager flow)', async () => {
    await seedEntry(db, 'time_approve_other', 'user_mary');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:update'),
        userId: 'user_manager',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_approve_other/approve', {
      method: 'PATCH',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('approved');

    const [row] = await db
      .select()
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, 'time_approve_other'))
      .limit(1);
    expect(row?.status).toBe('approved');
    expect(row?.approvedBy).toBe('user_manager');
  });

  // -----------------------------------------------------------------------
  // PATCH /:id/reject — cross-user (manager workflow), must NOT be blocked
  // -----------------------------------------------------------------------

  it('PATCH /:id/reject rejects an entry owned by a different user (manager flow)', async () => {
    await seedEntry(db, 'time_reject_other', 'user_nancy');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:update'),
        userId: 'user_manager2',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_reject_other/reject', {
      method: 'PATCH',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('rejected');

    const [row] = await db
      .select()
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, 'time_reject_other'))
      .limit(1);
    expect(row?.status).toBe('rejected');
  });
});
