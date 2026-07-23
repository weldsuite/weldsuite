/**
 * Database helpers for the realtime worker.
 *
 * Used by WorkspaceHub's presence alarm to persist `offline` to the
 * tenant `chat_user_status` table when a user's grace period expires.
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

function getMasterDb(env: DbEnv): NeonHttpDatabase<typeof masterSchema> {
  if (!env.DATABASE_URL_MASTER) {
    throw new Error('DATABASE_URL_MASTER is not configured on realtime-worker');
  }
  const sql = neon(env.DATABASE_URL_MASTER);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

async function getCachedWorkspaceUrl(env: DbEnv, clerkOrgId: string): Promise<CachedWorkspace> {
  const cacheKey = `ws:${clerkOrgId}`;
  const cached = env.WORKSPACE_CACHE
    ? ((await env.WORKSPACE_CACHE.get(cacheKey, 'json')) as CachedWorkspace | null)
    : null;
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

  if (!workspace?.neonProjectId || !workspace?.neonBranchId || !workspace?.neonRoleName) {
    throw new Error(`Workspace ${clerkOrgId} does not have a database configured`);
  }

  const databaseUrl = await resolveDatabaseUrl(
    env.NEON_API_KEY ?? '',
    workspace as any,
    { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const entry: CachedWorkspace = { id: workspace.id, databaseUrl };
  if (env.WORKSPACE_CACHE) {
    await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: KV_TTL_SECONDS,
    });
  }
  return entry;
}

export async function getTenantDbForWorkspace(
  env: DbEnv,
  clerkOrgId: string,
): Promise<TenantDatabase> {
  const { databaseUrl } = await getCachedWorkspaceUrl(env, clerkOrgId);
  const sql = neon(databaseUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

/**
 * Upsert a user's `chat_user_status` row to `offline`.
 * Mirrors the helper in api-worker/routes/chat/status.ts so presence state
 * stays consistent across both write paths.
 */
export async function setUserOffline(db: TenantDatabase, userId: string): Promise<void> {
  const { chatUserStatus } = schema;
  const now = new Date();

  const [existing] = await db
    .select({ id: chatUserStatus.id })
    .from(chatUserStatus)
    .where(eq(chatUserStatus.userId, userId))
    .limit(1);

  if (existing) {
    await db
      .update(chatUserStatus)
      .set({ status: 'offline', updatedAt: now })
      .where(eq(chatUserStatus.userId, userId));
  } else {
    await db.insert(chatUserStatus).values({
      id: generateStatusId(),
      userId,
      status: 'offline',
      updatedAt: now,
    });
  }
}

/**
 * Restore a user's `chat_user_status` to `online` IFF the row currently
 * says `offline`. Returns true if a row was updated, false otherwise.
 *
 * Called by WorkspaceHub on reconnect after the DO itself had previously
 * persisted the user offline via the grace-period alarm. Skipping rows
 * that are already non-offline preserves user-set `dnd`/`away`/`busy`
 * statuses that were written through the API while the user was online.
 */
export async function setUserOnlineIfOffline(
  db: TenantDatabase,
  userId: string,
): Promise<boolean> {
  const { chatUserStatus } = schema;
  const now = new Date();

  const [existing] = await db
    .select({ id: chatUserStatus.id, status: chatUserStatus.status })
    .from(chatUserStatus)
    .where(eq(chatUserStatus.userId, userId))
    .limit(1);

  if (!existing) {
    await db.insert(chatUserStatus).values({
      id: generateStatusId(),
      userId,
      status: 'online',
      updatedAt: now,
    });
    return true;
  }

  if (existing.status === 'offline') {
    await db
      .update(chatUserStatus)
      .set({ status: 'online', updatedAt: now })
      .where(eq(chatUserStatus.userId, userId));
    return true;
  }

  return false;
}

/** Matches the `cus_<ts><rand>` shape produced by api-worker's generateId. */
function generateStatusId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `cus_${timestamp}${random}`;
}
