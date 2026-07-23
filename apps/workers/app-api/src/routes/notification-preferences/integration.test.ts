/**
 * DB-backed integration tests for /api/notification-preferences.
 *
 * Privacy contract: preferences are personal. Every read/write is
 * force-scoped to `c.get('userId')`; a user can never read or mutate
 * another user's preference, and any `?userId=` filter is ignored.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { notificationPreferencesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

const USER_A = 'user_alice_pref';
const USER_B = 'user_bob_pref';

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const now = new Date();
  await db.insert(schema.notificationPreferences).values([
    { id: 'npr_alice', userId: USER_A, createdAt: now, updatedAt: now },
    { id: 'npr_bob', userId: USER_B, createdAt: now, updatedAt: now },
  ] as unknown as (typeof schema.notificationPreferences.$inferInsert)[]);
}, 60_000);

describe('/api/notification-preferences · privacy scoping', () => {
  it('GET / returns ONLY the authenticated user preferences', async () => {
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:read'), tenantDb: db, userId: USER_A } },
    );
    const res = await request('/api/notification-preferences');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string }[] };
    expect(body.data.every((p) => p.userId === USER_A)).toBe(true);
    expect(body.data.some((p) => p.id === 'npr_bob')).toBe(false);
  });

  it('GET /?userId= cannot read another user preferences', async () => {
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:read'), tenantDb: db, userId: USER_A } },
    );
    const res = await request(`/api/notification-preferences?userId=${USER_B}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userId: string }[] };
    expect(body.data.every((p) => p.userId === USER_A)).toBe(true);
  });

  it('GET /:id returns 404 for another user preference', async () => {
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:read'), tenantDb: db, userId: USER_A } },
    );
    const res = await request('/api/notification-preferences/npr_bob');
    expect(res.status).toBe(404);
  });

  it('PATCH /:id cannot modify another user preference', async () => {
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:update'), tenantDb: db, userId: USER_A } },
    );
    const res = await request('/api/notification-preferences/npr_bob', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doNotDisturb: true }),
    });
    expect(res.status).toBe(404);

    // Bob's row is untouched.
    const [bob] = await db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.id, 'npr_bob'))
      .limit(1);
    expect(bob?.doNotDisturb).toBe(false);
  });

  it('DELETE /:id cannot delete another user preference', async () => {
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:delete'), tenantDb: db, userId: USER_A } },
    );
    const res = await request('/api/notification-preferences/npr_bob', { method: 'DELETE' });
    expect(res.status).toBe(404);

    const [bob] = await db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.id, 'npr_bob'))
      .limit(1);
    expect(bob).toBeDefined();
  });

  it('PUT / cannot write another user preference', async () => {
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:read'), tenantDb: db, userId: USER_A } },
    );
    // Even if the caller names Bob, the upsert is force-scoped to the caller.
    const res = await request('/api/notification-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_B, doNotDisturb: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string } };
    expect(body.data.userId).toBe(USER_A);
    expect(body.data.id).toBe('npr_alice');

    const [bob] = await db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.id, 'npr_bob'))
      .limit(1);
    expect(bob?.doNotDisturb).toBe(false);
  });

  it('POST / forces ownership to the authenticated user', async () => {
    // Fresh caller with no existing preference row (the table has a UNIQUE
    // index on user_id, so we use a distinct user to avoid a collision).
    const USER_C = 'user_carol_pref';
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:create'), tenantDb: db, userId: USER_C } },
    );
    // Caller attempts to plant a preference owned by Bob.
    const res = await request('/api/notification-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_B, channel: 'email', doNotDisturb: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.id, body.data.id))
      .limit(1);
    // Ownership coerced to the caller, not Bob.
    expect(row?.userId).toBe(USER_C);
  });
});

/**
 * The gap this suite exists for: the table is a singleton per user, so a user
 * with no row yet had no way to write one (no id to PATCH, and POST validated
 * against a schema describing a different table). PUT upserts.
 */
