import '@tanstack/react-start/server-only';

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@weldsuite/db/schema';
import * as masterSchema from '@weldsuite/db/schema/master';
import { decryptWorkspaceDatabaseUrl } from '@weldsuite/db/lib/crypto';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';
import { openMasterDb, openTenantDb } from '@/lib/server/database';
import { GLOBAL } from './edition';
import { getCachedWorkspace, setCachedWorkspace } from './workspace-cache';

function masterUrl(): string {
  const url = process.env.DATABASE_URL_MASTER;
  if (!url) throw new Error('DATABASE_URL_MASTER is not set');
  return url;
}

/**
 * The driver-neutral Drizzle types every caller uses: Neon HTTP on Global,
 * postgres.js over TCP on Kubernetes (`lib/server/database*.ts`).
 * No caller may use `.transaction()` or `.batch()`: Neon HTTP has neither.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
export type MasterDatabase = PgDatabase<PgQueryResultHKT, typeof masterSchema>;

export function getMasterDb(): MasterDatabase {
  return openMasterDb(masterUrl());
}

export interface WorkspaceDatabaseRow {
  /** `workspaces.id` of the row `databaseUrl` came from: the AAD of a v3 value. */
  id: string;
  neonProjectId: string | null;
  neonBranchId: string | null;
  neonRoleName: string | null;
  neonDatabaseName: string | null;
  databaseUrl: string | null;
}

/**
 * Global: the stored URL when there is one, else Neon's API, as the console
 * always did (`resolveDatabaseUrl`).
 */
function resolveOnGlobal(workspace: WorkspaceDatabaseRow): Promise<string> {
  const { neonProjectId, neonBranchId, neonRoleName } = workspace;
  if (!neonProjectId || !neonBranchId || !neonRoleName) {
    throw new Error(`No database configured for workspace: ${workspace.id}`);
  }
  return resolveDatabaseUrl(
    process.env.NEON_API_KEY ?? '',
    { ...workspace, neonProjectId, neonBranchId, neonRoleName },
    { v1: process.env.DATABASE_ENCRYPTION_KEY, v2: process.env.DATABASE_ENCRYPTION_KEY_V2 },
  );
}

/**
 * Kubernetes: the URL the Rust server stored when it provisioned the
 * workspace, sealed with the install's `DATABASE_ENCRYPTION_KEY(_V2)`. There
 * is no Neon here, so nothing else is tried. Exported for its tests.
 */
export async function openStoredUrl(workspace: WorkspaceDatabaseRow): Promise<string> {
  const stored = workspace.databaseUrl;
  if (!stored) throw new Error(`No database configured for workspace: ${workspace.id}`);
  if (stored.startsWith('postgres://') || stored.startsWith('postgresql://')) return stored;

  const keyring = { v1: process.env.DATABASE_ENCRYPTION_KEY, v2: process.env.DATABASE_ENCRYPTION_KEY_V2 };
  if (!keyring.v1 && !keyring.v2) {
    throw new Error('DATABASE_ENCRYPTION_KEY is not set: the tenant database URLs cannot be opened');
  }
  return decryptWorkspaceDatabaseUrl(stored, workspace.id, keyring);
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
    .where(matchWorkspaceRef(clerkOrgId))
    .limit(1);

  if (!workspace) throw new Error(`Workspace not found: ${clerkOrgId}`);

  const databaseUrl = GLOBAL ? await resolveOnGlobal(workspace) : await openStoredUrl(workspace);
  const entry = { id: workspace.id, databaseUrl };
  setCachedWorkspace(clerkOrgId, entry);
  return entry;
}

export async function getTenantDbForWorkspace(
  clerkOrgId: string,
): Promise<Database> {
  const workspace = await lookupWorkspace(clerkOrgId);
  return openTenantDb(workspace.databaseUrl);
}

export { schema, masterSchema };
