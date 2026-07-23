/**
 * Database Client for Integration Webhook Worker
 *
 * Uses Hyperdrive for the master database connection (via postgres-js).
 * Uses Neon HTTP driver for tenant database connections (stateless, no TCP).
 * Workspace URL lookups are cached in Cloudflare KV for 5 minutes.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as tenantSchema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { Env } from '../index';

// ============ Master DB (Hyperdrive + postgres-js) ============

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
 * Get tenant database for a specific workspace by its internal ID.
 * Uses Neon HTTP driver with KV-cached workspace URL lookup.
 */
export async function getTenantDbForWorkspaceById(
  env: Env,
  workspaceId: string
): Promise<TenantDatabase> {
  const workspace = await getCachedWorkspaceUrlById(env, workspaceId);
  return createNeonTenantDb(workspace.databaseUrl);
}

// ============ Clerk-org-keyed lookup (engine + CrmSyncWorkflow) ============
//
// The sync engine and CrmSyncWorkflow identify a workspace by its Clerk org id
// (the workflow payload's `workspaceId` is the clerkOrgId), whereas the webhook
// ingress identifies it by the internal workspace id (from the connection KV
// entry). Both lookups live here so the consolidated worker speaks both.

async function getCachedWorkspaceUrlByClerkOrg(
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
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });

  return entry;
}

/**
 * Get tenant database for a workspace by its Clerk org id.
 * Used by the sync engine and CrmSyncWorkflow.
 */
export async function getTenantDbForWorkspace(
  env: Env,
  clerkOrgId: string
): Promise<TenantDatabase> {
  const workspace = await getCachedWorkspaceUrlByClerkOrg(env, clerkOrgId);
  return createNeonTenantDb(workspace.databaseUrl);
}

export type TenantDatabase = NeonHttpDatabase<typeof tenantSchema>;
export type MasterDatabase = PostgresJsDatabase<typeof masterSchema>;
/** Alias used by the ported sync engine, which imports `{ schema }` + `Database`. */
export type Database = TenantDatabase;
export { tenantSchema, masterSchema, tenantSchema as schema };
