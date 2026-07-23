/**
 * DB-backed integration tests for /api/notifications.
 *
 * Privacy contract: a user must NEVER read another user's notifications.
 * The list (`GET /`) and get-by-id (`GET /:id`) endpoints are force-scoped
 * to `c.get('userId')`, ignoring any `?userId=` filter.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { notificationsRoutes } from './index';
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

const USER_A = 'user_alice';
const USER_B = 'user_bob';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const now = new Date();
  await db.insert(schema.notifications).values([
    {
      id: 'ntf_alice_1',
      userId: USER_A,
      title: 'Alice private',
      body: 'For Alice only',
      createdAt: now,
    },
    {
      id: 'ntf_bob_1',
      userId: USER_B,
      title: 'Bob private',
      body: 'For Bob only',
      createdAt: now,
    },
  ] as unknown as (typeof schema.notifications.$inferInsert)[]);
}, 60_000);

describe('/api/notifications · privacy scoping', () => {
  it('GET / returns ONLY the authenticated user notifications', async () => {
    const { request } = createTestApp('/api/notifications', notificationsRoutes, {
      context: { permissions: permissions('general:read'), tenantDb: db, userId: USER_A },
    });
    const res = await request('/api/notifications');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string }[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((n) => n.userId === USER_A)).toBe(true);
    expect(body.data.some((n) => n.id === 'ntf_bob_1')).toBe(false);
  });

  it('GET /?userId= cannot be used to read another user notifications', async () => {
    const { request } = createTestApp('/api/notifications', notificationsRoutes, {
      context: { permissions: permissions('general:read'), tenantDb: db, userId: USER_A },
    });
    // Alice tries to spoof Bob's id via the filter — must be ignored.
    const res = await request(`/api/notifications?userId=${USER_B}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userId: string }[] };
    expect(body.data.every((n) => n.userId === USER_A)).toBe(true);
  });

  it('GET /:id returns 404 when the notification belongs to another user', async () => {
    const { request } = createTestApp('/api/notifications', notificationsRoutes, {
      context: { permissions: permissions('general:read'), tenantDb: db, userId: USER_A },
    });
    // Alice asks for Bob's notification by id — must not leak.
    const res = await request('/api/notifications/ntf_bob_1');
    expect(res.status).toBe(404);
  });

  it('GET /:id returns the notification when it belongs to the caller', async () => {
    const { request } = createTestApp('/api/notifications', notificationsRoutes, {
      context: { permissions: permissions('general:read'), tenantDb: db, userId: USER_A },
    });
    const res = await request('/api/notifications/ntf_alice_1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string } };
    expect(body.data.id).toBe('ntf_alice_1');
    expect(body.data.userId).toBe(USER_A);
  });
});
