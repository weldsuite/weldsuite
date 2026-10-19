/**
 * The workspace entry this worker caches in API_CACHE: `mcp:org:<clerkOrgId>`
 * (tenant database URL, tier, licence, read-only / database-move state). Not
 * the `ws:<clerkOrgId>` entry the first-party API workers keep in
 * WORKSPACE_CACHE.
 *
 * A database move (TASK-1150) rotates the source role's password, which kills
 * the URL in this entry; `forgetWorkspaceForOrg` drops it so the next request
 * resolves the workspace from master again.
 */

/** The API_CACHE key of an organization's cached workspace. */
export function workspaceOrgCacheKey(clerkOrgId: string): string {
  return `mcp:org:${clerkOrgId}`;
}

/**
 * Drop an organization's cached workspace. Never throws: a failed purge (or a
 * missing binding) only leaves the entry to expire on its own.
 */
export async function forgetWorkspaceForOrg(kv: KVNamespace | undefined, clerkOrgId: string): Promise<void> {
  try {
    await kv?.delete(workspaceOrgCacheKey(clerkOrgId));
  } catch (err) {
    console.warn('[MCP Server] could not purge a workspace cache entry:', err instanceof Error ? err.message : 'unknown error');
  }
}
