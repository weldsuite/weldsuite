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

  it('scopes the cache key by workspace, user and version', () => {
    expect(permissionsCacheKey('ws_1', 'user_1', '3')).toBe('permr:ws_1:user_1:3');
    // Never the same key across workspaces or users.
    expect(permissionsCacheKey('ws_2', 'user_1', '3')).not.toBe(permissionsCacheKey('ws_1', 'user_1', '3'));
    expect(permissionsCacheKey('ws_1', 'user_2', '3')).not.toBe(permissionsCacheKey('ws_1', 'user_1', '3'));
  });
});

describe('bumpPermissionsVersion', () => {
  it('starts a workspace with no prior version at 1', async () => {
    const { env, store } = fakeKv();
    await bumpPermissionsVersion(env, 'ws_1');
    expect(store.get('permv:ws_1')).toBe('1');
  });

  it('increments an existing version', async () => {
    const { env, store } = fakeKv({ 'permv:ws_1': '4' });
    await bumpPermissionsVersion(env, 'ws_1');
    expect(store.get('permv:ws_1')).toBe('5');
  });

  it('treats a corrupt version as 0 rather than throwing', async () => {
    const { env, store } = fakeKv({ 'permv:ws_1': 'not-a-number' });
    await bumpPermissionsVersion(env, 'ws_1');
    expect(store.get('permv:ws_1')).toBe('1');
  });

  it('writes with no TTL: the version must outlive any cached entry', async () => {
    const { env, kv } = fakeKv();
    await bumpPermissionsVersion(env, 'ws_1');
    expect(kv.put).toHaveBeenCalledWith('permv:ws_1', '1');
  });

  it('bumps only the named workspace', async () => {
    const { env, store } = fakeKv({ 'permv:ws_1': '1', 'permv:ws_2': '1' });
    await bumpPermissionsVersion(env, 'ws_1');
    expect(store.get('permv:ws_1')).toBe('2');
    expect(store.get('permv:ws_2')).toBe('1');
  });

  it('never throws when KV is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = {
      WORKSPACE_CACHE: {
        get: vi.fn(async () => {
          throw new Error('kv down');
        }),
        put: vi.fn(),
      },
    };
    await expect(bumpPermissionsVersion(env, 'ws_1')).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
