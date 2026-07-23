/**
 * Offline read-cache (Phase 1 of offline support).
 *
 * A thin, org-scoped, versioned key/value cache over AsyncStorage. Screens read
 * cache-first (show last-known data instantly) then revalidate from the network;
 * on a connectivity failure they keep the cached data instead of blanking out.
 * This is what makes the inbox/detail browsable offline and removes the
 * empty-on-cold-start class of bugs entirely.
 *
 * Scoping: every key is namespaced by the Clerk organization id so one
 * workspace's mail never bleeds into another's. Entries are wrapped in an
 * envelope carrying a schema VERSION — bump it and all older entries are
 * silently ignored (treated as a cache miss), so a shape change can't feed
 * malformed data back into the UI.
 *
 * Storage backend is AsyncStorage for now (lists are capped at ~50 items). The
 * surface here is deliberately small and swappable: Phase 1.x can move the
 * backend to expo-sqlite without touching call sites.
 *
 * This module is pure (no React) so it can be unit-tested directly.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'weldmail.cache';
/** Bump to invalidate every cached entry after a stored-shape change. */
const VERSION = 1;

interface Envelope<T> {
  /** Schema version the entry was written with. */
  v: number;
  /** Write timestamp (ms) — for future TTL/eviction; unused in Phase 1. */
  t: number;
  data: T;
}

function buildKey(orgId: string, parts: string[]): string {
  return `${PREFIX}.${orgId}.${parts.join('.')}`;
}

/** Read a cached entry, or null on miss / version mismatch / parse error. */
export async function readEntry<T>(orgId: string, parts: string[]): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(buildKey(orgId, parts));
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    if (!env || env.v !== VERSION) return null;
    return env.data;
  } catch {
    return null;
  }
}

/** Write a cached entry. Never throws — caching is best-effort. */
export async function writeEntry<T>(orgId: string, parts: string[], data: T): Promise<void> {
  try {
    const env: Envelope<T> = { v: VERSION, t: Date.now(), data };
    await AsyncStorage.setItem(buildKey(orgId, parts), JSON.stringify(env));
  } catch {
    // best-effort
  }
}

/** Drop every cached entry for one org (eviction / privacy on demand). */
export async function clearOrgCache(orgId: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.startsWith(`${PREFIX}.${orgId}.`));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } catch {
    // best-effort
  }
}

/** Cache key for a mailbox scope: the unified inbox or a specific account. */
export function scopeKey(isUnifiedInbox: boolean, accountId?: string | null): string {
  return isUnifiedInbox ? 'unified' : accountId ?? 'none';
}

/** Persisted label state for a scope (counts + custom labels). */
export interface CachedLabels {
  mainCounts: Record<string, number>;
  secondaryCounts: Record<string, number>;
  custom: unknown[];
}

/**
 * Typed, named accessors so call sites don't hand-build key arrays. Each list
 * accessor returns `null` on a miss; callers decide whether to render the miss
 * as empty or as a loading state.
 */
export const mailCache = {
  getMessages: (orgId: string, scope: string, label: string) =>
    readEntry<unknown[]>(orgId, ['messages', scope, label]),
  setMessages: (orgId: string, scope: string, label: string, messages: unknown[]) =>
    writeEntry(orgId, ['messages', scope, label], messages),

  getAccounts: (orgId: string) => readEntry<unknown[]>(orgId, ['accounts']),
  setAccounts: (orgId: string, accounts: unknown[]) => writeEntry(orgId, ['accounts'], accounts),

  getLabels: (orgId: string, scope: string) => readEntry<CachedLabels>(orgId, ['labels', scope]),
  setLabels: (orgId: string, scope: string, labels: CachedLabels) =>
    writeEntry(orgId, ['labels', scope], labels),

  getMessage: (orgId: string, id: string) => readEntry<Record<string, unknown>>(orgId, ['message', id]),
  setMessage: (orgId: string, id: string, message: Record<string, unknown>) =>
    writeEntry(orgId, ['message', id], message),

  getThread: (orgId: string, id: string) => readEntry<unknown[]>(orgId, ['thread', id]),
  setThread: (orgId: string, id: string, messages: unknown[]) =>
    writeEntry(orgId, ['thread', id], messages),

  clearOrg: clearOrgCache,
};
