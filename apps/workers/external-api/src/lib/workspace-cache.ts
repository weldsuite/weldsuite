/**
 * The workspace entry this worker caches in API_CACHE: `ws:<workspaces.id>`
 * (tenant database URL, tier, licence, read-only / database-move state). Not
 * the `ws:<clerkOrgId>` entry the first-party API workers keep in
 * WORKSPACE_CACHE.
 *
 * A database move (TASK-1150) rotates the source role's password, which kills
 * the URL in this entry; `forgetWorkspaceDetails` drops it so the next request
 * resolves the workspace from master again.
 */

/** The API_CACHE key of a workspace's cached details. */
export function workspaceDetailsCacheKey(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

/**
 * Drop a workspace's cached details. Never throws: a failed purge (or a missing
 * binding) only leaves the entry to expire on its own.
 */
export async function forgetWorkspaceDetails(kv: KVNamespace | undefined, workspaceId: string): Promise<void> {
  try {
    await kv?.delete(workspaceDetailsCacheKey(workspaceId));
  } catch (err) {
    console.warn('[external-api] could not purge a workspace cache entry:', err instanceof Error ? err.message : 'unknown error');
  }
}
