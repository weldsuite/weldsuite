/**
 * Master and tenant database clients for API workers.
 *
 * Tenant resolution: Clerk org id → KV `ws:<org>` (300 s TTL) → on a miss,
 * the master DB row + `resolveDatabaseUrl`. Every API worker shares the
 * WORKSPACE_CACHE namespace, so a lookup cached by one worker serves all.
 */

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { DbEnv } from './env';

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
   * (docs/plans/reseller-licensing.md); until `workspace_licences` exists every
   * workspace resolves to null. `licenceGate()` enforces it per request.
   */
  licensedApps: string[] | null;
}

async function getCachedWorkspaceUrl(env: DbEnv, clerkOrgId: string): Promise<CachedWorkspace> {
  const cacheKey = `ws:${clerkOrgId}`;
  // `suspended` and `licensedApps` were added later — an entry cached before
  // they existed omits them, so read them as optional and default to
  // not-suspended and unrestricted (the entry refreshes within KV_TTL_SECONDS).
  const cached = (await env.WORKSPACE_CACHE.get(cacheKey, 'json')) as
    | (Omit<CachedWorkspace, 'suspended' | 'licensedApps'> & {
        suspended?: boolean;
        licensedApps?: string[] | null;
      })
    | null;
  if (cached) {
    return { ...cached, suspended: cached.suspended ?? false, licensedApps: cached.licensedApps ?? null };
  }

  const masterDb = getMasterDb(env);
  const [workspace] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      neonProjectId: masterSchema.workspaces.neonProjectId,
      neonBranchId: masterSchema.workspaces.neonBranchId,
      neonRoleName: masterSchema.workspaces.neonRoleName,
      neonDatabaseName: masterSchema.workspaces.neonDatabaseName,
      databaseUrl: masterSchema.workspaces.databaseUrl,
      isActive: masterSchema.workspaces.isActive,
    })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);

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

  const entry: CachedWorkspace = {
    id: workspace.id,
    databaseUrl,
    suspended: !workspace.isActive,
    licensedApps: null,
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
 * Resolve the tenant DB together with the workspace's suspension state and
 * licence. The request middleware uses this to reject suspended workspaces (a
 * 403) instead of serving them a working DB handle, and hands the licence to
 * `licenceGate()`.
 */
export async function getWorkspaceContextForOrg(
  env: DbEnv,
  clerkOrgId: string,
): Promise<{
  id: string;
  db: NeonHttpDatabase<typeof schema>;
  suspended: boolean;
  licensedApps: string[] | null;
}> {
  const workspace = await getCachedWorkspaceUrl(env, clerkOrgId);
  return {
    id: workspace.id,
    db: createNeonTenantDb(workspace.databaseUrl),
    suspended: workspace.suspended,
    licensedApps: workspace.licensedApps,
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
export { schema, masterSchema };
