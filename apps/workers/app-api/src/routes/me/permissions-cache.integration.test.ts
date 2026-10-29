/**
 * GET /me/permissions through the resolved-permissions KV cache
 * (`resolveEffectivePermissionsCached`, `@weldsuite/worker-kit/permission-cache`),
 * the same cache `requirePermission()` uses: this is the platform's
 * open-on-every-page-load endpoint.
 *
 * Kept out of permissions.integration.test.ts on purpose: that file is a Rust
 * conformance suite, and these tests change the database behind the cache to
 * prove a hit, which only the TypeScript backend's cache can show. Each test
 * gets its own fresh in-memory `WORKSPACE_CACHE` (`createMemoryKv`), so a
 * miss is always a real pglite read, never a leftover from another test.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { meRoutes } from './index';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

type MemoryKv = ReturnType<typeof createMemoryKv>;

async function fetchMe(userId: string, cache: MemoryKv) {
  const t = createTestApp('/api/me', meRoutes, {
    context: { tenantDb: db, userId },
    env: { WORKSPACE_CACHE: cache } as unknown as Record<string, string>,
  });
  const res = await t.request('/api/me/permissions');
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe('GET /me/permissions: the permission cache', () => {
  it('resolves from the database on a miss, then serves the cached result on a later call', async () => {
    const now = new Date();
    await db.insert(schema.workspaceMembers).values({
      id: 'wm_me_cache',
      userId: 'user_me_cache',
      email: 'me-cache@example.com',
      role: 'MEMBER',
      permissions: ['weldcrm:companies:read'],
      createdAt: now,
      updatedAt: now,
    } as typeof schema.workspaceMembers.$inferInsert);
    const cache = createMemoryKv();

    // Miss: a real pglite read, reflecting the row as it is right now.
    const first = await fetchMe('user_me_cache', cache);
    expect(first.permissions).toEqual(expect.arrayContaining(['weldcrm:companies:read']));

    // Change the row directly — a genuine cache hit must not see this.
    await db
      .update(schema.workspaceMembers)
      .set({ permissions: ['weldbooks:invoices:read'] })
      .where(eq(schema.workspaceMembers.userId, 'user_me_cache'));

    const second = await fetchMe('user_me_cache', cache);
    expect(second.permissions).toEqual(first.permissions);
    expect(second.permissions).not.toEqual(expect.arrayContaining(['weldbooks:invoices:read']));
  });

  it('never caches a resolution for a userId with no member row', async () => {
    const cache = createMemoryKv();

    const first = await fetchMe('user_no_member', cache);
    expect(first.permissions).toEqual([]);
    expect(first.role).toBe('');
    // Nothing written under a resolved-permissions key: only the version
    // key (if anything) could be present, never written by a resolution.
    expect([...cache.store.keys()].some((k) => k.startsWith('permr:'))).toBe(false);

    const now = new Date();
    await db.insert(schema.workspaceMembers).values({
      id: 'wm_no_member_added',
      userId: 'user_no_member',
      email: 'added-later@example.com',
      role: 'ADMIN',
      createdAt: now,
      updatedAt: now,
    } as typeof schema.workspaceMembers.$inferInsert);

    // No writer bumped the version for this add (it went straight into the
    // test DB), yet the newly active member is not left reading back the
    // "no member" result from before — proving it was never cached.
    const second = await fetchMe('user_no_member', cache);
    expect(second.role).toBe('ADMIN');
  });
});
