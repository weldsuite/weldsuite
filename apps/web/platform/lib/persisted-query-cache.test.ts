import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_QUERY_CACHE_KEY,
  MAX_PERSISTED_WORKSPACES,
  QUERY_CACHE_INDEX_KEY,
  QUERY_CACHE_MAX_AGE,
  pruneQueryCaches,
  queryCacheKey,
  removeAllQueryCaches,
  removeQueryCache,
  setWritableQueryCacheOrg,
  workspaceCacheStorage,
} from './persisted-query-cache';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ track: trackMock }));

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function index(): Record<string, number> {
  return JSON.parse(localStorage.getItem(QUERY_CACHE_INDEX_KEY) ?? '{}');
}

/** Seed one workspace's entry, last written `ageMs` before NOW. */
function seed(orgId: string, ageMs: number) {
  localStorage.setItem(queryCacheKey(orgId), `cache:${orgId}`);
  localStorage.setItem(QUERY_CACHE_INDEX_KEY, JSON.stringify({ ...index(), [orgId]: NOW - ageMs }));
}

/** A storage whose cache entries fill up after `capacity` characters (the index is free). */
function boundedStorage(capacity: number): Storage {
  const items = new Map<string, string>();
  const used = () =>
    [...items].reduce((n, [k, v]) => (k.startsWith('weldsuite:query-cache:') ? n + v.length : n), 0);
  return {
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => {
      const entry = k.startsWith('weldsuite:query-cache:');
      if (entry && used() - (items.get(k)?.length ?? 0) + v.length > capacity) {
        throw new DOMException('full', 'QuotaExceededError');
      }
      items.set(k, v);
    },
    removeItem: (k) => {
      items.delete(k);
    },
    clear: () => items.clear(),
  };
}

beforeEach(() => {
  localStorage.clear();
  setWritableQueryCacheOrg(null);
  trackMock.mockClear();
});

afterEach(() => {
  setWritableQueryCacheOrg(null);
});

describe('queryCacheKey', () => {
  it('keys the cache by Clerk org id', () => {
    expect(queryCacheKey('org_acme')).toBe('weldsuite:query-cache:org_acme');
  });
});

