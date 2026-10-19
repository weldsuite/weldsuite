/**
 * Master and tenant database clients for API workers.
 *
 * Tenant resolution: Clerk org id → KV `ws:<org>` (300 s TTL) → on a miss,
 * the master DB row + `resolveDatabaseUrl`. Every API worker shares the
 * WORKSPACE_CACHE namespace, so a lookup cached by one worker serves all.
 *
 * A database move (TASK-1150) changes what a cached entry says: the workflow
 * that drives it purges `ws:<org>` when the soft lock starts and again after the
 * switch, and `forgetWorkspaceContext` drops the entry of a request that found
 * its database gone (rotated password).
 */

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { DbEnv } from './env';
import { computeWorkspaceRestrictions, type ReadOnlyReason } from './read-only';
import { databaseMoveInProgressSql } from './workspace-moving';

export function getMasterDb(env: Pick<DbEnv, 'DATABASE_URL_MASTER'>): NeonHttpDatabase<typeof masterSchema> {
  const sql = neon(env.DATABASE_URL_MASTER);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

function createNeonTenantDb(connectionUrl: string): NeonHttpDatabase<typeof schema> {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

const KV_TTL_SECONDS = 300;

interface CachedWorkspace {
  id: string;
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

type StoredWorkspace = Omit<CachedWorkspace, 'suspended' | 'readOnly' | 'readOnlyReason'> & {
  suspended?: boolean;
  readOnly?: boolean;
  readOnlyReason?: ReadOnlyReason | null;
};

/**
 * Other workers write `ws:<org>` entries too, with only the DB URL (they predate
 * the licence). Such an entry has no `licensedApps` key at all, so it cannot say
 * whether the workspace is licensed: it is treated as a miss and re-resolved
 * from the master DB, rather than letting a partner workspace through
 * unrestricted for the TTL. (An entry saying `licensedApps: null` is explicit.)
 */
function isCompleteEntry(cached: StoredWorkspace): boolean {
  return cached.licensedApps !== undefined;
}

/** The KV key of a workspace's cached resolution (WORKSPACE_CACHE). */
export function workspaceCacheKey(clerkOrgId: string): string {
  return `ws:${clerkOrgId}`;
}

/**
 * Drop a workspace's cached resolution, so the next request reads the master DB
 * again. For a request whose tenant database refused the cached URL (the role's
 * password was rotated by a database move). Never throws: a failed purge only
 * leaves the entry to expire on its own.
 */
export async function forgetWorkspaceContext(
  env: Pick<DbEnv, 'WORKSPACE_CACHE'>,
  clerkOrgId: string,
): Promise<void> {
  try {
    await env.WORKSPACE_CACHE.delete(workspaceCacheKey(clerkOrgId));
  } catch (err) {
    console.warn('Could not purge a workspace cache entry:', err instanceof Error ? err.message : 'unknown error');
  }
}

/**
 * The master-DB row tenant resolution reads for a Clerk org: the workspace,
 * plus (for partner workspaces) its licence and the partner's payment standing,
 * plus whether a database move is blocking writes. One query, one round trip;
 * direct workspaces join to nothing. Exported for the tests that run it on a
 * real master schema.
 */
export async function selectWorkspaceForOrg(masterDb: AnyMasterDatabase, clerkOrgId: string) {
  const [workspace] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
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
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);
  return workspace;
}

async function getCachedWorkspaceUrl(env: DbEnv, clerkOrgId: string): Promise<CachedWorkspace> {
  const cacheKey = workspaceCacheKey(clerkOrgId);
  // `suspended` and `readOnly` were added later: an entry cached before they
  // existed omits them and reads as not-suspended / not read-only (it refreshes
  // within KV_TTL_SECONDS). The same goes for a database move, which is stored
  // as `readOnlyReason: 'database_move'`.
  const cached = (await env.WORKSPACE_CACHE.get(cacheKey, 'json')) as StoredWorkspace | null;
  if (cached && isCompleteEntry(cached)) {
    return {
      ...cached,
      suspended: cached.suspended ?? false,
      readOnly: cached.readOnly ?? false,
      readOnlyReason: cached.readOnly ? (cached.readOnlyReason ?? 'licence_inactive') : null,
    };
  }

  const workspace = await selectWorkspaceForOrg(getMasterDb(env), clerkOrgId);

  if (!workspace) throw new Error(`Workspace not found for org: ${clerkOrgId}`);
  if (!workspace.neonProjectId || !workspace.neonBranchId || !workspace.neonRoleName) {
    throw new Error(`No database configured for workspace: ${workspace.id}`);
  }

  // Drizzle's row type allows nullable columns; resolveDatabaseUrl checks
  // each field at runtime and we narrowed the requireds above.
  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY,
    {
      neonProjectId: workspace.neonProjectId,
      neonBranchId: workspace.neonBranchId,
      neonRoleName: workspace.neonRoleName,
      neonDatabaseName: workspace.neonDatabaseName,
      databaseUrl: workspace.databaseUrl,
    },
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const restrictions = computeWorkspaceRestrictions({
    billingMode: workspace.billingMode,
    licence: workspace.licenceStatus
      ? { status: workspace.licenceStatus, allowedApps: workspace.licenceApps }
      : null,
    partnerStatus: workspace.partnerStatus,
    databaseMoveInProgress: workspace.databaseMoveInProgress,
  });

  const entry: CachedWorkspace = {
    id: workspace.id,
    databaseUrl,
    suspended: !workspace.isActive,
    ...restrictions,
  };
  await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), {
    expirationTtl: KV_TTL_SECONDS,
  });

  return entry;
}

export async function getTenantDbForWorkspace(
  env: DbEnv,
  clerkOrgId: string,
): Promise<NeonHttpDatabase<typeof schema>> {
  const workspace = await getCachedWorkspaceUrl(env, clerkOrgId);
  return createNeonTenantDb(workspace.databaseUrl);
}

/**
 * Resolve the tenant DB together with the workspace's suspension state, licence
 * and read-only state. The request middleware uses this to reject suspended
 * workspaces (a 403) instead of serving them a working DB handle, and hands the
 * licence and read-only flag to `licenceGate()`.
 */
export async function getWorkspaceContextForOrg(
  env: DbEnv,
  clerkOrgId: string,
): Promise<{
  id: string;
  db: NeonHttpDatabase<typeof schema>;
  suspended: boolean;
  licensedApps: string[] | null;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
}> {
  const workspace = await getCachedWorkspaceUrl(env, clerkOrgId);
  return {
    id: workspace.id,
    db: createNeonTenantDb(workspace.databaseUrl),
    suspended: workspace.suspended,
    licensedApps: workspace.licensedApps,
    readOnly: workspace.readOnly,
    readOnlyReason: workspace.readOnlyReason,
  };
}

/**
 * Resolve the internal workspace id for a Clerk org.
 * Uses the same KV-cached lookup as tenant DB resolution.
 */
export async function getWorkspaceForOrg(env: DbEnv, clerkOrgId: string): Promise<{ id: string }> {
  const workspace = await getCachedWorkspaceUrl(env, clerkOrgId);
  return { id: workspace.id };
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
