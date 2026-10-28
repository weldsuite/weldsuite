/**
 * Key format for the mailbox-directory KV cache, and the version read/bump
 * writers call after a directory-affecting change.
 *
 * Hand-rolls its own fake KV rather than `@weldsuite/worker-kit/testing/d1`'s
 * `createMemoryKv()` — worker-kit depends on `@weldsuite/db`, so importing it
 * back from here would be circular. `./permissions-cache.test.ts` does the
 * same for the same reason.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  bumpMailboxDirectoryVersion,
  mailboxDirectoryCacheKey,
  mailboxDirectoryVersionKey,
  readMailboxDirectoryVersion,
  MAILBOX_DIRECTORY_CACHE_TTL_SECONDS,
} from './mailbox-directory-cache';

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
  return { kv, store };
}

describe('key format', () => {
  it('scopes the version key by workspace only', () => {
    expect(mailboxDirectoryVersionKey('ws_1')).toBe('mbxdirv:ws_1');
  });

  it('scopes the entry key by workspace and version', () => {
    expect(mailboxDirectoryCacheKey('ws_1', '3')).toBe('mbxdir:ws_1:3');
    // Never the same key across workspaces or versions.
    expect(mailboxDirectoryCacheKey('ws_2', '3')).not.toBe(mailboxDirectoryCacheKey('ws_1', '3'));
    expect(mailboxDirectoryCacheKey('ws_1', '4')).not.toBe(mailboxDirectoryCacheKey('ws_1', '3'));
  });
});

describe('MAILBOX_DIRECTORY_CACHE_TTL_SECONDS', () => {
  it('is 7 days', () => {
    expect(MAILBOX_DIRECTORY_CACHE_TTL_SECONDS).toBe(60 * 60 * 24 * 7);
  });
});

describe('readMailboxDirectoryVersion', () => {
  it('defaults to 0 for a workspace with no version written yet', async () => {
    const { kv } = fakeKv();
    await expect(readMailboxDirectoryVersion(kv, 'ws_1')).resolves.toBe('0');
  });

  it('returns the stored version', async () => {
    const { kv } = fakeKv({ 'mbxdirv:ws_1': '5' });
    await expect(readMailboxDirectoryVersion(kv, 'ws_1')).resolves.toBe('5');
  });

  it('reads only the named workspace', async () => {
    const { kv } = fakeKv({ 'mbxdirv:ws_1': '1', 'mbxdirv:ws_2': '9' });
    await expect(readMailboxDirectoryVersion(kv, 'ws_1')).resolves.toBe('1');
    await expect(readMailboxDirectoryVersion(kv, 'ws_2')).resolves.toBe('9');
  });

  it('returns 0 rather than throwing when KV is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kv = { get: vi.fn(async () => { throw new Error('kv down'); }), put: vi.fn() };
    await expect(readMailboxDirectoryVersion(kv, 'ws_1')).resolves.toBe('0');
    warn.mockRestore();
  });
});

describe('bumpMailboxDirectoryVersion', () => {
  it('starts a workspace with no prior version at 1', async () => {
    const { kv, store } = fakeKv();
    await bumpMailboxDirectoryVersion(kv, 'ws_1');
    expect(store.get('mbxdirv:ws_1')).toBe('1');
  });

  it('increments an existing version', async () => {
    const { kv, store } = fakeKv({ 'mbxdirv:ws_1': '4' });
    await bumpMailboxDirectoryVersion(kv, 'ws_1');
    expect(store.get('mbxdirv:ws_1')).toBe('5');
  });

  it('treats a corrupt version as 0 rather than throwing', async () => {
    const { kv, store } = fakeKv({ 'mbxdirv:ws_1': 'not-a-number' });
    await bumpMailboxDirectoryVersion(kv, 'ws_1');
    expect(store.get('mbxdirv:ws_1')).toBe('1');
  });

  it('writes with no TTL: the version must outlive any cached entry', async () => {
    const { kv } = fakeKv();
    await bumpMailboxDirectoryVersion(kv, 'ws_1');
    expect(kv.put).toHaveBeenCalledWith('mbxdirv:ws_1', '1');
  });

  it('bumps only the named workspace', async () => {
    const { kv, store } = fakeKv({ 'mbxdirv:ws_1': '1', 'mbxdirv:ws_2': '1' });
    await bumpMailboxDirectoryVersion(kv, 'ws_1');
    expect(store.get('mbxdirv:ws_1')).toBe('2');
    expect(store.get('mbxdirv:ws_2')).toBe('1');
  });

  it('never throws when KV is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kv = {
      get: vi.fn(async () => {
        throw new Error('kv down');
      }),
      put: vi.fn(),
    };
    await expect(bumpMailboxDirectoryVersion(kv, 'ws_1')).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('a bumped version is visible to a subsequent read', async () => {
    const { kv } = fakeKv();
    await bumpMailboxDirectoryVersion(kv, 'ws_1');
    await bumpMailboxDirectoryVersion(kv, 'ws_1');
    await expect(readMailboxDirectoryVersion(kv, 'ws_1')).resolves.toBe('2');
  });
});
