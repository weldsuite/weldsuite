/**
 * Database Client
 *
 * Dual-DB pattern (same as agent-service):
 * - Master DB: direct Postgres for workspace/billing data
 * - Tenant DB: Neon HTTP for per-workspace business data
 * - LRU cache for workspace URL resolution
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
import { getEnv } from './env.js';

// ============ Master DB ============

let masterDb: ReturnType<typeof drizzle> | null = null;

export function getMasterDb() {
  if (masterDb) return masterDb;

  const env = getEnv();
  const sql = postgres(env.DATABASE_URL_MASTER, {
    max: 5,
    prepare: false,
  });
  masterDb = drizzle(sql, { schema: masterSchema });
  return masterDb;
}

// ============ Tenant DB ============

interface CachedWorkspace {
  id: string;
  databaseUrl: string;
  cachedAt: number;
}

const workspaceCache = new Map<string, CachedWorkspace>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function createNeonTenantDb(connectionUrl: string): NeonHttpDatabase<typeof schema> {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

async function getWorkspaceUrl(clerkOrgId: string): Promise<CachedWorkspace> {
  const cached = workspaceCache.get(clerkOrgId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const env = getEnv();
  const db = getMasterDb();

  const [workspace] = await db
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
    env.NEON_API_KEY,
    workspace as any,
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl, cachedAt: Date.now() };
  workspaceCache.set(clerkOrgId, entry);

  return entry;
}

export async function getTenantDb(workspaceId: string): Promise<NeonHttpDatabase<typeof schema>> {
  const workspace = await getWorkspaceUrl(workspaceId);
  return createNeonTenantDb(workspace.databaseUrl);
}

export type Database = NeonHttpDatabase<typeof schema>;
export type MasterDatabase = ReturnType<typeof getMasterDb>;

export { schema, masterSchema };
