import 'server-only';

import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';

const { workspaces, plans, userWorkspaces, users } = masterSchema;

export type WorkspaceDeletionState = 'active' | 'scheduled' | 'deleted';

export interface WorkspaceRow {
  id: string;
  clerkOrgId: string | null;
  name: string;
  slug: string;
  imageUrl: string | null;
  planName: string | null;
  isActive: boolean;
  createdAt: string;
  /** Deletion lifecycle derived from the raw columns below. */
  deletionState: WorkspaceDeletionState;
  scheduledDeletionAt: string | null;
  deletionRequestedAt: string | null;
  deletionRequestedBy: string | null;
  deletionReason: string | null;
  deletedAt: string | null;
  /** True when a schedule was set by an admin (vs the trial-expiry billing policy). */
  adminInitiated: boolean;
}

function deletionState(row: {
  deletedAt: Date | null;
  scheduledDeletionAt: Date | null;
}): WorkspaceDeletionState {
  if (row.deletedAt) return 'deleted';
  if (row.scheduledDeletionAt) return 'scheduled';
  return 'active';
}

export interface WorkspaceListFilters {
  search?: string;
}

const LIST_LIMIT = 200;

export async function listWorkspaces(filters: WorkspaceListFilters = {}): Promise<WorkspaceRow[]> {
  const db = getMasterDb();
  const search = filters.search?.trim();

  const where = search
    ? or(ilike(workspaces.name, `%${search}%`), ilike(workspaces.slug, `%${search}%`))
    : undefined;

  const rows = await db
    .select({
      id: workspaces.id,
      clerkOrgId: workspaces.clerkOrgId,
      name: workspaces.name,
      slug: workspaces.slug,
      imageUrl: workspaces.imageUrl,
      planName: plans.name,
      isActive: workspaces.isActive,
      createdAt: workspaces.createdAt,
      scheduledDeletionAt: workspaces.scheduledDeletionAt,
      deletionRequestedAt: workspaces.deletionRequestedAt,
      deletionRequestedBy: workspaces.deletionRequestedBy,
      deletionReason: workspaces.deletionReason,
      deletedAt: workspaces.deletedAt,
    })
    .from(workspaces)
    .leftJoin(plans, eq(workspaces.planId, plans.id))
    .where(where)
    .orderBy(desc(workspaces.createdAt))
    .limit(LIST_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    clerkOrgId: row.clerkOrgId,
    name: row.name,
    slug: row.slug,
    imageUrl: row.imageUrl,
    planName: row.planName,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    deletionState: deletionState(row),
    scheduledDeletionAt: row.scheduledDeletionAt ? row.scheduledDeletionAt.toISOString() : null,
    deletionRequestedAt: row.deletionRequestedAt ? row.deletionRequestedAt.toISOString() : null,
    deletionRequestedBy: row.deletionRequestedBy,
    deletionReason: row.deletionReason,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    adminInitiated: Boolean(row.deletionRequestedBy),
  }));
}

export async function getWorkspaceById(id: string): Promise<WorkspaceRow | null> {
  const db = getMasterDb();
  const [row] = await db
    .select({
      id: workspaces.id,
      clerkOrgId: workspaces.clerkOrgId,
      name: workspaces.name,
      slug: workspaces.slug,
      imageUrl: workspaces.imageUrl,
      planName: plans.name,
      isActive: workspaces.isActive,
      createdAt: workspaces.createdAt,
      scheduledDeletionAt: workspaces.scheduledDeletionAt,
      deletionRequestedAt: workspaces.deletionRequestedAt,
      deletionRequestedBy: workspaces.deletionRequestedBy,
      deletionReason: workspaces.deletionReason,
      deletedAt: workspaces.deletedAt,
    })
    .from(workspaces)
    .leftJoin(plans, eq(workspaces.planId, plans.id))
    .where(eq(workspaces.id, id))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    clerkOrgId: row.clerkOrgId,
    name: row.name,
    slug: row.slug,
    imageUrl: row.imageUrl,
    planName: row.planName,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    deletionState: deletionState(row),
    scheduledDeletionAt: row.scheduledDeletionAt ? row.scheduledDeletionAt.toISOString() : null,
    deletionRequestedAt: row.deletionRequestedAt ? row.deletionRequestedAt.toISOString() : null,
    deletionRequestedBy: row.deletionRequestedBy,
    deletionReason: row.deletionReason,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    adminInitiated: Boolean(row.deletionRequestedBy),
  };
}

/**
 * Resolve the notification recipients for a workspace — its admin members
 * (Clerk `org:admin`), falling back to any active member if no admin is found.
 * Used to warn the workspace's owners when an admin schedules/cancels deletion.
 */
export async function getWorkspaceNotifyEmails(workspaceId: string): Promise<string[]> {
  const db = getMasterDb();

  const admins = await db
    .select({ email: users.email })
    .from(userWorkspaces)
    .innerJoin(users, eq(userWorkspaces.userId, users.id))
    .where(
      and(
        eq(userWorkspaces.workspaceId, workspaceId),
        eq(userWorkspaces.status, 'ACTIVE'),
        eq(userWorkspaces.role, 'org:admin'),
      ),
    );

  const emails = admins.map((r) => r.email).filter(Boolean);
  if (emails.length > 0) return dedupe(emails);

  const anyMembers = await db
    .select({ email: users.email })
    .from(userWorkspaces)
    .innerJoin(users, eq(userWorkspaces.userId, users.id))
    .where(and(eq(userWorkspaces.workspaceId, workspaceId), eq(userWorkspaces.status, 'ACTIVE')));

  return dedupe(anyMembers.map((r) => r.email).filter(Boolean));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.toLowerCase()))];
}
