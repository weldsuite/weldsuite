import 'server-only';

interface Entry {
  id: string;
  databaseUrl: string;
  expiresAt: number;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 200;
const cache = new Map<string, Entry>();

export function getCachedWorkspace(clerkOrgId: string): { id: string; databaseUrl: string } | null {
  const entry = cache.get(clerkOrgId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(clerkOrgId);
    return null;
  }
  return { id: entry.id, databaseUrl: entry.databaseUrl };
}

export function setCachedWorkspace(
  clerkOrgId: string,
  data: { id: string; databaseUrl: string },
): void {
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(clerkOrgId, { ...data, expiresAt: Date.now() + TTL_MS });
}
