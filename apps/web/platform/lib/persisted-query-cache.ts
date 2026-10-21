/**
 * Where the persisted TanStack Query cache lives in localStorage: one entry
 * per workspace (Clerk organization), `weldsuite:query-cache:{orgId}` (FE-014).
 *
 * Clerk keeps the active organization per tab, and the URL names the
 * workspace (FE-013), so two tabs can sit in two workspaces. Each tab reads
 * and writes only its own workspace's entry, so a reload in one tab no longer
 * throws away the other's cache, and a workspace switch has nothing to clear.
 *
 * Writes go through `workspaceCacheStorage`, which only writes while the tab's
 * active org is the entry's org. Between a `setActive` and the reload that
 * follows it, the page still holds the previous workspace's data in memory;
 * the guard keeps that data (and anything fetched with the new org's token)
 * out of either workspace's entry.
 */

/** Prefix of every per-workspace entry; the Clerk org id follows. */
export const QUERY_CACHE_KEY_PREFIX = 'weldsuite:query-cache:';
/** The single shared entry used before FE-014. Dropped, never migrated. */
export const LEGACY_QUERY_CACHE_KEY = 'weldsuite:query-cache';
/** `{ [orgId]: last write, epoch ms }`, used to keep the most recent entries. */
export const QUERY_CACHE_INDEX_KEY = 'weldsuite:query-cache-index';
/** How many workspaces keep a persisted cache; older ones are removed. */
export const MAX_PERSISTED_WORKSPACES = 3;
/** Entries older than this are dead: the persister discards them on restore anyway. */
export const QUERY_CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24h

type Index = Record<string, number>;

export function queryCacheKey(orgId: string): string {
  return `${QUERY_CACHE_KEY_PREFIX}${orgId}`;
}

// The org whose entry this tab may write: Clerk's active org, while signed in.
let writableOrgId: string | null = null;

/** Called by QueryProvider whenever the tab's active org changes (null: none / signed out). */
export function setWritableQueryCacheOrg(orgId: string | null): void {
  writableOrgId = orgId;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // storage disabled
  }
}

function readIndex(storage: Storage): Index {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(QUERY_CACHE_INDEX_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const index: Index = {};
    for (const [orgId, at] of Object.entries(parsed)) {
      if (typeof at === 'number') index[orgId] = at;
    }
    return index;
  } catch {
    return {};
  }
}

function writeIndex(storage: Storage, index: Index): void {
  try {
    if (Object.keys(index).length === 0) storage.removeItem(QUERY_CACHE_INDEX_KEY);
    else storage.setItem(QUERY_CACHE_INDEX_KEY, JSON.stringify(index));
  } catch {
    // quota or storage disabled; the index is only a hint for pruning
  }
}

/** Org ids of every per-workspace entry in storage. */
function storedOrgIds(storage: Storage): string[] {
  const ids: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(QUERY_CACHE_KEY_PREFIX)) ids.push(key.slice(QUERY_CACHE_KEY_PREFIX.length));
  }
  return ids;
}

function removeEntry(storage: Storage, orgId: string, index: Index): void {
  try {
    storage.removeItem(queryCacheKey(orgId));
  } catch {
    // storage disabled
  }
  delete index[orgId];
}

/**
 * Other workspaces' entries, oldest first. An entry missing from the index
 * (written while another tab updated it) counts as the oldest.
 */
function othersOldestFirst(storage: Storage, index: Index, keepOrgId: string): string[] {
  return storedOrgIds(storage)
    .filter((id) => id !== keepOrgId)
    .sort((a, b) => (index[a] ?? 0) - (index[b] ?? 0));
}

/** The `timestamp` the persister stored in an entry, or null when unreadable. */
function persistedTimestamp(storage: Storage, orgId: string): number | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(queryCacheKey(orgId)) ?? 'null');
    const at = (parsed as { timestamp?: unknown } | null)?.timestamp;
    return typeof at === 'number' ? at : null;
  } catch {
    return null;
  }
}

/**
 * The storage handed to the persister for one workspace's entry. Writes are
 * dropped unless `orgId` is the tab's active org; each write stamps the index.
 * When the quota is hit, other workspaces' entries are removed, oldest first,
 * until this one fits. An entry too big even on its own is removed too (it is
 * an outdated snapshot by now), and from then on this page evicts nothing:
 * every later write would empty other tabs' entries for nothing.
 */
export function workspaceCacheStorage(
  orgId: string,
  storage: Storage | null = defaultStorage(),
  now: () => number = Date.now,
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const key = queryCacheKey(orgId);
  let tooBig = false;
  return {
    getItem: () => {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (_key, value) => {
      if (!storage || writableOrgId !== orgId) return;
      const index = readIndex(storage);
      const evictable = tooBig ? [] : othersOldestFirst(storage, index, orgId);
      for (;;) {
        try {
          storage.setItem(key, value);
          break;
        } catch {
          const oldest = evictable.shift();
          if (!oldest) {
            // Too big on its own. The next write still tries, in case it shrank.
            tooBig = true;
            removeEntry(storage, orgId, index);
            writeIndex(storage, index);
            return;
          }
          removeEntry(storage, oldest, index);
        }
      }
      index[orgId] = now();
      writeIndex(storage, index);
    },
    removeItem: () => {
      if (!storage) return;
      const index = readIndex(storage);
      removeEntry(storage, orgId, index);
      writeIndex(storage, index);
    },
  };
}

/**
 * Housekeeping when a page starts persisting `currentOrgId`: drop the legacy
 * shared entry, entries not written for `QUERY_CACHE_MAX_AGE`, and all but the
 * `MAX_PERSISTED_WORKSPACES` most recent (the current one always stays).
 */
export function pruneQueryCaches(
  currentOrgId: string,
  storage: Storage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_QUERY_CACHE_KEY);
  } catch {
    return; // storage disabled
  }
  const index = readIndex(storage);
  const stored = new Set(storedOrgIds(storage));
  for (const orgId of Object.keys(index)) {
    if (!stored.has(orgId)) delete index[orgId];
  }
  // An entry another tab wrote while this index was being rewritten has no
  // row: read its own timestamp (rare, so the parse is affordable).
  for (const orgId of stored) {
    if (index[orgId] === undefined) {
      const at = persistedTimestamp(storage, orgId);
      if (at !== null) index[orgId] = at;
    }
  }
  const others = othersOldestFirst(storage, index, currentOrgId);
  // The current workspace has (or is about to get) its own entry.
  const room = MAX_PERSISTED_WORKSPACES - 1;
  others.forEach((orgId, i) => {
    const expired = now - (index[orgId] ?? 0) > QUERY_CACHE_MAX_AGE;
    if (expired || i < others.length - room) removeEntry(storage, orgId, index);
  });
  writeIndex(storage, index);
}

/** Remove one workspace's entry, e.g. after the workspace is deleted. */
export function removeQueryCache(orgId: string, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  const index = readIndex(storage);
  removeEntry(storage, orgId, index);
  writeIndex(storage, index);
}

/** Remove every persisted cache, the legacy entry and the index: sign-out. */
export function removeAllQueryCaches(storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    for (const orgId of storedOrgIds(storage)) storage.removeItem(queryCacheKey(orgId));
    storage.removeItem(LEGACY_QUERY_CACHE_KEY);
    storage.removeItem(QUERY_CACHE_INDEX_KEY);
  } catch {
    // storage disabled
  }
}
