/**
 * Master and tenant database clients for API workers.
 *
 * Tenant resolution: workspace ref → KV `wsx:<ref>` (300 s TTL) → on a miss,
 * the master DB row + `resolveDatabaseUrl`. Every API worker shares the
 * WORKSPACE_CACHE namespace, so a lookup cached by one worker serves all.
 *
 * A ref is either identifier of the workspace: `workspaces.id` or its Clerk org
 * id. The request context still carries the org id, but events, Workflows and
 * internal callers increasingly carry `workspaces.id`
 * (docs/plans/workspace-id-standardization.md), so every resolver here accepts
 * both and the entry is cached under the ref it was asked for.
 *
 * The cached entry never holds the connection string in the clear: it is sealed
 * with the DATABASE_ENCRYPTION_KEY keyring (`databaseUrlSealed`), like
 * `workspaces.database_url` itself. A worker without a keyring caches nothing.
 *
 * A database move (TASK-1150) changes what a cached entry says: the workflow
 * that drives it purges the entry when the soft lock starts and again after
 * the switch, and `forgetWorkspaceContext` drops the entry of a request that
 * found its database gone (rotated password). Both clear the sealed `wsx:<ref>`
 * and old plaintext `ws:<ref>` keys of both identifiers.
 */

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';
import {
  openCacheEntry,
  sealCacheEntry,
  sealedWorkspaceCacheKey,
} from '@weldsuite/db/lib/workspace-url-cache';
import type { DbEnv } from './env';
import { computeWorkspaceRestrictions, type ReadOnlyReason } from './read-only';
import { instrumentNeonClient, type RequestTiming } from './timing';
import { databaseMoveInProgressSql } from './workspace-moving';

