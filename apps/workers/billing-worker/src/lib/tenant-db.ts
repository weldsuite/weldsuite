/**
 * Tenant DB helpers for Billing Worker
 *
 * Resolves per-workspace Neon databases via the master DB + KV cache.
 * Used for post-checkout operations (e.g. updating host_domains rows).
 */

import { eq, or } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import {
  openCachedDatabaseUrl,
  sealCachedDatabaseUrl,
} from '@weldsuite/db/lib/workspace-url-cache';
import type { Env } from '../index';
import { getMasterDb, masterSchema } from './db';

const KV_TTL_SECONDS = 300;

interface CachedWorkspace {
  id: string;
  databaseUrl: string;
}

/** What lands in KV: the connection string sealed, never in the clear. */
type StoredWorkspace = Omit<CachedWorkspace, 'databaseUrl'> & { databaseUrlSealed?: string };

function createNeonTenantDb(connectionUrl: string): NeonHttpDatabase<typeof schema> {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

/**
 * Get a tenant-scoped Neon DB for the given workspace id **or** Clerk org id.
 * Domain checkout metadata stores the Clerk org id (app-api `workspaceId`),
 * while some other billing flows store the master `workspaces.id`. Accept both.
 */
export async function getTenantDbForWorkspace(
  env: Env,
  workspaceIdOrOrgId: string,
): Promise<NeonHttpDatabase<typeof schema>> {
  // Sealed entry under its own prefix (the old plaintext key was `ws:id:<x>`). Distinct from
  // `wsx:<org>` / `wsx:id:<id>`, which other workers write in a different shape.
  const cacheKey = `wsx:bill:${workspaceIdOrOrgId}`;
  const keyring = { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
  const cached = await env.WORKSPACE_CACHE.get(cacheKey, 'json') as StoredWorkspace | null;
  const cachedUrl = cached ? await openCachedDatabaseUrl(cached.databaseUrlSealed, keyring) : null;
  if (cachedUrl) return createNeonTenantDb(cachedUrl);

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
    .where(
      or(
        eq(masterSchema.workspaces.id, workspaceIdOrOrgId),
        eq(masterSchema.workspaces.clerkOrgId, workspaceIdOrOrgId),
      ),
    )
    .limit(1);

  if (!workspace) throw new Error(`Workspace ${workspaceIdOrOrgId} not found`);
  if (!workspace.neonProjectId || !workspace.neonBranchId || !workspace.neonRoleName) {
    throw new Error(`No database configured for workspace: ${workspaceIdOrOrgId}`);
  }

  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY,
    workspace as Parameters<typeof resolveDatabaseUrl>[1],
    keyring,
  );

  // No keyring → nothing to seal with → do not cache (never a plaintext fallback).
  const databaseUrlSealed = await sealCachedDatabaseUrl(databaseUrl, keyring);
  if (databaseUrlSealed) {
    const stored: StoredWorkspace = { id: workspace.id, databaseUrlSealed };
    await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(stored), { expirationTtl: KV_TTL_SECONDS });
  }

  return createNeonTenantDb(databaseUrl);
}

export { schema };
