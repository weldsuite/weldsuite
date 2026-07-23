/**
 * Database Client for Mail Inbound Worker
 *
 * Uses Neon HTTP driver for BOTH master and tenant connections — same shape
 * as api-worker. Stateless, no TCP, no Hyperdrive. Workspace URL lookups are
 * cached in Cloudflare KV for 5 minutes.
 */

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
// Tenant schema (mail messages, folders, etc.)
import * as tenantSchema from '@weldsuite/db/schema';
// Master schema (mail account registry)
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { Env } from '../index';

// ============ Master DB (Neon HTTP) ============

export function getMasterDb(env: Env): NeonHttpDatabase<typeof masterSchema> {
  if (!env.DATABASE_URL_MASTER) {
    throw new Error('DATABASE_URL_MASTER secret is not set');
  }
  const sql = neon(env.DATABASE_URL_MASTER);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

// ============ Tenant DB (Neon HTTP) ============

function createNeonTenantDb(connectionUrl: string): NeonHttpDatabase<typeof tenantSchema> {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema: tenantSchema });
}

// ============ KV-cached workspace lookup ============

const KV_TTL_SECONDS = 300; // 5 minutes

interface CachedWorkspace {
  id: string;
  databaseUrl: string;
}

async function getCachedWorkspaceUrlById(
  env: Env,
  workspaceId: string
): Promise<CachedWorkspace> {
  const cacheKey = `wsid:${workspaceId}`;
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
    .where(eq(masterSchema.workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  if (!workspace.neonProjectId || !workspace.neonBranchId || !workspace.neonRoleName) {
    throw new Error(`No database configured for workspace: ${workspace.id}`);
  }

  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY,
    workspace as any,
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });

  return entry;
}

/**
 * Get tenant database for a specific workspace by its internal ID
 * Uses Neon HTTP driver with KV-cached workspace URL lookup
 */
export async function getTenantDbForWorkspaceById(
  env: Env,
  workspaceId: string
): Promise<TenantDatabase> {
  const workspace = await getCachedWorkspaceUrlById(env, workspaceId);
  return createNeonTenantDb(workspace.databaseUrl);
}

export type TenantDatabase = NeonHttpDatabase<typeof tenantSchema>;
export type MasterDatabase = NeonHttpDatabase<typeof masterSchema>;
export { tenantSchema, masterSchema };
