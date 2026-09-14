/**
 * Offline read-cache for WeldChat lists (channels, sections, DMs).
 *
 * Org-scoped, versioned AsyncStorage envelopes. Screens read cache-first so
 * Home/DMs paint instantly on cold start, then revalidate from the network;
 * on failure they keep the cached data instead of blanking out.
 *
 * Mirrors weldmail-app/lib/offline/cache.ts — same envelope + latch pattern.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'weldchat.cache';
/** Bump to invalidate every cached entry after a stored-shape change. */
const VERSION = 1;

interface Envelope<T> {
  v: number;
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

/**
 * Typed accessors so call sites don't hand-build key arrays. Each getter
 * returns `null` on a miss; callers decide how to render that.
 */
export const chatCache = {
  getChannels: (orgId: string) => readEntry<unknown[]>(orgId, ['channels']),
  setChannels: (orgId: string, channels: unknown[]) => writeEntry(orgId, ['channels'], channels),

  getSections: (orgId: string) => readEntry<unknown[]>(orgId, ['sections']),
  setSections: (orgId: string, sections: unknown[]) => writeEntry(orgId, ['sections'], sections),

  getDms: (orgId: string) => readEntry<unknown[]>(orgId, ['dms']),
  setDms: (orgId: string, dms: unknown[]) => writeEntry(orgId, ['dms'], dms),

  clearOrg: clearOrgCache,
};
