/**
 * KV keys for the resolved-permissions cache (`WORKSPACE_CACHE`), and the
 * version bump every write that changes what
 * `@weldsuite/permissions`' `resolveEffectivePermissions()` returns must call.
 * The read side (serving a cached result, with a TTL) lives in
 * `@weldsuite/worker-kit/permission-cache`, which every API worker's
 * `ensurePermissionMiddleware()` wires in; this module only holds the key
 * format and the writer-facing bump, so a worker that cannot depend on
 * worker-kit (workspace-worker's Clerk webhook, which keeps its own
 * tenant-DB plumbing) can still invalidate the cache after a write.
 *
 * Versioned rather than deleted: a write bumps `permv:<workspaceId>` and every
 * entry already cached under the old version is simply never looked up again
 * — it is left to expire on its own TTL. A read never needs to delete
 * anything.
 *
 * Invalidation is this version bump, not the cached entry's TTL (a long 24h,
 * see `PERMISSIONS_CACHE_TTL_SECONDS` in `@weldsuite/worker-kit/permission-cache`,
 * so a result survives the gap between visits to a suspended workspace).
 * Staleness after a real change is bounded by KV's propagation across colos
 * instead (up to ~60s), because every write path that can change a
 * resolution calls this function. The long TTL only bounds the damage of a
 * writer that forgets to — a bug this file's own doc comment asks every
 * caller to guard against, not the routine case.
 */

/** `WORKSPACE_CACHE` key of a workspace's permission-cache version counter. */
export function permissionsVersionKey(workspaceId: string): string {
  return `permv:${workspaceId}`;
}

/**
 * `WORKSPACE_CACHE` key of one user's resolved permissions, under a given
 * workspace version and the resolving code's `resolution` version
 * (`PERMISSIONS_RESOLUTION_VERSION`, `@weldsuite/permissions/server`), so a
 * deploy that changes the system-role catalog or the resolver skips every
 * entry the old code cached.
 */
export function permissionsCacheKey(workspaceId: string, userId: string, version: string, resolution: string): string {
  return `permr:${resolution}:${workspaceId}:${userId}:${version}`;
}

/**
 * The minimal KV surface this module needs. This package does not install
 * `@cloudflare/workers-types` (it is not itself a Worker), so a real
 * `KVNamespace` binding is typed structurally here instead — it satisfies
 * this interface, extra overloads and all.
 */
interface KvLike {
  put(key: string, value: string): Promise<void>;
}

/**
 * Bump a workspace's permission-cache version, so every permission already
 * cached for its members is skipped on the next request (left to expire on
 * its own). Call this — passing `workspaces.id`, never the Clerk org id —
 * right after any write that changes what `resolveEffectivePermissions()`
 * would return for ANY member of the workspace: a `workspace_members` row's
 * `role`, `roleId`, `permissions`, `permissionDenies`, `memberType`, `status`
 * or `deletedAt`; a custom role's `permissions`, or its soft-delete; or team
 * membership/permissions, once teams exist.
 *
 * Never throws: a failed bump only leaves the stale entries to expire on
 * their own TTL (up to 24h of staleness — see the module doc comment above)
 * rather than failing the write that triggered it. A write path that cannot
 * reach this function at all is the real risk; a KV outage during the bump
 * itself is the rarer, secondary one.
 */
export async function bumpPermissionsVersion(
  env: { WORKSPACE_CACHE: KvLike },
  workspaceId: string,
): Promise<void> {
  try {
    // A random value, not current + 1: KV reads can be stale across colos for
    // up to ~60s, so two bumps computing the same "next" would leave an entry
    // cached between them valid. The version only has to change, never to
    // increase. No TTL: it must outlive any individual cached entry.
    await env.WORKSPACE_CACHE.put(permissionsVersionKey(workspaceId), crypto.randomUUID());
  } catch (err) {
    console.warn(
      'Could not bump a workspace permission-cache version:',
      err instanceof Error ? err.message : 'unknown error',
    );
  }
}