export function getMasterDb(env: Pick<DbEnv, 'DATABASE_URL_MASTER'>): NeonHttpDatabase<typeof masterSchema> {
  const sql = neon(env.DATABASE_URL_MASTER);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

/** With `timing`, every Neon HTTP call the handle makes is recorded as `db` (./timing.ts). */
function createNeonTenantDb(connectionUrl: string, timing?: RequestTiming): NeonHttpDatabase<typeof schema> {
  const sql = neon(connectionUrl);
  if (timing) instrumentNeonClient(sql, timing);
  return drizzleNeonHttp({ client: sql, schema });
}

const KV_TTL_SECONDS = 300;

interface CachedWorkspace {
  id: string;
  /** The workspace's Clerk org id; null for a workspace that has none. */
  clerkOrgId: string | null;
  databaseUrl: string;
  /**
   * True when the workspace is suspended (not `isActive`). An admin scheduling
   * the workspace for deletion suspends it immediately; the request path must
   * reject access. Cached alongside the DB URL so the suspension check costs no
   * extra master-DB read; propagation is bounded by KV_TTL_SECONDS.
   */
  suspended: boolean;
  /**
   * App codes this workspace is licensed for, or null when it is unrestricted
   * (every app). Only partner-managed workspaces carry a licence
   * (docs/plans/reseller-licensing.md): their `workspace_licences.allowed_apps`,
   * `[]` (core only) when the row is missing. `licenceGate()` enforces it.
   */
  licensedApps: string[] | null;
  /**
   * True when the workspace may only be read: a partner-managed workspace whose
   * partner is suspended or whose licence is not active (`licenceGate()` refuses
   * writes with 403 WORKSPACE_READ_ONLY), or a workspace whose database is
   * being moved, reason `database_move` (503 WORKSPACE_MOVING). The move flag
   * is stored as the reason, so an entry cached before it existed simply reads
   * as not moving.
   */
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
}

/** What lands in KV: the cached shape with the URL sealed instead of in the clear. */
type StoredWorkspace = Omit<CachedWorkspace, 'clerkOrgId' | 'databaseUrl' | 'suspended' | 'readOnly' | 'readOnlyReason'> & {
  clerkOrgId?: string | null;
  databaseUrlSealed?: string;
  suspended?: boolean;
  readOnly?: boolean;
  readOnlyReason?: ReadOnlyReason | null;
};

/**
 * Other workers write `wsx:<ref>` entries too, with only the sealed DB URL (they predate
 * the licence). Such an entry has no `licensedApps` key at all, so it cannot say
 * whether the workspace is licensed: it is treated as a miss and re-resolved
 * from the master DB, rather than letting a partner workspace through
 * unrestricted for the TTL. (An entry saying `licensedApps: null` is explicit.)
 */
function isCompleteEntry(cached: StoredWorkspace): boolean {
  return cached.licensedApps !== undefined;
}

/** The KV key of a workspace's cached resolution (WORKSPACE_CACHE): the sealed entry, under the ref it was looked up by. */
export function workspaceCacheKey(ref: string): string {
  return sealedWorkspaceCacheKey(ref);
}

/**
 * The plaintext key workers used before entries were sealed. It is never read
 * any more, but a worker not yet redeployed may still write it, so a purge
 * clears it too.
 */
export function legacyWorkspaceCacheKey(ref: string): string {
  return `ws:${ref}`;
}

/**
 * Drop a workspace's cached resolution, so the next request reads the master DB
 * again. For a request whose tenant database refused the cached URL (the role's
 * password was rotated by a database move). Pass every identifier you know: an
 * entry may be cached under each. Never throws: a failed purge only leaves the
 * entry to expire on its own.
 */
export async function forgetWorkspaceContext(
  env: Pick<DbEnv, 'WORKSPACE_CACHE'>,
  ...refs: readonly (string | null | undefined)[]
): Promise<void> {
  const known = [...new Set(refs.filter((ref): ref is string => Boolean(ref)))];
  // This isolate's in-memory copy (if any) is as stale as the KV entry; a
  // database move relies on this clearing immediately, not waiting out its
  // few-second TTL, so it is dropped unconditionally even if the KV purge
  // below fails.
  for (const ref of known) forgetContextMemory(ref);
  try {
    await Promise.all(
      known.flatMap((ref) => [
        env.WORKSPACE_CACHE.delete(workspaceCacheKey(ref)),
        env.WORKSPACE_CACHE.delete(legacyWorkspaceCacheKey(ref)),
      ]),
    );
  } catch (err) {
    console.warn('Could not purge a workspace cache entry:', err instanceof Error ? err.message : 'unknown error');
  }
}

/**
 * The master-DB row tenant resolution reads for a workspace ref (its id or its
 * Clerk org id): the workspace, plus (for partner workspaces) its licence and
 * the partner's payment standing, plus whether a database move is blocking
 * writes. One query, one round trip; direct workspaces join to nothing.
 * Exported for the tests that run it on a real master schema.
 */
export async function selectWorkspaceForRef(masterDb: AnyMasterDatabase, ref: string) {
  const [workspace] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
      neonProjectId: masterSchema.workspaces.neonProjectId,
      neonBranchId: masterSchema.workspaces.neonBranchId,
      neonRoleName: masterSchema.workspaces.neonRoleName,
      neonDatabaseName: masterSchema.workspaces.neonDatabaseName,
      databaseUrl: masterSchema.workspaces.databaseUrl,
      isActive: masterSchema.workspaces.isActive,
      billingMode: masterSchema.workspaces.billingMode,
      licenceStatus: masterSchema.workspaceLicences.status,
      licenceApps: masterSchema.workspaceLicences.allowedApps,
      partnerStatus: masterSchema.partners.status,
      databaseMoveInProgress: databaseMoveInProgressSql(),
    })
    .from(masterSchema.workspaces)
    .leftJoin(
      masterSchema.workspaceLicences,
      eq(masterSchema.workspaceLicences.workspaceId, masterSchema.workspaces.id),
    )
    .leftJoin(masterSchema.partners, eq(masterSchema.partners.id, masterSchema.workspaces.partnerId))
    .where(matchWorkspaceRef(ref))
    .limit(1);
  return workspace;
}

/**
 * `timing` (optional) records the KV traffic as `kv`, the master lookup and URL
 * resolution as `master`, and whether the entry was a cache hit.
 *
 * Only ever runs through `getCachedWorkspaceUrl`'s isolate-level coalescing
 * below, so a `ref` already in flight (or resolved within the last few
 * seconds) never re-enters this function.
 */
