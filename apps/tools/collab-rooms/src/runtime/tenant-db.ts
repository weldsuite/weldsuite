/**
 * `@weldsuite/worker-kit/db` for the room classes on Node (the build aliases
 * the module here). On Global a room opens its workspace's database over
 * Neon's HTTP driver; on Kubernetes the databases are plain Postgres
 * (CloudNativePG), opened with postgres.js. The workspace's URL is read from
 * the master database and opened with the same keyring the Rust server and
 * the workers use (`DATABASE_ENCRYPTION_KEY`, `_V2`).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';

export { schema, masterSchema };

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DbEnv {
  DATABASE_URL_MASTER?: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  TENANT_POOL_MAX_CONNECTIONS?: string;
}

const URL_TTL_MS = 60_000;
const databases = new Map<string, Database>();
const urls = new Map<string, { url: string; at: number }>();
let master: { url: string; db: ReturnType<typeof drizzle<typeof masterSchema>> } | null = null;

function masterDb(env: DbEnv) {
  const url = env.DATABASE_URL_MASTER;
  if (!url) throw new Error('DATABASE_URL_MASTER is not set');
  if (master?.url !== url) master = { url, db: drizzle(postgres(url, { max: 2, idle_timeout: 60, prepare: false }), { schema: masterSchema }) };
  return master.db;
}

function databaseFor(url: string, env: DbEnv): Database {
  let db = databases.get(url);
  if (!db) {
    const max = Number(env.TENANT_POOL_MAX_CONNECTIONS) || 4;
    // Unnamed statements: safe behind PgBouncer's transaction pooling (CloudNativePG's pooler).
    db = drizzle(postgres(url, { max, idle_timeout: 60, prepare: false }), { schema });
    databases.set(url, db);
  }
  return db;
}

/** The workspace's database, by `workspaces.id` or its organization id. */
export async function getTenantDbForWorkspace(env: DbEnv, ref: string): Promise<Database> {
  const cached = urls.get(ref);
  if (cached && Date.now() - cached.at < URL_TTL_MS) return databaseFor(cached.url, env);
  const [workspace] = await masterDb(env)
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
  if (!workspace) throw new Error(`Workspace ${ref} not found`);
  if (!workspace.databaseUrl) throw new Error(`Workspace ${ref} has no database URL`);
  // A stored URL is all Kubernetes has: the Neon fields only matter without one.
  const neon = {
    neonProjectId: workspace.neonProjectId ?? '',
    neonBranchId: workspace.neonBranchId ?? '',
    neonRoleName: workspace.neonRoleName ?? '',
    neonDatabaseName: workspace.neonDatabaseName ?? '',
  };
  const url = await resolveDatabaseUrl('', { ...workspace, ...neon }, {
    v1: env.DATABASE_ENCRYPTION_KEY,
    v2: env.DATABASE_ENCRYPTION_KEY_V2,
  });
  urls.set(ref, { url, at: Date.now() });
  return databaseFor(url, env);
}

/** Closes every connection (shutdown, tests). */
export async function closeDatabases(): Promise<void> {
  databases.clear();
  urls.clear();
  master = null;
}
