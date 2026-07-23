import { getTenantDbByWorkspaceId, getTenantDb as getTenantDbByClerkOrgId } from '@weldsuite/db';

/**
 * Resolve a tenant database from a workspace ID or Clerk org ID.
 * Tries workspace ID first, falls back to Clerk org ID lookup.
 */
export async function getTenantDb(id: string) {
  try {
    return await getTenantDbByWorkspaceId(id);
  } catch {
    return await getTenantDbByClerkOrgId(id);
  }
}
