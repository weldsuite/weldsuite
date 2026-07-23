import 'server-only';

import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { getCachedWorkspace, setCachedWorkspace } from './workspace-cache';

function masterUrl(): string {
  const url = process.env.DATABASE_URL_MASTER;
  if (!url) throw new Error('DATABASE_URL_MASTER is not set');
  return url;
}

export function getMasterDb(): NeonHttpDatabase<typeof masterSchema> {
  const sql = neon(masterUrl());
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

function createNeonTenantDb(connectionUrl: string): NeonHttpDatabase<typeof schema> {
  const sql = neon(connectionUrl);
  return drizzleNeonHttp({ client: sql, schema });
}

async function lookupWorkspace(clerkOrgId: string): Promise<{ id: string; databaseUrl: string }> {
  const cached = getCachedWorkspace(clerkOrgId);
  if (cached) return cached;

  const masterDb = getMasterDb();
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
    process.env.NEON_API_KEY ?? '',
    workspace as NeonConnectionInput,
    { v1: process.env.DATABASE_ENCRYPTION_KEY, v2: process.env.DATABASE_ENCRYPTION_KEY_V2 },
  );

  const entry = { id: workspace.id, databaseUrl };
  setCachedWorkspace(clerkOrgId, entry);
  return entry;
}

type NeonConnectionInput = {
  neonProjectId: string;
  neonBranchId: string;
  neonRoleName: string;
  neonDatabaseName: string | null;
  databaseUrl?: string | null;
};

export async function getTenantDbForWorkspace(
  clerkOrgId: string,
): Promise<NeonHttpDatabase<typeof schema>> {
  const workspace = await lookupWorkspace(clerkOrgId);
  return createNeonTenantDb(workspace.databaseUrl);
}

export type Database = NeonHttpDatabase<typeof schema>;
export type MasterDatabase = NeonHttpDatabase<typeof masterSchema>;
export { schema, masterSchema };
