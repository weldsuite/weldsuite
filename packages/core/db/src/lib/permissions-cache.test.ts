/**
 * Key format for the resolved-permissions KV cache, and the version bump
 * writers call after a permission-affecting change.
 */

import { describe, expect, it, vi } from 'vitest';
import { bumpPermissionsVersion, permissionsCacheKey, permissionsVersionKey } from './permissions-cache';

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  return { env: { WORKSPACE_CACHE: kv }, kv, store };
}

describe('key format', () => {
  it('scopes the version key by workspace only', () => {
    expect(permissionsVersionKey('ws_1')).toBe('permv:ws_1');
  });

  it('scopes the cache key by resolver, workspace, user and version', () => {
    expect(permissionsCacheKey('ws_1', 'user_1', '3', '1.abc')).toBe('permr:1.abc:ws_1:user_1:3');
    // Never the same key across workspaces, users or resolver versions.
    const base = permissionsCacheKey('ws_1', 'user_1', '3', '1.abc');
    expect(permissionsCacheKey('ws_2', 'user_1', '3', '1.abc')).not.toBe(base);
    expect(permissionsCacheKey('ws_1', 'user_2', '3', '1.abc')).not.toBe(base);
    expect(permissionsCacheKey('ws_1', 'user_1', '3', '2.abc')).not.toBe(base);
  });
});

describe('bumpPermissionsVersion', () => {
  it('writes a new version for a workspace with none', async () => {
    const { env, store } = fakeKv();
    await bumpPermissionsVersion(env, 'ws_1');
    expect(store.get('permv:ws_1')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replaces an existing version with a different one', async () => {
    const { env, store } = fakeKv({ 'permv:ws_1': '4' });
    await bumpPermissionsVersion(env, 'ws_1');
    expect(store.get('permv:ws_1')).not.toBe('4');
  });

  it('never writes the same version twice, even from a stale read', async () => {
    // Two colos bumping within KV's propagation window both used to read the
    // same old value and write the same "next" one, which kept an entry
    // cached between the two bumps valid.
    const { env, store } = fakeKv();
    await bumpPermissionsVersion(env, 'ws_1');
    const first = store.get('permv:ws_1');
    await bumpPermissionsVersion(env, 'ws_1');
    expect(store.get('permv:ws_1')).not.toBe(first);
  });

  it('writes with no TTL and without reading first', async () => {
    const { env, kv } = fakeKv();
    await bumpPermissionsVersion(env, 'ws_1');
    expect(kv.put).toHaveBeenCalledWith('permv:ws_1', expect.any(String));
    expect(kv.put.mock.calls[0]).toHaveLength(2);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('bumps only the named workspace', async () => {
    const { env, store } = fakeKv({ 'permv:ws_1': '1', 'permv:ws_2': '1' });
    await bumpPermissionsVersion(env, 'ws_1');
    expect(store.get('permv:ws_1')).not.toBe('1');
    expect(store.get('permv:ws_2')).toBe('1');
  });

  it('never throws when KV is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = {
      WORKSPACE_CACHE: {
        put: vi.fn(async () => {
          throw new Error('kv down');
        }),
      },
    };
    await expect(bumpPermissionsVersion(env, 'ws_1')).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
