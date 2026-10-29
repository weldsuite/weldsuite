/**
 * Caches a user's resolved effective permissions
 * (`@weldsuite/permissions`' `resolveEffectivePermissions`) in
 * `WORKSPACE_CACHE`, so the 1–3 sequential tenant queries it costs run at
 * most once per (workspace, user) per TTL per colo, instead of on every
 * request — including across the gaps between visits (a workspace's Neon
 * compute suspends after five idle minutes; a short-lived entry would always
 * be cold again by the next open). Wires in as the `resolve` hook
 * `createDrizzlePermissionQueries` / `initPermissionMiddleware` already
 * support (`@weldsuite/permissions/server`), so that package stays free of
 * worker-kit and KV imports — this is the "wrapping the queries/resolution"
 * piece (docs/plans/weldmail-mailbox-storage.md, phase 1 item 4). Registered
 * once per isolate by `ensurePermissionMiddleware` in ./app.ts.
 *
 * Keyed by workspace id + user id + a per-workspace version
 * (`bumpPermissionsVersion`, `@weldsuite/db/lib/permissions-cache`) that
 * every write affecting the result bumps, + the resolving code's version
 * (`PERMISSIONS_RESOLUTION_VERSION`), which a deploy changing the system-role
 * catalog or the resolver changes. Invalidation is the version bump,
 * not the TTL: a change is picked up on this colo immediately, and on every
 * other colo within ~60s (KV's propagation bound), because every write path
 * that can change a resolution calls `bumpPermissionsVersion`. The TTL below
 * is long precisely because of that — it only bounds the damage of a writer
 * that forgets to bump (a bug, not the normal case), not routine staleness.
 *
 * Never serves one workspace's or user's permissions to another (both are in
 * the key), never caches a failed resolution or one for a user with no
 * active member row (see the `role === ''` check below — a path that adds
 * the member without bumping the version must not leave them locked out for
 * the whole TTL), and a KV failure (read or write, either the version or the
 * cached entry) falls back to resolving from the tenant database rather than
 * failing the request.
 */

import {
  permissionsCacheKey,
  permissionsVersionKey,
} from '@weldsuite/db/lib/permissions-cache';
import {
  PERMISSIONS_RESOLUTION_VERSION,
  resolveEffectivePermissions,
  type PermissionDbQuery,
} from '@weldsuite/permissions/server';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import type { RequestTiming } from './timing';

/**
 * 24 hours: long enough to survive the gap between visits to a suspended
 * workspace (phase 0 found Neon suspending tenant computes after five idle
 * minutes), since invalidation on a change is the version bump, not this TTL
 * — see the module doc comment.
 */
export const PERMISSIONS_CACHE_TTL_SECONDS = 60 * 60 * 24;

export interface PermissionsCacheEnv {
  WORKSPACE_CACHE: KVNamespace;
}

/** A parsed KV value really is a `ResolvedPermissions`, not some other (or corrupt) JSON shape. */
function isResolvedPermissions(value: unknown): value is ResolvedPermissions {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ResolvedPermissions>;
  return (
    Array.isArray(v.permissions) &&
    typeof v.role === 'string' &&
    typeof v.isOwner === 'boolean' &&
    (v.roleId === null || typeof v.roleId === 'string') &&
    (v.denies === undefined || Array.isArray(v.denies))
  );
}

/**
 * Resolve `userId`'s effective permissions in `workspaceId`, serving a cached
 * result when one is fresh. `queries` is used only on a miss — it is the same
 * `PermissionDbQuery` the caller would otherwise hand straight to
 * `resolveEffectivePermissions`, so its calls are still timed by
 * `timePermissionQueries` exactly as before this cache existed.
 */
export async function resolveEffectivePermissionsCached(
  env: PermissionsCacheEnv,
  workspaceId: string | undefined,
  userId: string,
  queries: PermissionDbQuery,
  timing?: RequestTiming,
): Promise<ResolvedPermissions> {
  // No workspace (shouldn't happen past workspaceDbMiddleware, but a test
  // harness or a route reached without it might): nothing to key the cache
  // on, resolve straight from the database.
  if (!workspaceId) return resolveEffectivePermissions(queries, userId);

  let version: string | null;
  try {
    version = (await env.WORKSPACE_CACHE.get(permissionsVersionKey(workspaceId))) ?? '0';
  } catch (err) {
    console.warn(
      '[permission-cache] Could not read the permission version, resolving uncached:',
      err instanceof Error ? err.message : 'unknown error',
    );
    version = null;
  }

  // A KV failure reading the version: resolve straight from the database
  // rather than guess a version and risk serving — or caching — the result
  // under the wrong one.
  if (version === null) return resolveEffectivePermissions(queries, userId);

  const key = permissionsCacheKey(workspaceId, userId, version, PERMISSIONS_RESOLUTION_VERSION);
  const started = Date.now();
  let cached: unknown = null;
  try {
    cached = await env.WORKSPACE_CACHE.get(key, 'json');
  } catch (err) {
    console.warn('[permission-cache] KV read failed:', err instanceof Error ? err.message : 'unknown error');
  }

  if (isResolvedPermissions(cached)) {
    timing?.record('perm', Date.now() - started);
    timing?.notePermissionsCache('hit');
    return cached;
  }

  timing?.notePermissionsCache('miss');
  const resolved = await resolveEffectivePermissions(queries, userId);

  // `resolveEffectivePermissions` returns `role: ''` only when `getMember`
  // found no row at all (never for a real, if low-privilege, member — every
  // stored role is a non-empty tier name). Caching that for 24h would mean a
  // member added by a path that doesn't call `bumpPermissionsVersion` reads
  // back as locked out until the TTL expires, rather than just until their
  // next uncached request.
  if (resolved.role !== '') {
    try {
      await env.WORKSPACE_CACHE.put(key, JSON.stringify(resolved), {
        expirationTtl: PERMISSIONS_CACHE_TTL_SECONDS,
      });
    } catch (err) {
      console.warn('[permission-cache] KV write failed:', err instanceof Error ? err.message : 'unknown error');
    }
  }
  return resolved;
}
