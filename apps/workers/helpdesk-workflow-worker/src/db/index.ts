/**
 * Database Client for Helpdesk Workflow Worker
 *
 * Same pattern as helpdesk-widget-api: Hyperdrive for master, Neon HTTP for tenants.
 * KV-cached workspace lookups for fast tenant DB resolution.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import {
  openCachedDatabaseUrl,
  sealCachedDatabaseUrl,
  sealedWorkspaceCacheKey,
} from '@weldsuite/db/lib/workspace-url-cache';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';
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

/** What lands in KV: the connection string sealed, never in the clear. */
type StoredWorkspace = Omit<CachedWorkspace, 'databaseUrl'> & { databaseUrlSealed?: string };

async function getCachedWorkspaceUrl(
  env: Env,
  ref: string
): Promise<CachedWorkspace> {
  // `ref` is the workspace id or its Clerk org id (matchWorkspaceRef). Sealed
  // entries live under `wsx:<ref>`; the old plaintext `ws:<ref>` key is never read.
  const cacheKey = sealedWorkspaceCacheKey(ref);
  const keyring = { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
  const cached = await env.WORKSPACE_CACHE.get(cacheKey, 'json') as StoredWorkspace | null;
  const cachedUrl = cached ? await openCachedDatabaseUrl(cached.databaseUrlSealed, keyring) : null;
  if (cached && cachedUrl) return { id: cached.id, databaseUrl: cachedUrl };

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
    .where(matchWorkspaceRef(ref))
    .limit(1);

  if (!workspace?.neonProjectId || !workspace?.neonBranchId || !workspace?.neonRoleName) {
    throw new Error(`Workspace ${ref} does not have a database configured`);
  }

  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY ?? '',
    workspace as any,
    keyring,
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  // No keyring → nothing to seal with → do not cache (never a plaintext fallback).
  const databaseUrlSealed = await sealCachedDatabaseUrl(databaseUrl, keyring);
  if (databaseUrlSealed) {
    const stored: StoredWorkspace = { id: workspace.id, databaseUrlSealed };
    await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(stored), { expirationTtl: KV_TTL_SECONDS });
  }

  return entry;
}

export async function getTenantDbForWorkspace(
  env: Env,
  ref: string
): Promise<NeonHttpDatabase<typeof schema>> {
  const workspace = await getCachedWorkspaceUrl(env, ref);
  return createNeonTenantDb(workspace.databaseUrl);
}

/**
 * Resolve the internal workspace ID from either id (workspace or Clerk org).
 * Shares the same KV cache backing `getTenantDbForWorkspace`.
 */
export async function getWorkspaceForOrg(
  env: Env,
  ref: string,
): Promise<{ id: string }> {
  const { id } = await getCachedWorkspaceUrl(env, ref);
  return { id };
}

export type Database = NeonHttpDatabase<typeof schema>;
export type MasterDatabase = ReturnType<typeof getMasterDb>;

export { schema, masterSchema };
