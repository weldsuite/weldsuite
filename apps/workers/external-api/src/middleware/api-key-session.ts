/**
 * Step 3 of `wsk_` key validation: load the key row from the workspace's own
 * database and shape the session.
 *
 * Kept apart from `auth.ts` (which pulls in the Neon connection resolver and
 * the KV caches) so the live key and membership checks can be exercised against
 * a real database without loading the rest of the auth middleware.
 */

import { eq, and, isNull, or, gt } from 'drizzle-orm';
import { apiKeys } from '@weldsuite/db/schema/api-keys';
import { workspaceApiKeys } from '@weldsuite/db/schema/workspace-api-keys';
import { workspaceMembers } from '@weldsuite/db/schema/workspace-members';
import type { ApiKeySession } from '../types';
import type { Database } from '../db';
import type { CachedRegistryEntry, CachedWorkspaceDetails } from './auth';

type TenantDb = Database;

/**
 * Load a live workspace key: not deleted, not expired. Workspace keys belong
 * to the workspace, not to a person, so there is no owner to check.
 */
export async function loadWorkspaceKey(
  tenantDb: TenantDb,
  tenantKeyId: string,
  now: Date,
): Promise<typeof workspaceApiKeys.$inferSelect | null> {
  const [workspaceKey] = await tenantDb
    .select()
    .from(workspaceApiKeys)
    .where(
      and(
        eq(workspaceApiKeys.id, tenantKeyId),
        isNull(workspaceApiKeys.deletedAt),
        or(isNull(workspaceApiKeys.expiresAt), gt(workspaceApiKeys.expiresAt, now)),
      ),
    )
    .limit(1);
  return workspaceKey ?? null;
}

/**
 * Load a live personal key: not deleted, not expired, AND its owner is still an
 * ACTIVE member of the workspace.
 *
 * A personal key is only as good as the person behind it. The key row's frozen
 * scopes are the whole authorisation here, so offboarding (member removed,
 * suspended, or an invite never accepted) has to stop the key by itself. The
 * membership test is the one the permission resolver uses
 * (`createDrizzlePermissionQueries.getMember`: `deleted_at IS NULL AND
 * status = 'ACTIVE'`), done in the same query so it costs no extra round trip,
 * and, like the key row, it is read live on every request, never cached.
 *
 * `workspace_members.user_id` is unique, so the join yields at most one row.
 */
export async function loadPersonalKey(
  tenantDb: TenantDb,
  tenantKeyId: string,
  now: Date,
): Promise<typeof apiKeys.$inferSelect | null> {
  const [row] = await tenantDb
    .select({ key: apiKeys })
    .from(apiKeys)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, apiKeys.userId))
    .where(
      and(
        eq(apiKeys.id, tenantKeyId),
        isNull(apiKeys.deletedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
        isNull(workspaceMembers.deletedAt),
        eq(workspaceMembers.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  return row?.key ?? null;
}

/**
 * Step 3 of key validation, on an open tenant DB: load the key live and shape
 * the session. `null` means the key does not authenticate: deleted, expired,
 * or (personal key) its owner is no longer an active member.
 *
 * Nothing here is cached: the registry and workspace lookups before it are
 * (5 minutes), but the key row and the owner's membership are read on every
 * request, so offboarding takes effect on the owner's very next call.
 */
export async function sessionFromTenantKey(
  tenantDb: TenantDb,
  registryEntry: CachedRegistryEntry,
  workspace: CachedWorkspaceDetails,
  now: Date,
): Promise<ApiKeySession | null> {
  const restrictions = {
    tier: workspace.tier,
    databaseUrl: workspace.databaseUrl,
    clerkOrgId: workspace.clerkOrgId,
    licensedApps: workspace.licensedApps ?? null,
    readOnly: workspace.readOnly ?? false,
    readOnlyReason: workspace.readOnly ? (workspace.readOnlyReason ?? 'licence_inactive') : null,
  } as const;

  if (registryEntry.keyType === 'workspace') {
    const workspaceKey = await loadWorkspaceKey(tenantDb, registryEntry.tenantKeyId, now);
    if (!workspaceKey) return null;

    // Fire-and-forget lastUsedAt update
    tenantDb
      .update(workspaceApiKeys)
      .set({ lastUsedAt: now })
      .where(eq(workspaceApiKeys.id, workspaceKey.id))
      .execute()
      .catch(console.error);

    return {
      keyId: workspaceKey.id,
      keyType: 'workspace',
      workspaceId: registryEntry.workspaceId,
      userId: null,
      scopes: (workspaceKey.scopes as string[]) || [],
      ...restrictions,
    };
  }

  // Personal key (also requires its owner to still be an active member)
  const personalKey = await loadPersonalKey(tenantDb, registryEntry.tenantKeyId, now);
  if (!personalKey) return null;

  // Fire-and-forget lastUsedAt update
  tenantDb
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, personalKey.id))
    .execute()
    .catch(console.error);

  return {
    keyId: personalKey.id,
    keyType: 'personal',
    workspaceId: registryEntry.workspaceId,
    userId: personalKey.userId,
    scopes: (personalKey.scopes as string[]) || [],
    ...restrictions,
  };
}
