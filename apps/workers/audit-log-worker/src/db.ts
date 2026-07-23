/**
 * Database Client for Entity Events Worker
 *
 * Uses Neon HTTP driver for all database connections (stateless, no TCP).
 * Workspace URL lookups are cached in Cloudflare KV for 5 minutes.
 */

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { Env } from './env';

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
  clerkOrgId: string,
): Promise<CachedWorkspace> {
  const cacheKey = `ws:${clerkOrgId}`;
  const cached = (await env.WORKSPACE_CACHE.get(cacheKey, 'json')) as CachedWorkspace | null;
  if (cached) return cached;

  const sql = neon(env.DATABASE_URL_MASTER);
  const masterDb = drizzleNeonHttp({ client: sql, schema: masterSchema });

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
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), {
    expirationTtl: KV_TTL_SECONDS,
  });

  return entry;
}

export async function getTenantDbForWorkspace(
  env: Env,
  clerkOrgId: string,
): Promise<NeonHttpDatabase<typeof schema>> {
  const workspace = await getCachedWorkspaceUrl(env, clerkOrgId);
  return createNeonTenantDb(workspace.databaseUrl);
}

export type Database = NeonHttpDatabase<typeof schema>;

export { schema };
