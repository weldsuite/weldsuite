/**
 * Resolved-permissions KV cache: key scoping, version-based invalidation,
 * and falling back to the database on any KV failure.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PermissionDbQuery } from '@weldsuite/permissions/server';
import { bumpPermissionsVersion, permissionsCacheKey } from '@weldsuite/db/lib/permissions-cache';
import { PERMISSIONS_RESOLUTION_VERSION } from '@weldsuite/permissions/server';
import { PERMISSIONS_CACHE_TTL_SECONDS, resolveEffectivePermissionsCached } from './permission-cache';
import { RequestTiming } from './timing';

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  return { env: { WORKSPACE_CACHE: kv as unknown as KVNamespace }, kv, store };
}

/** A PermissionDbQuery whose getMember call is counted, so a cache hit never calls it. */
function countedQueries(member: { role: string; roleId: string | null; permissions: string[] | null }) {
  const calls = { getMember: 0 };
  const queries: PermissionDbQuery = {
    getMember: async () => {
      calls.getMember += 1;
      return { id: 'mem_1', ...member };
    },
    getRolePermissions: async () => [],
    getTeamPermissions: async () => [],
  };
  return { queries, calls };
}

/** A PermissionDbQuery for a userId with no workspace_members row at all. */
function noMemberQueries() {
  const calls = { getMember: 0 };
  const queries: PermissionDbQuery = {
    getMember: async () => {
      calls.getMember += 1;
      return null;
    },
    getRolePermissions: async () => [],
    getTeamPermissions: async () => [],
  };
  return { queries, calls };
}

