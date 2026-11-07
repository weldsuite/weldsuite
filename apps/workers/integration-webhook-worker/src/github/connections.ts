/**
 * GitHub connection helpers for the App webhook receiver.
 *
 * A GitHub App installation is a WeldMerge connection (`merge_connections`,
 * provider `github`, `external_account_id` = the installation id as text);
 * `github_connections` is no longer read. `workspaceOfInstallation` resolves
 * which workspace an installation belongs to: the master installation index
 * (`merge_provider_index`, written when the installation is recorded) first,
 * and a scan of the tenant databases only as a last resort, which also writes
 * the index row so the scan happens once per installation.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { decryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import {
  removeGithubInstallationIndex,
  setGithubInstallationStatus,
  upsertGithubInstallationIndex,
} from '@weldsuite/merge-domain/installations';
import type { Env } from '../index';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema, type TenantDatabase } from '../db';

/** The live GitHub connection of an installation, newest active first. */
export async function getConnectionByInstallationId(db: TenantDatabase, installationId: number) {
  const [row] = await db
    .select()
    .from(schema.mergeConnections)
    .where(
      and(
        eq(schema.mergeConnections.provider, 'github'),
        eq(schema.mergeConnections.externalAccountId, String(installationId)),
        isNull(schema.mergeConnections.deletedAt),
      ),
    )
    .orderBy(sql`(${schema.mergeConnections.status} = 'active') desc`, desc(schema.mergeConnections.createdAt))
    .limit(1);
  return row ?? null;
}

export function getDecryptedWebhookSecret(
  connection: { webhookSecret?: string | null },
  encryptionKey: EncryptionKeyring,
): Promise<string | null> {
  if (!connection.webhookSecret) return Promise.resolve(null);
  return decryptField(connection.webhookSecret, encryptionKey);
}

/** Moves the installation's connection to `status` (GitHub's `installation` lifecycle events). */
export async function updateConnectionStatus(
  db: TenantDatabase,
  installationId: number,
  status: 'active' | 'suspended' | 'revoked',
): Promise<void> {
  await setGithubInstallationStatus(db, installationId, status);
}

/** Drops the installation's row from the master index (it was uninstalled). */
export async function forgetInstallation(env: Env, installationId: number): Promise<void> {
  await removeGithubInstallationIndex(getMasterDb(env), installationId);
}

/**
 * The workspace of an installation, as its Clerk org id (what the rest of this
 * receiver and the project-sync rows are keyed by; it falls back to
 * `workspaces.id` for a workspace without one).
 *
 *  1. the master index row (`merge_provider_index`, kind `installation`);
 *  2. a scan of the workspaces' tenant databases for a live `merge_connections`
 *     row, which then writes the index row (a lazy backfill, DATA-008).
 */
export async function workspaceOfInstallation(env: Env, installationId: number): Promise<string | null> {
  const masterDb = getMasterDb(env);
  try {
    const [indexed] = await masterDb
      .select({ workspaceId: masterSchema.mergeProviderIndex.workspaceId })
      .from(masterSchema.mergeProviderIndex)
      .where(
        and(
          eq(masterSchema.mergeProviderIndex.provider, 'github'),
          eq(masterSchema.mergeProviderIndex.kind, 'installation'),
          eq(masterSchema.mergeProviderIndex.externalKey, String(installationId)),
        ),
      )
      .limit(1);
    if (indexed) {
      const [workspace] = await masterDb
        .select({ id: masterSchema.workspaces.id, clerkOrgId: masterSchema.workspaces.clerkOrgId })
        .from(masterSchema.workspaces)
        .where(eq(masterSchema.workspaces.id, indexed.workspaceId))
        .limit(1);
      if (workspace) return workspace.clerkOrgId ?? workspace.id;
    }
    return await scanForInstallation(env, masterDb, installationId);
  } catch (err) {
    console.error('[GitHub Webhook] Failed to resolve workspace for installation:', err);
    return null;
  }
}

async function scanForInstallation(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  installationId: number,
): Promise<string | null> {
  const workspaces = await masterDb
    .select({ id: masterSchema.workspaces.id, clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .limit(500);

  for (const ws of workspaces) {
    const ref = ws.clerkOrgId ?? ws.id;
    try {
      const tenantDb = await getTenantDbForWorkspace(env, ref);
      const [conn] = await tenantDb
        .select({ id: schema.mergeConnections.id })
        .from(schema.mergeConnections)
        .where(
          and(
            eq(schema.mergeConnections.provider, 'github'),
            eq(schema.mergeConnections.externalAccountId, String(installationId)),
            isNull(schema.mergeConnections.deletedAt),
          ),
        )
        .limit(1);
      if (conn) {
        // The next delivery for this installation finds the index row.
        await upsertGithubInstallationIndex(masterDb, installationId, ws.id);
        return ref;
      }
    } catch {
      // Skip workspaces whose DB fails to resolve.
    }
  }
  return null;
}
