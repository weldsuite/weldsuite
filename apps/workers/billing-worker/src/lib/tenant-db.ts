/**
 * Tenant DB helpers for Billing Worker
 *
 * Resolves per-workspace Neon databases via the master DB + KV cache.
 * Used for post-checkout operations (e.g. updating host_domains rows).
 */

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { Env } from '../index';
import { getMasterDb, masterSchema } from './db';

const KV_TTL_SECONDS = 300;

interface CachedWorkspace {
  id: string;
  databaseUrl: string;
}

function createNeonTenantDb(connectionUrl: string): NeonHttpDatabase<typeof schema> {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

/**
 * Get a tenant-scoped Neon DB for the given workspace ID (master DB id).
 * Results are cached in KV for 5 minutes.
 */
export async function getTenantDbForWorkspace(
  env: Env,
  workspaceId: string,
): Promise<NeonHttpDatabase<typeof schema>> {
  const cacheKey = `ws:id:${workspaceId}`;
  const cached = await env.WORKSPACE_CACHE.get(cacheKey, 'json') as CachedWorkspace | null;
  if (cached) return createNeonTenantDb(cached.databaseUrl);

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
    .where(eq(masterSchema.workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
  if (!workspace.neonProjectId || !workspace.neonBranchId || !workspace.neonRoleName) {
    throw new Error(`No database configured for workspace: ${workspaceId}`);
  }

  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY,
    workspace as Parameters<typeof resolveDatabaseUrl>[1],
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify({ id: workspaceId, databaseUrl }), {
    expirationTtl: KV_TTL_SECONDS,
  });

  return createNeonTenantDb(databaseUrl);
}

export { schema };
