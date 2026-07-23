/**
 * Database Client for Helpdesk Workflow Worker
 *
 * Same pattern as helpdesk-widget-api: Hyperdrive for master, Neon HTTP for tenants.
 * KV-cached workspace lookups for fast tenant DB resolution.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { Env } from '../types';

// ============ Master DB ============

function createMasterDb(hyperdrive: Hyperdrive) {
  const sql = postgres(hyperdrive.connectionString, {
    max: 1,
    prepare: false,
  });
  return drizzle(sql, { schema: masterSchema });
}

function createMasterDbFromUrl(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
  });
  return drizzle(sql, { schema: masterSchema });
}

export function getMasterDb(env: Env) {
  if (env.DATABASE_URL_MASTER) {
    return createMasterDbFromUrl(env.DATABASE_URL_MASTER);
  }
  return createMasterDb(env.HYPERDRIVE_MASTER);
}

// ============ Tenant DB ============

function createNeonTenantDb(connectionUrl: string): NeonHttpDatabase<typeof schema> {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

const KV_TTL_SECONDS = 300;

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
      id: workspaces.id,
      neonProjectId: workspaces.neonProjectId,
      neonBranchId: workspaces.neonBranchId,
      neonRoleName: workspaces.neonRoleName,
      neonDatabaseName: workspaces.neonDatabaseName,
      databaseUrl: workspaces.databaseUrl,
    })
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .limit(1);

  if (!workspace?.neonProjectId || !workspace?.neonBranchId || !workspace?.neonRoleName) {
    throw new Error(`Workspace ${clerkOrgId} does not have a database configured`);
  }

  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY ?? '',
    workspace as any,
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });

  return entry;
}

export async function getTenantDbForWorkspace(
  env: Env,
  clerkOrgId: string
): Promise<NeonHttpDatabase<typeof schema>> {
  const workspace = await getCachedWorkspaceUrl(env, clerkOrgId);
  return createNeonTenantDb(workspace.databaseUrl);
}

/**
 * Resolve the internal workspace ID for a Clerk org ID. Shares the same KV
 * cache backing `getTenantDbForWorkspace`.
 */
export async function getWorkspaceForOrg(
  env: Env,
  clerkOrgId: string,
): Promise<{ id: string }> {
  const { id } = await getCachedWorkspaceUrl(env, clerkOrgId);
  return { id };
}

export type Database = NeonHttpDatabase<typeof schema>;
export type MasterDatabase = ReturnType<typeof getMasterDb>;

export { schema, masterSchema };
