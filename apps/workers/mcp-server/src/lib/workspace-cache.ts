/**
 * The workspace entry this worker caches in API_CACHE: the sealed
 * `mcpx:org:<clerkOrgId>` entry (tenant database URL, tier, licence,
 * read-only / database-move state). Not the `wsx:<clerkOrgId>` entry the
 * first-party API workers keep in WORKSPACE_CACHE.
 *
 * A database move (TASK-1150) rotates the source role's password, which kills
 * the URL in this entry; `forgetWorkspaceForOrg` drops it, and the old
 * plaintext `mcp:org:<clerkOrgId>` key a not-yet-redeployed worker may still
 * write, so the next request resolves the workspace from master again.
 */

import { sealedMcpOrgCacheKey } from '@weldsuite/db/lib/workspace-url-cache';

/** The API_CACHE key of an organization's cached workspace (sealed). */
export function workspaceOrgCacheKey(clerkOrgId: string): string {
  return sealedMcpOrgCacheKey(clerkOrgId);
}

/** The plaintext key used before entries were sealed; still purged. */
export function legacyWorkspaceOrgCacheKey(clerkOrgId: string): string {
  return `mcp:org:${clerkOrgId}`;
}

/**
 * Drop an organization's cached workspace. Never throws: a failed purge (or a
 * missing binding) only leaves the entry to expire on its own.
 */
export async function forgetWorkspaceForOrg(kv: KVNamespace | undefined, clerkOrgId: string): Promise<void> {
  if (!kv) return;
  try {
    await Promise.all([
      kv.delete(workspaceOrgCacheKey(clerkOrgId)),
      kv.delete(legacyWorkspaceOrgCacheKey(clerkOrgId)),
    ]);
  } catch (err) {
    console.warn('[MCP Server] could not purge a workspace cache entry:', err instanceof Error ? err.message : 'unknown error');
  }
}