describe('/api/notification-preferences · PUT upsert', () => {
  const put = (userId: string, body: unknown, perms = 'general:read') => {
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions(perms), tenantDb: db, userId } },
    );
    return request('/api/notification-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  it('creates the first row for a user who has none, applying defaults', async () => {
    const res = await put('user_dave_pref', { doNotDisturb: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.userId).toBe('user_dave_pref');
    expect(body.data.doNotDisturb).toBe(true);
    // Untouched keys fall back to the legacy create-defaults.
    expect(body.data.soundEnabled).toBe(true);
    expect(body.data.defaultInApp).toBe(true);
    expect(body.data.defaultEmail).toBe(false);
    expect(body.data.modulePreferences).toEqual({});
  });

  it('is gated on the baseline tier — a MEMBER can save their own settings', async () => {
    // SYSTEM_ROLES.MEMBER holds general:read but NOT general:update. Gating this
    // personal, self-scoped write on general:update would 403 a member out of
    // their own notification settings page.
    const res = await put('user_member_pref', { soundEnabled: false }, 'general:read');
    expect(res.status).toBe(200);
  });

  it('partial PUT merges — it does not reset the keys it omits', async () => {
    const u = 'user_erin_pref';
    await put(u, { defaultEmail: true, doNotDisturb: true });
    // Second write touches one key only.
    const res = await put(u, { defaultPush: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.defaultPush).toBe(false);
    // Previously-set values survive.
    expect(body.data.defaultEmail).toBe(true);
    expect(body.data.doNotDisturb).toBe(true);
  });

  it('does not create a duplicate row on repeated writes', async () => {
    const u = 'user_frank_pref';
    await put(u, { doNotDisturb: true });
    await put(u, { doNotDisturb: false });
    const rows = await db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, u));
    expect(rows).toHaveLength(1);
    expect(rows[0].doNotDisturb).toBe(false);
  });

  it('rejects a malformed body', async () => {
    const res = await put('user_grace_pref', { doNotDisturb: 'yes' });
    expect(res.status).toBe(400);
  });
});

describe('/api/notification-preferences · PUT /module/:module merge', () => {
  const putModule = (userId: string, moduleName: string, prefs: unknown) => {
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:read'), tenantDb: db, userId } },
    );
    return request(`/api/notification-preferences/module/${moduleName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  };

  const PREFS = { enabled: true, inApp: true, email: false, push: true, desktop: true };

  it('creates the first row when the user has none', async () => {
    const res = await putModule('user_heidi_pref', 'crm', PREFS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { modulePreferences: Record<string, unknown> } };
    expect(body.data.modulePreferences).toEqual({ crm: PREFS });
  });

  it('merges server-side — toggling one module leaves the others intact', async () => {
    const u = 'user_ivan_pref';
    await putModule(u, 'crm', PREFS);
    const res = await putModule(u, 'helpdesk', { ...PREFS, enabled: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { modulePreferences: Record<string, unknown> } };
    // CRM survives a write that only named helpdesk.
    expect(body.data.modulePreferences).toEqual({
      crm: PREFS,
      helpdesk: { ...PREFS, enabled: false },
    });
  });

  it('replaces the named module wholesale on re-write', async () => {
    const u = 'user_judy_pref';
    await putModule(u, 'crm', PREFS);
    const res = await putModule(u, 'crm', { ...PREFS, email: true });
    const body = (await res.json()) as { data: { modulePreferences: Record<string, unknown> } };
    expect(body.data.modulePreferences).toEqual({ crm: { ...PREFS, email: true } });
  });

  it('does not disturb scalar settings already on the row', async () => {
    const u = 'user_karl_pref';
    const { request } = createTestApp(
      '/api/notification-preferences',
      notificationPreferencesRoutes,
      { context: { permissions: permissions('general:read'), tenantDb: db, userId: u } },
    );
    await request('/api/notification-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doNotDisturb: true }),
    });
    const res = await putModule(u, 'mail', PREFS);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.doNotDisturb).toBe(true);
    expect(body.data.modulePreferences).toEqual({ mail: PREFS });
  });

  it('rejects an incomplete channel payload', async () => {
    const res = await putModule('user_leo_pref', 'crm', { enabled: true });
    expect(res.status).toBe(400);
  });

  it('rejects a junk module name', async () => {
    const res = await putModule('user_mona_pref', 'not%20a%20module!', PREFS);
    expect(res.status).toBe(400);
  });
});
