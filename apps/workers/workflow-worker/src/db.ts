/**
 * Tenant database type + schema re-export.
 *
 * Workflows run against a per-workspace tenant database (Neon via Hyperdrive
 * in production, pglite in tests). The `Database` type is the Drizzle client
 * typed against the full WeldSuite tenant schema, matching app-api's `Database`
 * so the shared pglite helper is type-compatible.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import {
  openCachedDatabaseUrl,
  sealCachedDatabaseUrl,
  sealedWorkspaceCacheKey,
} from '@weldsuite/db/lib/workspace-url-cache';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';

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

/** What lands in KV: the connection string sealed, never in the clear. */
type StoredWorkspace = Omit<CachedWorkspace, 'databaseUrl'> & { databaseUrlSealed?: string };

async function getCachedWorkspaceUrl(env: TenantDbEnv, ref: string): Promise<CachedWorkspace> {
  // `ref` is the workspace id or its Clerk org id (matchWorkspaceRef). Sealed
  // entries live under `wsx:<ref>`; the old plaintext `ws:<ref>` key is never read.
  const cacheKey = sealedWorkspaceCacheKey(ref);
  const keyring = { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
  const cached = (await env.WORKSPACE_CACHE?.get(cacheKey, 'json')) as StoredWorkspace | null;
  const cachedUrl = cached ? await openCachedDatabaseUrl(cached.databaseUrlSealed, keyring) : null;
  if (cached && cachedUrl) return { id: cached.id, databaseUrl: cachedUrl };

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
    .where(matchWorkspaceRef(ref))
    .limit(1);

  if (!workspace) throw new Error(`Workspace not found: ${ref}`);
  if (!workspace.neonProjectId || !workspace.neonBranchId || !workspace.neonRoleName) {
    throw new Error(`No database configured for workspace: ${workspace.id}`);
  }

  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY!,
    workspace as any,
    keyring,
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  // No keyring → nothing to seal with → do not cache (never a plaintext fallback).
  const databaseUrlSealed = env.WORKSPACE_CACHE ? await sealCachedDatabaseUrl(databaseUrl, keyring) : null;
  if (databaseUrlSealed) {
    const stored: StoredWorkspace = { id: workspace.id, databaseUrlSealed };
    await env.WORKSPACE_CACHE?.put(cacheKey, JSON.stringify(stored), { expirationTtl: KV_TTL_SECONDS });
  }
  return entry;
}

export async function getTenantDbForWorkspace(env: TenantDbEnv, ref: string): Promise<Database> {
  const workspace = await getCachedWorkspaceUrl(env, ref);
  return createNeonTenantDb(workspace.databaseUrl);
}
