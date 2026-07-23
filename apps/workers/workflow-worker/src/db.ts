/**
 * Tenant database type + schema re-export.
 *
 * Workflows run against a per-workspace tenant database (Neon via Hyperdrive
 * in production, pglite in tests). The `Database` type is the Drizzle client
 * typed against the full WeldSuite tenant schema, matching app-api's `Database`
 * so the shared pglite helper is type-compatible.
 */

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';

export { schema, masterSchema };

export type Database = NeonHttpDatabase<typeof schema>;
export type MasterDatabase = NeonHttpDatabase<typeof masterSchema>;

/** Minimal env surface the tenant-DB resolution needs. */
export interface TenantDbEnv {
  DATABASE_URL_MASTER?: string;
  NEON_API_KEY?: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  WORKSPACE_CACHE?: KVNamespace;
}

export function getMasterDb(env: TenantDbEnv): MasterDatabase {
  const sql = neon(env.DATABASE_URL_MASTER!);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

function createNeonTenantDb(connectionUrl: string): Database {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

const KV_TTL_SECONDS = 300;

interface CachedWorkspace {
  id: string;
  databaseUrl: string;
}

async function getCachedWorkspaceUrl(env: TenantDbEnv, clerkOrgId: string): Promise<CachedWorkspace> {
  const cacheKey = `ws:${clerkOrgId}`;
  const cached = (await env.WORKSPACE_CACHE?.get(cacheKey, 'json')) as CachedWorkspace | null;
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
    env.NEON_API_KEY!,
    workspace as any,
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  await env.WORKSPACE_CACHE?.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });
  return entry;
}

export async function getTenantDbForWorkspace(env: TenantDbEnv, clerkOrgId: string): Promise<Database> {
  const workspace = await getCachedWorkspaceUrl(env, clerkOrgId);
  return createNeonTenantDb(workspace.databaseUrl);
}
