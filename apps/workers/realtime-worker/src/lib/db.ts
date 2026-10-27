/**
 * Database helpers for the realtime worker.
 *
 * Used by the access gates in `src/index.ts` (channel, conversation and
 * project rooms) and to map a workspace id onto its WorkspaceHub.
 *
 * Uses Neon HTTP driver (stateless, no TCP) for both master and tenant.
 * The master DB is looked up by connection string (`DATABASE_URL_MASTER`).
 * Tenant DB URLs are resolved via master DB + Neon API, cached in KV so
 * we share cache entries with the api-worker and widget API.
 */

import { eq } from 'drizzle-orm';
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

export type TenantDatabase = NeonHttpDatabase<typeof schema>;

export interface DbEnv {
  DATABASE_URL_MASTER?: string;
  WORKSPACE_CACHE?: KVNamespace;
  NEON_API_KEY?: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}

const KV_TTL_SECONDS = 300;

interface CachedWorkspace {
  id: string;
  databaseUrl: string;
}

/** What lands in KV: the connection string sealed, never in the clear. */
type StoredWorkspace = Omit<CachedWorkspace, 'databaseUrl'> & { databaseUrlSealed?: string };

function getMasterDb(env: DbEnv): NeonHttpDatabase<typeof masterSchema> {
  if (!env.DATABASE_URL_MASTER) {
    throw new Error('DATABASE_URL_MASTER is not configured on realtime-worker');
  }
  const sql = neon(env.DATABASE_URL_MASTER);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

async function getCachedWorkspaceUrl(env: DbEnv, ref: string): Promise<CachedWorkspace> {
  // `ref` is the workspace id or its Clerk org id (matchWorkspaceRef). Sealed
  // entries live under `wsx:<ref>`; the old plaintext `ws:<ref>` key is never read.
  const cacheKey = sealedWorkspaceCacheKey(ref);
  const keyring = { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
  const cached = env.WORKSPACE_CACHE
    ? ((await env.WORKSPACE_CACHE.get(cacheKey, 'json')) as StoredWorkspace | null)
    : null;
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
  const databaseUrlSealed = env.WORKSPACE_CACHE ? await sealCachedDatabaseUrl(databaseUrl, keyring) : null;
  if (env.WORKSPACE_CACHE && databaseUrlSealed) {
    const stored: StoredWorkspace = { id: workspace.id, databaseUrlSealed };
    await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(stored), {
      expirationTtl: KV_TTL_SECONDS,
    });
  }
  return entry;
}

export async function getTenantDbForWorkspace(
  env: DbEnv,
  ref: string,
): Promise<TenantDatabase> {
  const { databaseUrl } = await getCachedWorkspaceUrl(env, ref);
  const sql = neon(databaseUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

/** A workspace id never changes its Clerk org, so the mapping can be kept long. */
const HUB_KEY_TTL_SECONDS = 24 * 60 * 60;
const hubKeyMemo = new Map<string, string>();

/**
 * The name of the WorkspaceHub a workspace's clients are connected to.
 *
 * Hubs are named by the Clerk org id: a client connects with its Clerk token
 * and the hub comes from the token's org claim. Publishers and entity events
 * may carry `workspaces.id` instead (docs/plans/workspace-id-standardization.md),
 * which would land in a hub nobody is connected to. An `org_…` ref is used as
 * it is (a Clerk org id, or an early workspace whose id is its org id); any
 * other ref is mapped to its workspace's org id, and kept as it is when the
 * workspace has none.
 */
export async function workspaceHubKey(env: DbEnv, ref: string): Promise<string> {
  if (ref.startsWith('org_') || !env.DATABASE_URL_MASTER) return ref;

  const memo = hubKeyMemo.get(ref);
  if (memo) return memo;

  const cacheKey = `wshub:${ref}`;
  const cached = env.WORKSPACE_CACHE ? await env.WORKSPACE_CACHE.get(cacheKey) : null;
  if (cached) {
    hubKeyMemo.set(ref, cached);
    return cached;
  }

  const [row] = await getMasterDb(env)
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.id, ref))
    .limit(1);
  const hubKey = row?.clerkOrgId ?? ref;
  hubKeyMemo.set(ref, hubKey);
  if (row && env.WORKSPACE_CACHE) {
    await env.WORKSPACE_CACHE.put(cacheKey, hubKey, { expirationTtl: HUB_KEY_TTL_SECONDS });
  }
  return hubKey;
}