describe('resolveEffectivePermissionsCached', () => {
  it('resolves from the database on a miss and caches the result under the version it read', async () => {
    const { env, store } = fakeKv();
    const { queries, calls } = countedQueries({ role: 'MEMBER', roleId: null, permissions: ['weldcrm:leads:read'] });

    const resolved = await resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', queries);

    expect(calls.getMember).toBe(1);
    expect(resolved.permissions).toContain('weldcrm:leads:read');
    expect(JSON.parse(store.get(permissionsCacheKey('ws_1', 'user_1', '0', PERMISSIONS_RESOLUTION_VERSION))!)).toEqual(resolved);
  });

  it('serves a cached entry without touching the database', async () => {
    const { env } = fakeKv();
    const first = countedQueries({ role: 'MEMBER', roleId: null, permissions: ['weldcrm:leads:read'] });
    await resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', first.queries);

    const second = countedQueries({ role: 'OWNER', roleId: null, permissions: [] });
    const resolved = await resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', second.queries);

    expect(second.calls.getMember).toBe(0);
    expect(resolved.permissions).toContain('weldcrm:leads:read');
  });

  it('never serves one user\'s cached permissions to another in the same workspace', async () => {
    const { env } = fakeKv();
    await resolveEffectivePermissionsCached(
      env,
      'ws_1',
      'user_1',
      countedQueries({ role: 'MEMBER', roleId: null, permissions: ['weldcrm:leads:read'] }).queries,
    );

    const other = countedQueries({ role: 'VIEWER', roleId: null, permissions: [] });
    const resolved = await resolveEffectivePermissionsCached(env, 'ws_1', 'user_2', other.queries);

    expect(other.calls.getMember).toBe(1);
    expect(resolved.permissions).not.toContain('weldcrm:leads:read');
  });

  it('never serves one workspace\'s cached permissions to another for the same user', async () => {
    const { env } = fakeKv();
    await resolveEffectivePermissionsCached(
      env,
      'ws_1',
      'user_1',
      countedQueries({ role: 'MEMBER', roleId: null, permissions: ['weldcrm:leads:read'] }).queries,
    );

    const other = countedQueries({ role: 'VIEWER', roleId: null, permissions: [] });
    const resolved = await resolveEffectivePermissionsCached(env, 'ws_2', 'user_1', other.queries);

    expect(other.calls.getMember).toBe(1);
    expect(resolved.permissions).not.toContain('weldcrm:leads:read');
  });

  it('caches with the documented 24h TTL', async () => {
    const { env, kv } = fakeKv();
    await resolveEffectivePermissionsCached(
      env,
      'ws_1',
      'user_1',
      countedQueries({ role: 'MEMBER', roleId: null, permissions: [] }).queries,
    );
    expect(PERMISSIONS_CACHE_TTL_SECONDS).toBe(86_400);
    expect(kv.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { expirationTtl: 86_400 },
    );
  });

  it('re-resolves once the workspace version is bumped, and ignores the stale entry', async () => {
    const { env } = fakeKv();
    await resolveEffectivePermissionsCached(
      env,
      'ws_1',
      'user_1',
      countedQueries({ role: 'MEMBER', roleId: null, permissions: ['weldcrm:leads:read'] }).queries,
    );

    await bumpPermissionsVersion(env, 'ws_1');

    const afterBump = countedQueries({ role: 'MEMBER', roleId: null, permissions: [] });
    const resolved = await resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', afterBump.queries);

    expect(afterBump.calls.getMember).toBe(1);
    expect(resolved.permissions).not.toContain('weldcrm:leads:read');
  });

  it('never caches a failed resolution', async () => {
    const { env, store } = fakeKv();
    const queries: PermissionDbQuery = {
      getMember: async () => {
        throw new Error('db down');
      },
      getRolePermissions: async () => [],
      getTeamPermissions: async () => [],
    };

    await expect(resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', queries)).rejects.toThrow('db down');
    expect(store.size).toBe(0);
  });

  it('never caches a resolution for a user with no active member row', async () => {
    const { env, store } = fakeKv();
    const { queries, calls } = noMemberQueries();

    const first = await resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', queries);
    expect(first).toMatchObject({ permissions: [], role: '', isOwner: false });
    // Nothing written under the resolved-permissions key (the version key
    // isn't written by this function either, only by bumpPermissionsVersion).
    expect(store.size).toBe(0);

    // A path that later adds the member without bumping the version (a
    // missed writer) must not find them still "cached" as locked out.
    const second = await resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', queries);
    expect(second).toMatchObject({ permissions: [], role: '' });
    expect(calls.getMember).toBe(2);
  });

  it('falls back to the database when reading the version fails, and caches nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = {
      WORKSPACE_CACHE: {
        get: vi.fn(async () => {
          throw new Error('kv down');
        }),
        put: vi.fn(),
      } as unknown as KVNamespace,
    };
    const { queries, calls } = countedQueries({ role: 'MEMBER', roleId: null, permissions: ['weldcrm:leads:read'] });

    const resolved = await resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', queries);

    expect(calls.getMember).toBe(1);
    expect(resolved.permissions).toContain('weldcrm:leads:read');
    expect(env.WORKSPACE_CACHE.put).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to the database when reading the cached entry fails, but still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = {
      WORKSPACE_CACHE: {
        get: vi
          .fn()
          // The version read succeeds...
          .mockResolvedValueOnce('0')
          // ...but reading the cached entry itself fails.
          .mockRejectedValueOnce(new Error('kv down')),
        put: vi.fn(),
      } as unknown as KVNamespace,
    };
    const { queries, calls } = countedQueries({ role: 'MEMBER', roleId: null, permissions: ['weldcrm:leads:read'] });

    const resolved = await resolveEffectivePermissionsCached(env, 'ws_1', 'user_1', queries);

    expect(calls.getMember).toBe(1);
    expect(resolved.permissions).toContain('weldcrm:leads:read');
    warn.mockRestore();
  });

  it('resolves straight from the database without a workspace id', async () => {
    const { env, kv } = fakeKv();
    const { queries, calls } = countedQueries({ role: 'MEMBER', roleId: null, permissions: [] });

    await resolveEffectivePermissionsCached(env, undefined, 'user_1', queries);

    expect(calls.getMember).toBe(1);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('records a cache hit and a miss in the request timing', async () => {
    const { env } = fakeKv();
    const timing = new RequestTiming(0);
    await resolveEffectivePermissionsCached(
      env,
      'ws_1',
      'user_1',
      countedQueries({ role: 'MEMBER', roleId: null, permissions: [] }).queries,
      timing,
    );
    expect(timing.summary().permCache).toBe('miss');

    const hitTiming = new RequestTiming(0);
    await resolveEffectivePermissionsCached(
      env,
      'ws_1',
      'user_1',
      countedQueries({ role: 'OWNER', roleId: null, permissions: [] }).queries,
      hitTiming,
    );
    expect(hitTiming.summary().permCache).toBe('hit');
    expect(hitTiming.serverTimingHeader()).toContain('desc="cached"');
  });
});
