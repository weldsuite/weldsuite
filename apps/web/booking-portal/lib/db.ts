import { eq, like, desc } from 'drizzle-orm';
import { masterDb } from '@weldsuite/db/lib/master';
import { workspaces } from '@weldsuite/db/schema/master';
import { getTenantDbByWorkspaceId } from '@weldsuite/db/lib/tenant';

/**
 * Resolve a tenant database connection from a workspace slug.
 *
 * Supports both:
 *  - Full workspace slug (e.g., "acme-corp-1704067200") — exact match
 *  - Clerk org slug (e.g., "acme-corp") — prefix match on "{slug}-*"
 */
export async function getTenantDbBySlug(slug: string) {
  // Try exact match first
  let [workspace] = await masterDb
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      isActive: workspaces.isActive,
      imageUrl: workspaces.imageUrl,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);

  // Fallback: prefix match for Clerk org slugs (workspace slug = "{clerkOrgSlug}-{timestamp}")
  if (!workspace) {
    [workspace] = await masterDb
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        isActive: workspaces.isActive,
        imageUrl: workspaces.imageUrl,
      })
      .from(workspaces)
      .where(like(workspaces.slug, `${slug}-%`))
      .orderBy(desc(workspaces.createdAt))
      .limit(1);
  }

  if (!workspace || !workspace.isActive) return null;

  try {
    const { db } = await getTenantDbByWorkspaceId(workspace.id);
    return { db, workspace };
  } catch (err) {
    console.error('[booking-portal] getTenantDbByWorkspaceId failed for', workspace.id, err);
    return null;
  }
}
