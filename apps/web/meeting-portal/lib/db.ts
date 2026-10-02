import { getExistingTenantDb, isTenantNotFoundError } from '@weldsuite/db';

export { isTenantNotFoundError };

/**
 * Resolve a tenant database from a workspace ID or Clerk org ID.
 *
 * The id comes straight from a public URL, so this never provisions anything:
 * the old `getTenantDb(clerkOrgId)` auto-created a phantom `workspaces` row for
 * every unknown id before failing. An unknown (or inactive) workspace throws
 * `TenantNotFoundError`, which the API routes turn into a 404 via
 * `tenantNotFoundResponse()`.
 *
 * Besides the database, the result carries the workspace's `clerkOrgId`: the
 * realtime hub is keyed by it, not by the workspace id.
 */
export async function getTenantDb(id: string) {
  return getExistingTenantDb(id);
}
