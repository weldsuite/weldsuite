/**
 * /api/notification-preferences routes the privacy tests in
 * integration.test.ts leave out: the cursor list, reading, creating,
 * updating and deleting your own row, module-name and body validation, and
 * the permission gates. Real pglite tenant DB; runs in the Rust conformance
 * suite too (`rust/conformance/suites.json`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { notificationPreferencesRoutes } from './index';

let db: Database;

const DAN = 'user_np_dan';
const ERIN = 'user_np_erin';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.notificationPreferences).values([
    {
      id: 'npr_np_dan',
      userId: DAN,
      doNotDisturb: true,
      modulePreferences: { crm: { enabled: true, inApp: true, email: false, push: true, desktop: true } },
      createdAt: new Date('2026-01-02T10:00:00.000Z'),
      updatedAt: new Date('2026-01-02T10:00:00.000Z'),
    },
    {
      id: 'npr_np_other',
      userId: 'user_np_other',
      createdAt: new Date('2026-01-03T10:00:00.000Z'),
      updatedAt: new Date('2026-01-03T10:00:00.000Z'),
    },
  ] as (typeof schema.notificationPreferences.$inferInsert)[]);
}, 60_000);

function app(userId: string, ...keys: string[]) {
  return createTestApp('/api/notification-preferences', notificationPreferencesRoutes, {
    context: { tenantDb: db, userId, permissions: permissions(...keys) },
  });
}

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('GET /api/notification-preferences', () => {
  it('lists the caller row with the pagination envelope', async () => {
    const res = await app(DAN, 'general:read').request('/api/notification-preferences?limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; doNotDisturb: boolean; modulePreferences: unknown }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(body.data.map((r) => r.id)).toEqual(['npr_np_dan']);
    expect(body.data[0]?.doNotDisturb).toBe(true);
    expect(body.pagination).toEqual({ totalCount: 1, hasMore: false, cursor: null });
  });

  it('pages with a limit and a cursor', async () => {
    const first = await app(DAN, 'general:read').request('/api/notification-preferences?limit=0');
    expect(first.status).toBe(200);
    const page = (await first.json()) as { data: unknown[]; pagination: { hasMore: boolean; cursor: string | null } };
    expect(page.data).toEqual([]);
    expect(page.pagination.hasMore).toBe(true);

    const after = await app(DAN, 'general:read').request('/api/notification-preferences?cursor=npr_np_dan');
    expect(after.status).toBe(200);
    const rest = (await after.json()) as { data: unknown[]; pagination: { totalCount: number } };
    expect(rest.data).toEqual([]);
    expect(rest.pagination.totalCount).toBe(1);
  });

  it('an unknown cursor counts every row, as the route always has', async () => {
    const res = await app(DAN, 'general:read').request('/api/notification-preferences?cursor=npr_np_missing');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: { totalCount: number } };
    expect(body.data.map((r) => r.id)).toEqual(['npr_np_dan']);
    expect(body.pagination.totalCount).toBe(2);
  });

  it('needs general:read', async () => {
    const res = await app(DAN).request('/api/notification-preferences');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/notification-preferences/:id', () => {
  it('returns the caller row', async () => {
    const res = await app(DAN, 'general:read').request('/api/notification-preferences/npr_np_dan');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string; createdAt: string } };
    expect(body.data).toMatchObject({ id: 'npr_np_dan', userId: DAN, createdAt: '2026-01-02T10:00:00.000Z' });
  });

  it('answers 404 for an unknown id', async () => {
    const res = await app(DAN, 'general:read').request('/api/notification-preferences/npr_np_missing');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('npr_np_missing');
  });
});

describe('POST, PATCH and DELETE /api/notification-preferences', () => {
  it('creates a row for the caller with the column defaults', async () => {
    const res = await app(ERIN, 'general:create').request(
      '/api/notification-preferences',
      send('POST', { defaultEmail: true }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.id, data.id));
    expect(row).toMatchObject({ userId: ERIN, defaultEmail: true, soundEnabled: true, modulePreferences: null });
  });

  it('needs general:create to create', async () => {
    const res = await app('user_np_nobody', 'general:read').request('/api/notification-preferences', send('POST', {}));
    expect(res.status).toBe(403);
  });

  it('patches the caller row', async () => {
    const res = await app(DAN, 'general:update').request(
      '/api/notification-preferences/npr_np_dan',
      send('PATCH', { soundEnabled: false }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'npr_np_dan' } });
    const [row] = await db.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.id, 'npr_np_dan'));
    expect(row).toMatchObject({ soundEnabled: false, doNotDisturb: true });
  });

  it('refuses a malformed patch', async () => {
    const res = await app(DAN, 'general:update').request(
      '/api/notification-preferences/npr_np_dan',
      send('PATCH', { modulePreferences: { crm: { enabled: true } } }),
    );
    expect(res.status).toBe(400);
  });

  it('needs general:update to patch and general:delete to delete', async () => {
    const patch = await app(DAN, 'general:read').request('/api/notification-preferences/npr_np_dan', send('PATCH', {}));
    expect(patch.status).toBe(403);
    const remove = await app(DAN, 'general:read').request('/api/notification-preferences/npr_np_dan', { method: 'DELETE' });
    expect(remove.status).toBe(403);
  });

  it('deletes the caller row', async () => {
    const res = await app(DAN, 'general:delete').request('/api/notification-preferences/npr_np_dan', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const rows = await db.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.id, 'npr_np_dan'));
    expect(rows).toHaveLength(0);
  });
});

describe('PUT /api/notification-preferences/module/:module', () => {
  const crm = { enabled: true, inApp: false, email: true, push: false, desktop: true };

  it('refuses a module name that is not a slug', async () => {
    const res = await app(ERIN, 'general:read').request('/api/notification-preferences/module/bad%20name', send('PUT', crm));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Invalid module name');
  });

  it('refuses channels with a flag missing', async () => {
    const res = await app(ERIN, 'general:read').request(
      '/api/notification-preferences/module/crm',
      send('PUT', { enabled: true, inApp: true }),
    );
    expect(res.status).toBe(400);
  });

  it('needs general:read', async () => {
    const res = await app(ERIN).request('/api/notification-preferences/module/crm', send('PUT', crm));
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/notification-preferences', () => {
  it('needs general:read', async () => {
    const res = await app(ERIN).request('/api/notification-preferences', send('PUT', { doNotDisturb: true }));
    expect(res.status).toBe(403);
  });

  it('replaces modulePreferences when it is sent', async () => {
    const res = await app(ERIN, 'general:read').request(
      '/api/notification-preferences',
      send('PUT', { modulePreferences: { mail: { enabled: false, inApp: false, email: false, push: false, desktop: false, x: 1 } } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { modulePreferences: unknown; defaultEmail: boolean } };
    expect(body.data.modulePreferences).toEqual({
      mail: { enabled: false, inApp: false, email: false, push: false, desktop: false },
    });
    expect(body.data.defaultEmail).toBe(true);
  });
});

// Last on purpose: a statement that fails in the database leaves the Rust
// server's pglite-socket connection out of step (conformance mode), so no
// request may follow it in this file.
describe('POST /api/notification-preferences · database failure', () => {
  it('a second row for the same user fails (the user id is unique)', async () => {
    const res = await app(ERIN, 'general:create').request('/api/notification-preferences', send('POST', {}));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Failed to create notification preference');
  });
});