async function resolveCachedWorkspaceUrl(env: DbEnv, ref: string, timing?: RequestTiming): Promise<CachedWorkspace> {
  // Sealed entries live under `wsx:`; the old plaintext `ws:<ref>` key is never
  // read (a worker not yet redeployed still writes it, and it expires on its own).
  const cacheKey = workspaceCacheKey(ref);
  const keyring = { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
  // `suspended` and `readOnly` were added later: an entry cached before they
  // existed omits them and reads as not-suspended / not read-only (it refreshes
  // within KV_TTL_SECONDS). The same goes for a database move, which is stored
  // as `readOnlyReason: 'database_move'`.
  const readCache = () => env.WORKSPACE_CACHE.get(cacheKey, 'json') as Promise<StoredWorkspace | null>;
  const cached = await (timing ? timing.measure('kv', readCache) : readCache());
  if (cached && isCompleteEntry(cached)) {
    // A sealed URL this worker cannot open (rotated key, tampering) is a miss.
    const opened = await openCacheEntry(cached, keyring);
    if (opened) {
      timing?.noteWorkspaceCache('hit');
      return {
        ...opened,
        // Entries cached before the field existed were only ever keyed by the org id.
        clerkOrgId: cached.clerkOrgId !== undefined ? cached.clerkOrgId : ref,
        suspended: cached.suspended ?? false,
        readOnly: cached.readOnly ?? false,
        readOnlyReason: cached.readOnly ? (cached.readOnlyReason ?? 'licence_inactive') : null,
      };
    }
  }

  timing?.noteWorkspaceCache('miss');
  const resolve = () => resolveWorkspaceFromMaster(env, ref, keyring);
  const entry = await (timing ? timing.measure('master', resolve) : resolve());
  // No keyring → nothing to seal with → do not cache (never a plaintext fallback).
  const stored: StoredWorkspace | null = await sealCacheEntry(entry, keyring);
  if (stored) {
    const writeCache = () =>
      env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(stored), { expirationTtl: KV_TTL_SECONDS });
    await (timing ? timing.measure('kv', writeCache) : writeCache());
  }

  return entry;
}

/**
 * Coalesces concurrent and back-to-back lookups of the same `ref` within this
 * isolate, so the several requests one page load fires in parallel (or in
 * quick succession) share a single KV read (and master query on a miss)
 * instead of each paying for it. Not a replacement for the KV cache above —
 * a fresh isolate, or one past this TTL, still goes through it.
 *
 * Each entry's `expiresAt` is set when the lookup STARTS, not when it
 * resolves, so a slow master query can't extend how long its result is
 * reused past the nominal TTL. A rejected lookup is never kept: the entry is
 * dropped as soon as its promise rejects, so the next caller retries instead
 * of replaying the same failure for the rest of the window.
 */
const CONTEXT_MEMORY_TTL_MS = 10_000;
/** Upper bound on distinct refs remembered per isolate — a small, cheap map. */
const CONTEXT_MEMORY_MAX_ENTRIES = 1_000;

interface MemoryCacheEntry {
  promise: Promise<CachedWorkspace>;
  expiresAt: number;
}

const contextMemoryCache = new Map<string, MemoryCacheEntry>();

/** Drop expired entries, then (rare) the oldest ones until back under the cap. */
function pruneContextMemoryCache(now: number): void {
  for (const [ref, entry] of contextMemoryCache) {
    if (entry.expiresAt <= now) contextMemoryCache.delete(ref);
  }
  while (contextMemoryCache.size > CONTEXT_MEMORY_MAX_ENTRIES) {
    const oldest = contextMemoryCache.keys().next().value;
    if (oldest === undefined) break;
    contextMemoryCache.delete(oldest);
  }
}

/** Forget a ref's in-memory entry — `forgetWorkspaceContext` calls this alongside the KV purge. */
function forgetContextMemory(ref: string): void {
  contextMemoryCache.delete(ref);
}

/** Test-only: clear every isolate-memory entry so tests don't leak into each other. */
export function __resetContextMemoryForTests(): void {
  contextMemoryCache.clear();
}

async function getCachedWorkspaceUrl(env: DbEnv, ref: string, timing?: RequestTiming): Promise<CachedWorkspace> {
  const now = Date.now();
  const existing = contextMemoryCache.get(ref);
  if (existing && existing.expiresAt > now) return existing.promise;

  const promise = resolveCachedWorkspaceUrl(env, ref, timing);
  const entry: MemoryCacheEntry = { promise, expiresAt: now + CONTEXT_MEMORY_TTL_MS };
  contextMemoryCache.set(ref, entry);
  pruneContextMemoryCache(now);
  promise.catch(() => {
    // Only this call's own entry — a database move or a fresh lookup may
    // have already replaced it with a newer one for the same ref.
    if (contextMemoryCache.get(ref) === entry) contextMemoryCache.delete(ref);
  });
  return promise;
}

