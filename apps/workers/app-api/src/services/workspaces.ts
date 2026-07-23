/**
 * Workspaces service — master-DB reads for the workspace switcher.
 * Pure functions over the master Drizzle client; no Hono context.
 */

import { and, eq } from 'drizzle-orm';
import { masterSchema, type MasterDatabase } from '../db';

export interface WorkspaceSummary {
  /** Clerk org id — the identifier clients use to switch orgs. */
  id: string;
  /** Internal master-DB workspace id. */
  workspaceId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  role: string;
}

/** List the workspaces the given user is an active member of. */
export async function listUserWorkspaces(
  masterDb: MasterDatabase,
  userId: string,
): Promise<WorkspaceSummary[]> {
  const rows = await masterDb
    .select({
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
      workspaceId: masterSchema.workspaces.id,
      name: masterSchema.workspaces.name,
      slug: masterSchema.workspaces.slug,
      imageUrl: masterSchema.workspaces.imageUrl,
      role: masterSchema.userWorkspaces.role,
    })
    .from(masterSchema.userWorkspaces)
    .innerJoin(
      masterSchema.workspaces,
      eq(masterSchema.userWorkspaces.workspaceId, masterSchema.workspaces.id),
    )
    .where(
      and(
        eq(masterSchema.userWorkspaces.userId, userId),
        eq(masterSchema.userWorkspaces.status, 'ACTIVE'),
        eq(masterSchema.workspaces.isActive, true),
      ),
    );

  return rows.map((r) => ({
    // Fall back to the internal id for any legacy row without a Clerk org id.
    id: r.clerkOrgId ?? r.workspaceId,
    workspaceId: r.workspaceId,
    name: r.name,
    slug: r.slug,
    imageUrl: r.imageUrl,
    role: r.role,
  }));
}
