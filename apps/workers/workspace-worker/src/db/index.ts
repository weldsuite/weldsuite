/**
 * Database Client for Workspace Worker
 *
 * Uses the Neon serverless HTTP driver for BOTH the master and tenant database
 * connections. Hyperdrive is intentionally not used here: its query-result
 * caching made the pool-replenishment cron read a stale `count(*)` of available
 * pool entries, so it never saw the rows it had just inserted and kept creating
 * Neon projects forever. The HTTP driver issues an uncached query each run.
 */

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { Env } from '../index';

// ============ Master DB (Neon serverless HTTP) ============

function createMasterDb(connectionString: string): NeonHttpDatabase<typeof masterSchema> {
  const sql = neon(connectionString);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

export function getMasterDb(env: Env) {
  if (!env.DATABASE_URL_MASTER) {
    throw new Error('DATABASE_URL_MASTER is not configured (Hyperdrive has been removed)');
  }
  return createMasterDb(env.DATABASE_URL_MASTER);
}

// ============ Tenant DB (Neon HTTP) ============

function createNeonTenantDb(connectionUrl: string): NeonHttpDatabase<typeof schema> {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

// ============ KV-cached workspace lookup ============

const KV_TTL_SECONDS = 300; // 5 minutes

interface CachedWorkspace {
  id: string;
  databaseUrl: string;
}

async function getCachedWorkspaceUrl(
  env: Env,
  clerkOrgId: string
): Promise<CachedWorkspace> {
  const cacheKey = `ws:${clerkOrgId}`;
  const cached = await env.WORKSPACE_CACHE.get(cacheKey, 'json') as CachedWorkspace | null;
  if (cached) return cached;

  const masterDb = getMasterDb(env);
  const [workspace] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      neonProjectId: masterSchema.workspaces.neonProjectId,
      neonBranchId: masterSchema.workspaces.neonBranchId,
      neonRoleName: masterSchema.workspaces.neonRoleName,
      neonDatabaseName: masterSchema.workspaces.neonDatabaseName,
      databaseUrl: masterSchema.workspaces.databaseUrl,
    })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);

  if (!workspace) throw new Error(`Workspace not found for org: ${clerkOrgId}`);
  if (!workspace.neonProjectId || !workspace.neonBranchId || !workspace.neonRoleName) {
    throw new Error(`No database configured for workspace: ${workspace.id}`);
  }

  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY,
    workspace as any,
    env.DATABASE_ENCRYPTION_KEY
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });

  return entry;
}

/**
 * Get tenant database for a specific workspace
 */
export async function getTenantDbForWorkspace(
  env: Env,
  clerkOrgId: string
): Promise<NeonHttpDatabase<typeof schema>> {
  const workspace = await getCachedWorkspaceUrl(env, clerkOrgId);
  return createNeonTenantDb(workspace.databaseUrl);
}

export type Database = NeonHttpDatabase<typeof schema>;
export type MasterDatabase = ReturnType<typeof getMasterDb>;
export { schema, masterSchema };