/** The workspace's resolution read from the master DB (and Neon, for a row without a stored URL). */
async function resolveWorkspaceFromMaster(
  env: DbEnv,
  ref: string,
  keyring: { v1: string | undefined; v2: string | undefined },
): Promise<CachedWorkspace> {
  const workspace = await selectWorkspaceForRef(getMasterDb(env), ref);

  if (!workspace) throw new Error(`Workspace not found: ${ref}`);
  if (!workspace.neonProjectId || !workspace.neonBranchId || !workspace.neonRoleName) {
    throw new Error(`No database configured for workspace: ${workspace.id}`);
  }

  // Drizzle's row type allows nullable columns; resolveDatabaseUrl checks
  // each field at runtime and we narrowed the requireds above.
  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY,
    {
      // The AAD of a v3 `database_url`: the row's own id, never a caller-supplied one.
      id: workspace.id,
      neonProjectId: workspace.neonProjectId,
      neonBranchId: workspace.neonBranchId,
      neonRoleName: workspace.neonRoleName,
      neonDatabaseName: workspace.neonDatabaseName,
      databaseUrl: workspace.databaseUrl,
    },
    keyring,
  );

  const restrictions = computeWorkspaceRestrictions({
    billingMode: workspace.billingMode,
    licence: workspace.licenceStatus
      ? { status: workspace.licenceStatus, allowedApps: workspace.licenceApps }
      : null,
    partnerStatus: workspace.partnerStatus,
    databaseMoveInProgress: workspace.databaseMoveInProgress,
  });

  return {
    id: workspace.id,
    clerkOrgId: workspace.clerkOrgId,
    databaseUrl,
    suspended: !workspace.isActive,
    ...restrictions,
  };
}

/** The tenant DB of a workspace, by its id or its Clerk org id. */
export async function getTenantDbForWorkspace(
  env: DbEnv,
  ref: string,
): Promise<NeonHttpDatabase<typeof schema>> {
  const workspace = await getCachedWorkspaceUrl(env, ref);
  return createNeonTenantDb(workspace.databaseUrl);
}

/**
 * Resolve the tenant DB together with the workspace's suspension state, licence
 * and read-only state, by its id or its Clerk org id. The request middleware
 * uses this to reject suspended workspaces (a 403) instead of serving them a
 * working DB handle, and hands the licence and read-only flag to `licenceGate()`.
 * With `timing`, the lookup and every query on the returned handle are recorded
 * for the request's `Server-Timing` (./timing.ts).
 */
export async function getWorkspaceContextForOrg(
  env: DbEnv,
  ref: string,
  timing?: RequestTiming,
): Promise<{
  id: string;
  clerkOrgId: string | null;
  db: NeonHttpDatabase<typeof schema>;
  suspended: boolean;
  licensedApps: string[] | null;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
}> {
  const workspace = await getCachedWorkspaceUrl(env, ref, timing);
  return {
    id: workspace.id,
    clerkOrgId: workspace.clerkOrgId,
    db: createNeonTenantDb(workspace.databaseUrl, timing),
    suspended: workspace.suspended,
    licensedApps: workspace.licensedApps,
    readOnly: workspace.readOnly,
    readOnlyReason: workspace.readOnlyReason,
  };
}

/**
 * Both identifiers of a workspace, from either of them: `workspaces.id` and its
 * Clerk org id. Uses the same KV-cached lookup as tenant DB resolution.
 */
export async function getWorkspaceForOrg(
  env: DbEnv,
  ref: string,
): Promise<{ id: string; clerkOrgId: string | null }> {
  const workspace = await getCachedWorkspaceUrl(env, ref);
  return { id: workspace.id, clerkOrgId: workspace.clerkOrgId };
}

export type { Database } from './env';
export type MasterDatabase = NeonHttpDatabase<typeof masterSchema>;
/**
 * A master-DB handle on any drizzle Postgres driver: neon-http in the API
 * workers, postgres-js over Hyperdrive in external-api. Read helpers that
 * several workers share take this instead of `MasterDatabase`.
 */
export type AnyMasterDatabase = PgDatabase<PgQueryResultHKT, typeof masterSchema>;
export { schema, masterSchema };