describe('workspaceCacheStorage', () => {
  it("writes the workspace's own entry and stamps the index", () => {
    setWritableQueryCacheOrg('org_acme');
    workspaceCacheStorage('org_acme', localStorage, () => NOW).setItem('ignored', 'data');

    expect(localStorage.getItem('weldsuite:query-cache:org_acme')).toBe('data');
    expect(index()).toEqual({ org_acme: NOW });
  });

  it("leaves other workspaces' entries alone", () => {
    seed('org_globex', HOUR);
    setWritableQueryCacheOrg('org_acme');
    workspaceCacheStorage('org_acme', localStorage, () => NOW).setItem('ignored', 'data');

    expect(localStorage.getItem('weldsuite:query-cache:org_globex')).toBe('cache:org_globex');
    expect(index()).toEqual({ org_globex: NOW - HOUR, org_acme: NOW });
  });

  it('drops writes once the tab has switched to another org', () => {
    setWritableQueryCacheOrg('org_globex');
    workspaceCacheStorage('org_acme', localStorage, () => NOW).setItem('ignored', 'data');

    expect(localStorage.getItem('weldsuite:query-cache:org_acme')).toBeNull();
    expect(localStorage.getItem('weldsuite:query-cache:org_globex')).toBeNull();
  });

  it('drops writes when signed out', () => {
    workspaceCacheStorage('org_acme', localStorage, () => NOW).setItem('ignored', 'data');
    expect(localStorage).toHaveLength(0);
  });

  it("reads and removes only the workspace's own entry", () => {
    seed('org_acme', HOUR);
    seed('org_globex', HOUR);
    const storage = workspaceCacheStorage('org_acme', localStorage);

    expect(storage.getItem('ignored')).toBe('cache:org_acme');
    storage.removeItem('ignored');
    expect(localStorage.getItem('weldsuite:query-cache:org_acme')).toBeNull();
    expect(localStorage.getItem('weldsuite:query-cache:org_globex')).toBe('cache:org_globex');
    expect(Object.keys(index())).toEqual(['org_globex']);
  });

  it('makes room by removing the oldest other workspaces when storage is full', () => {
    const storage = boundedStorage(30);
    storage.setItem(queryCacheKey('org_old'), 'x'.repeat(10));
    storage.setItem(queryCacheKey('org_new'), 'y'.repeat(10));
    storage.setItem(QUERY_CACHE_INDEX_KEY, JSON.stringify({ org_old: NOW - 2 * HOUR, org_new: NOW - HOUR }));
    // 15 more does not fit next to 20; removing the oldest other is enough.
    setWritableQueryCacheOrg('org_acme');
    workspaceCacheStorage('org_acme', storage, () => NOW).setItem('ignored', 'z'.repeat(15));

    expect(storage.getItem(queryCacheKey('org_acme'))).toBe('z'.repeat(15));
    expect(storage.getItem(queryCacheKey('org_old'))).toBeNull();
    expect(storage.getItem(queryCacheKey('org_new'))).toBe('y'.repeat(10));
    expect(JSON.parse(storage.getItem(QUERY_CACHE_INDEX_KEY) ?? '{}')).toEqual({ org_new: NOW - HOUR, org_acme: NOW });
  });

  it('gives up quietly when the entry does not fit on its own', () => {
    const storage = boundedStorage(5);
    setWritableQueryCacheOrg('org_acme');
    expect(() => workspaceCacheStorage('org_acme', storage).setItem('ignored', 'too big')).not.toThrow();
    expect(storage.getItem(queryCacheKey('org_acme'))).toBeNull();
  });

  it('reports a too-big entry once, not on every write', () => {
    const storage = boundedStorage(5);
    setWritableQueryCacheOrg('org_acme');
    const acme = workspaceCacheStorage('org_acme', storage);

    acme.setItem('ignored', 'too big');
    acme.setItem('ignored', 'still too big');
    acme.setItem('ignored', 'and again');

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Query Cache Too Big', expect.objectContaining({ orgId: 'org_acme' }));
  });

  it('does not report when the entry fits', () => {
    setWritableQueryCacheOrg('org_acme');
    workspaceCacheStorage('org_acme', localStorage, () => NOW).setItem('ignored', 'data');
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('stops evicting other workspaces once its own entry is too big, and drops its outdated snapshot', () => {
    const storage = boundedStorage(20);
    storage.setItem(queryCacheKey('org_acme'), 'a'.repeat(5));
    storage.setItem(queryCacheKey('org_globex'), 'g'.repeat(10));
    setWritableQueryCacheOrg('org_acme');
    const acme = workspaceCacheStorage('org_acme', storage, () => NOW);

    // Fits nowhere: Globex goes on the first try, and only then is that known.
    acme.setItem('ignored', 'z'.repeat(25));
    expect(storage.getItem(queryCacheKey('org_acme'))).toBeNull();
    expect(storage.getItem(queryCacheKey('org_globex'))).toBeNull();

    // Another tab writes Globex again; this page no longer evicts it.
    storage.setItem(queryCacheKey('org_globex'), 'g'.repeat(10));
    acme.setItem('ignored', 'z'.repeat(15));
    expect(storage.getItem(queryCacheKey('org_globex'))).toBe('g'.repeat(10));
    expect(storage.getItem(queryCacheKey('org_acme'))).toBeNull();

    // A write that fits on its own still lands.
    acme.setItem('ignored', 'z'.repeat(8));
    expect(storage.getItem(queryCacheKey('org_acme'))).toBe('z'.repeat(8));
  });
});

describe('pruneQueryCaches', () => {
  it('drops the legacy shared entry', () => {
    localStorage.setItem(LEGACY_QUERY_CACHE_KEY, '{"buster":"v2:org_acme"}');
    pruneQueryCaches('org_acme', localStorage, NOW);
    expect(localStorage.getItem(LEGACY_QUERY_CACHE_KEY)).toBeNull();
  });

  it(`keeps the current workspace and the ${MAX_PERSISTED_WORKSPACES - 1} most recent others`, () => {
    seed('org_a', 4 * HOUR);
    seed('org_b', 3 * HOUR);
    seed('org_c', 2 * HOUR);
    seed('org_d', HOUR);
    pruneQueryCaches('org_a', localStorage, NOW);

    expect(localStorage.getItem(queryCacheKey('org_a'))).not.toBeNull();
    expect(localStorage.getItem(queryCacheKey('org_b'))).toBeNull();
    expect(localStorage.getItem(queryCacheKey('org_c'))).not.toBeNull();
    expect(localStorage.getItem(queryCacheKey('org_d'))).not.toBeNull();
    expect(Object.keys(index()).sort()).toEqual(['org_a', 'org_c', 'org_d']);
  });

  it('counts a workspace without an entry yet as taking a slot', () => {
    seed('org_b', 3 * HOUR);
    seed('org_c', 2 * HOUR);
    seed('org_d', HOUR);
    pruneQueryCaches('org_new', localStorage, NOW);

    expect(localStorage.getItem(queryCacheKey('org_b'))).toBeNull();
    expect(localStorage.getItem(queryCacheKey('org_c'))).not.toBeNull();
    expect(localStorage.getItem(queryCacheKey('org_d'))).not.toBeNull();
  });

  it('drops entries not written within the max age', () => {
    seed('org_acme', HOUR);
    seed('org_stale', QUERY_CACHE_MAX_AGE + HOUR);
    pruneQueryCaches('org_acme', localStorage, NOW);

    expect(localStorage.getItem(queryCacheKey('org_stale'))).toBeNull();
    expect(index()).toEqual({ org_acme: NOW - HOUR });
  });

  it('treats an entry missing from the index as the oldest', () => {
    seed('org_b', 2 * HOUR);
    seed('org_c', HOUR);
    localStorage.setItem(queryCacheKey('org_unindexed'), 'cache');
    pruneQueryCaches('org_a', localStorage, NOW);

    expect(localStorage.getItem(queryCacheKey('org_unindexed'))).toBeNull();
    expect(localStorage.getItem(queryCacheKey('org_b'))).not.toBeNull();
  });

  it("falls back to an unindexed entry's own timestamp", () => {
    localStorage.setItem(queryCacheKey('org_other_tab'), JSON.stringify({ buster: 'v2:org_other_tab', timestamp: NOW - HOUR }));
    pruneQueryCaches('org_acme', localStorage, NOW);

    expect(localStorage.getItem(queryCacheKey('org_other_tab'))).not.toBeNull();
    expect(index()).toEqual({ org_other_tab: NOW - HOUR });
  });

  it('forgets index rows whose entry is gone, and survives a corrupt index', () => {
    seed('org_acme', HOUR);
    localStorage.setItem(QUERY_CACHE_INDEX_KEY, JSON.stringify({ org_acme: NOW - HOUR, org_gone: NOW }));
    pruneQueryCaches('org_acme', localStorage, NOW);
    expect(index()).toEqual({ org_acme: NOW - HOUR });

    localStorage.setItem(QUERY_CACHE_INDEX_KEY, 'not json');
    expect(() => pruneQueryCaches('org_acme', localStorage, NOW)).not.toThrow();
  });
});

describe('removeQueryCache / removeAllQueryCaches', () => {
  it("removes one workspace's entry", () => {
    seed('org_acme', HOUR);
    seed('org_globex', HOUR);
    removeQueryCache('org_acme', localStorage);

    expect(localStorage.getItem(queryCacheKey('org_acme'))).toBeNull();
    expect(Object.keys(index())).toEqual(['org_globex']);
  });

  it('removes every entry, the legacy key and the index, and nothing else', () => {
    seed('org_acme', HOUR);
    seed('org_globex', HOUR);
    localStorage.setItem(LEGACY_QUERY_CACHE_KEY, '{}');
    localStorage.setItem('weldsuite:theme', 'dark');
    removeAllQueryCaches(localStorage);

    expect(Object.keys(localStorage)).toEqual(['weldsuite:theme']);
  });
});
