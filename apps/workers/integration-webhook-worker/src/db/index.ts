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
import {
  openCachedDatabaseUrl,
  sealCachedDatabaseUrl,
  sealedWorkspaceCacheKey,
  sealedWorkspaceIdCacheKey,
} from '@weldsuite/db/lib/workspace-url-cache';
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
  clerkOrgId?: string;
}

/** What lands in KV: the connection string sealed, never in the clear. */
type StoredWorkspace = Omit<CachedWorkspace, 'databaseUrl'> & { databaseUrlSealed?: string };

async function getCachedWorkspaceUrlById(
  env: Env,
  workspaceId: string
): Promise<CachedWorkspace> {
  // Sealed entries live under `wsx:id:` (shared with mail-inbound-worker, as `wsid:<id>` was);
  // the old plaintext `wsid:` key is never read.
  const cacheKey = sealedWorkspaceIdCacheKey(workspaceId);
  const keyring = { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
  const cached = await env.WORKSPACE_CACHE.get(cacheKey, 'json') as StoredWorkspace | null;
  const cachedUrl = cached ? await openCachedDatabaseUrl(cached.databaseUrlSealed, keyring) : null;
  if (cached && cachedUrl) return { id: cached.id, databaseUrl: cachedUrl, clerkOrgId: cached.clerkOrgId };

  const masterDb = getMasterDb(env);
  const [workspace] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
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
    keyring,
  );

  const entry: CachedWorkspace = {
    id: workspace.id,
    databaseUrl,
    clerkOrgId: workspace.clerkOrgId ?? undefined,
  };
  // No keyring → nothing to seal with → do not cache (never a plaintext fallback).
  const databaseUrlSealed = await sealCachedDatabaseUrl(databaseUrl, keyring);
  if (databaseUrlSealed) {
    const stored: StoredWorkspace = { id: workspace.id, databaseUrlSealed, clerkOrgId: entry.clerkOrgId };
    await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(stored), { expirationTtl: KV_TTL_SECONDS });
  }

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
  // Sealed entries live under `wsx:`; the old plaintext `ws:<org>` key is never read.
  const cacheKey = sealedWorkspaceCacheKey(clerkOrgId);
  const keyring = { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
  const cached = await env.WORKSPACE_CACHE.get(cacheKey, 'json') as StoredWorkspace | null;
  const cachedUrl = cached ? await openCachedDatabaseUrl(cached.databaseUrlSealed, keyring) : null;
  if (cached && cachedUrl) return { id: cached.id, databaseUrl: cachedUrl, clerkOrgId: cached.clerkOrgId };

  const masterDb = getMasterDb(env);
  const [workspace] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
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
    keyring,
  );

  const entry: CachedWorkspace = {
    id: workspace.id,
    databaseUrl,
    clerkOrgId: workspace.clerkOrgId ?? clerkOrgId,
  };
  // No keyring → nothing to seal with → do not cache (never a plaintext fallback).
  const databaseUrlSealed = await sealCachedDatabaseUrl(databaseUrl, keyring);
  if (databaseUrlSealed) {
    const stored: StoredWorkspace = { id: workspace.id, databaseUrlSealed, clerkOrgId: entry.clerkOrgId };
    await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(stored), { expirationTtl: KV_TTL_SECONDS });
  }

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

/**
 * Resolve workspace id + DB by Clerk org id. Used by the entity-webhooks
 * consumer (event metadata carries the org id from app-api middleware).
 */
export async function resolveWorkspaceByClerkOrg(
  env: Env,
  clerkOrgId: string,
): Promise<{ id: string; db: TenantDatabase }> {
  const workspace = await getCachedWorkspaceUrlByClerkOrg(env, clerkOrgId);
  return { id: workspace.id, db: createNeonTenantDb(workspace.databaseUrl) };
}

/**
 * Resolve Clerk org id + DB by internal workspace id.
 */
export async function resolveWorkspaceById(
  env: Env,
  workspaceId: string,
): Promise<{ clerkOrgId: string; db: TenantDatabase }> {
  const workspace = await getCachedWorkspaceUrlById(env, workspaceId);
  if (!workspace.clerkOrgId) {
    // Stale KV entries from before clerkOrgId was cached — refresh once.
    // Both the sealed entry and the old plaintext one (still written by a worker not yet redeployed).
    await env.WORKSPACE_CACHE.delete(sealedWorkspaceIdCacheKey(workspaceId));
    await env.WORKSPACE_CACHE.delete(`wsid:${workspaceId}`);
    const refreshed = await getCachedWorkspaceUrlById(env, workspaceId);
    if (!refreshed.clerkOrgId) {
      throw new Error(`Workspace missing clerkOrgId: ${workspaceId}`);
    }
    return {
      clerkOrgId: refreshed.clerkOrgId,
      db: createNeonTenantDb(refreshed.databaseUrl),
    };
  }
  return {
    clerkOrgId: workspace.clerkOrgId,
    db: createNeonTenantDb(workspace.databaseUrl),
  };
}

export type TenantDatabase = NeonHttpDatabase<typeof tenantSchema>;
export type MasterDatabase = PostgresJsDatabase<typeof masterSchema>;
export { tenantSchema, masterSchema, tenantSchema as schema };
