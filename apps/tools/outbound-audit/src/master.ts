/**
 * Workspace enumeration from the master DB, the same selection as the tenant
 * migration runner (apps/tools/migrate-databases): active workspaces with a
 * Neon database, connection URL from `resolveDatabaseUrl` (stored URL,
 * decrypted with DATABASE_ENCRYPTION_KEY(_V2), else the Neon API).
 */

import type postgres from 'postgres';
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import type { TrustFacts } from './limits';

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  subscriptionStatus: string | null;
  compGrantedAt: Date | null;
  billingMode: string | null;
  planPriceMonthly: string | null;
  neonProjectId: string | null;
  neonBranchId: string | null;
  neonRoleName: string | null;
  neonDatabaseName: string | null;
  databaseUrl: string | null;
}

/** Active workspaces with a tenant database; `filter` matches id, slug or Clerk org id. */
export async function listWorkspaces(master: postgres.Sql, filter: string | null): Promise<WorkspaceRow[]> {
  const rows = await master<WorkspaceRow[]>`
    SELECT w.id,
           w.name,
           w.slug,
           (w.created_at AT TIME ZONE 'UTC') AS "createdAt",
           w.subscription_status AS "subscriptionStatus",
           (w.comp_granted_at AT TIME ZONE 'UTC') AS "compGrantedAt",
           w.billing_mode AS "billingMode",
           p.price_monthly::text AS "planPriceMonthly",
           w.neon_project_id AS "neonProjectId",
           w.neon_branch_id AS "neonBranchId",
           w.neon_role_name AS "neonRoleName",
           w.neon_database_name AS "neonDatabaseName",
           w.database_url AS "databaseUrl"
    FROM workspaces w
    LEFT JOIN plans p ON p.id = w.plan_id
    WHERE w.is_active = true
      AND w.neon_project_id IS NOT NULL
      ${filter ? master`AND (w.id = ${filter} OR w.slug = ${filter} OR w.clerk_org_id = ${filter})` : master``}
    ORDER BY w.created_at, w.id`;
  return rows.map((row) => ({ ...row }));
}

export function trustFactsOf(row: WorkspaceRow): TrustFacts {
  const price = row.planPriceMonthly === null ? null : Number(row.planPriceMonthly);
  return {
    createdAt: row.createdAt,
    subscriptionStatus: row.subscriptionStatus,
    planPriceMonthly: price === null || Number.isNaN(price) ? null : price,
    // Comp plans and partner-billed workspaces are paid for, as in the guard's policy store.
    compGranted: row.compGrantedAt !== null || row.billingMode === 'partner',
  };
}

/** The tenant connection string, or null when the workspace has no complete Neon metadata. */
export async function tenantDatabaseUrl(row: WorkspaceRow, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!row.neonProjectId || !row.neonBranchId || !row.neonRoleName) return null;
  return resolveDatabaseUrl(
    env.NEON_API_KEY ?? '',
    {
      neonProjectId: row.neonProjectId,
      neonBranchId: row.neonBranchId,
      neonRoleName: row.neonRoleName,
      neonDatabaseName: row.neonDatabaseName,
      databaseUrl: row.databaseUrl,
    },
    keyringFromEnv(env),
  );
}
