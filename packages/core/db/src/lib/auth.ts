// TODO: This file has platform-specific dependencies that need to be made injectable:
// - @clerk/nextjs/server (auth) - used for authentication context
// - react (cache) - React's cache function for request-scoped memoization
// These dependencies will be addressed in a future phase to make this package reusable.
//
// TODO: Make auth() injectable for external-api:
// The auth() calls in this file should be made injectable via a function parameter
// or configuration object to allow non-Clerk auth providers in external-api.
// For now, platform app will use this directly.

import { auth } from '@clerk/nextjs/server';
import { createScopedDb, ScopedDb } from './scoped';
import { getTenantDb, getTenantInfo, type TenantInfo } from './tenant';
import { cache } from 'react';

// Get the current user's ID from Clerk
export const getUserId = cache(async (): Promise<string> => {
  const { userId } = await auth();

  if (!userId) {
    throw new Error('Not authenticated. Please sign in.');
  }

  return userId;
});

// Get the current user's ID (optional - returns null if not authenticated)
export const getUserIdOptional = cache(async (): Promise<string | null> => {
  const { userId } = await auth();
  return userId;
});

// Cached per-request scoped database with tenant routing
export const getScopedDb = cache(async (): Promise<ScopedDb> => {
  const { orgId, userId } = await auth();

  if (!orgId) {
    throw new Error('No workspace selected. Please select a workspace.');
  }

  const tenantDb = await getTenantDb(orgId);

  return createScopedDb({
    db: tenantDb.db,
    userId: userId || undefined,
    tier: tenantDb.tier,
  });
});

// For cases where you might not have a workspace (e.g., onboarding)
export const getScopedDbOptional = cache(async (): Promise<ScopedDb | null> => {
  const { orgId, userId } = await auth();

  if (!orgId) {
    return null;
  }

  try {
    const tenantDb = await getTenantDb(orgId);

    return createScopedDb({
      db: tenantDb.db,
      userId: userId || undefined,
      tier: tenantDb.tier,
    });
  } catch {
    return null;
  }
});

// Get just the workspace ID without creating a scoped DB
export const getWorkspaceId = cache(async (): Promise<string> => {
  const { orgId } = await auth();

  if (!orgId) {
    throw new Error('No workspace selected. Please select a workspace.');
  }

  return orgId;
});

/**
 * Get scoped database for a specific workspace ID
 * Use this when you have the workspaceId from another source (e.g., widget lookup)
 * and don't need to get it from the auth context.
 */
export async function getScopedDbForWorkspace(workspaceId: string): Promise<ScopedDb> {
  const tenantDb = await getTenantDb(workspaceId);

  return createScopedDb({
    db: tenantDb.db,
    userId: undefined,
    tier: tenantDb.tier,
  });
}

// Get tenant info (tier, database type, etc.)
export const getTenant = cache(async (): Promise<TenantInfo> => {
  const { orgId } = await auth();

  if (!orgId) {
    throw new Error('No workspace selected. Please select a workspace.');
  }

  const info = await getTenantInfo(orgId);

  if (!info) {
    throw new Error('Workspace not found or inactive.');
  }

  return info;
});

/**
 * @deprecated Clerk webhooks now handle syncing member data when invitations are accepted.
 * This function is kept for backward compatibility but does nothing.
 * The organizationMembership.created webhook creates/updates local member records.
 */
export async function autoAcceptPendingInvites(): Promise<{ accepted: number }> {
  // No-op: Clerk webhooks handle member syncing
  // See: apps/web/platform/app/api/webhooks/clerk/route.ts
  return { accepted: 0 };
}
