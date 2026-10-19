/**
 * The workspace entry this worker caches in API_CACHE: the sealed
 * `wsx:id:<workspaces.id>` entry (tenant database URL, tier, licence,
 * read-only / database-move state). Not the `wsx:<clerkOrgId>` entry the
 * first-party API workers keep in WORKSPACE_CACHE.
 *
 * A database move (TASK-1150) rotates the source role's password, which kills
 * the URL in this entry; `forgetWorkspaceDetails` drops it, and the old
 * plaintext `ws:<workspaces.id>` key a not-yet-redeployed worker may still
 * write, so the next request resolves the workspace from master again.
 */

import { sealedWorkspaceIdCacheKey } from '@weldsuite/db/lib/workspace-url-cache';

/** The API_CACHE key of a workspace's cached details (sealed). */
export function workspaceDetailsCacheKey(workspaceId: string): string {
  return sealedWorkspaceIdCacheKey(workspaceId);
}

/** The plaintext key used before entries were sealed; still purged. */
export function legacyWorkspaceDetailsCacheKey(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

/**
 * Drop a workspace's cached details. Never throws: a failed purge (or a missing
 * binding) only leaves the entry to expire on its own.
 */
export async function forgetWorkspaceDetails(kv: KVNamespace | undefined, workspaceId: string): Promise<void> {
  if (!kv) return;
  try {
    await Promise.all([
      kv.delete(workspaceDetailsCacheKey(workspaceId)),
      kv.delete(legacyWorkspaceDetailsCacheKey(workspaceId)),
    ]);
  } catch (err) {
    console.warn('[external-api] could not purge a workspace cache entry:', err instanceof Error ? err.message : 'unknown error');
  }
}
