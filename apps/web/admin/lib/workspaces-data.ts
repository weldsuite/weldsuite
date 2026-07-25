import 'server-only';

import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
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
  /** Active memberships. Only populated by {@link listWorkspaces}. */
  memberCount: number;
}

/** A single membership row on the workspace detail screen. */
export interface WorkspaceMemberRow {
  /** Membership id (`user_workspaces.id`), unique per user/workspace pair. */
  id: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  jobTitle: string | null;
  /** Clerk role, e.g. `org:admin` / `org:member`. */
  role: string;
  status: 'ACTIVE' | 'PENDING';
  /** False once the Clerk user has been deleted (we keep the row). */
  userIsActive: boolean;
  invitedAt: string | null;
  joinedAt: string | null;
  createdAt: string;
}

/** Active-membership count, as a correlated subquery. */
const activeMemberCount = sql<number>`(
  select count(*)::int from ${userWorkspaces}
  where ${userWorkspaces.workspaceId} = ${workspaces.id}
    and ${userWorkspaces.status} = 'ACTIVE'
)`;

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
      memberCount: activeMemberCount,
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
    memberCount: Number(row.memberCount ?? 0),
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
    memberCount: 0,
  };
}

/**
 * Every membership of a workspace — active and pending — newest role first
 * (admins above members), then by join date. Read-only: the admin console
 * surfaces memberships, it does not manage them (Clerk owns that).
 */
export async function listWorkspaceMembers(
  workspaceId: string,
): Promise<WorkspaceMemberRow[]> {
  const db = getMasterDb();

  const rows = await db
    .select({
      id: userWorkspaces.id,
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      imageUrl: users.imageUrl,
      jobTitle: users.jobTitle,
      role: userWorkspaces.role,
      status: userWorkspaces.status,
      userIsActive: users.isActive,
      invitedAt: userWorkspaces.invitedAt,
      joinedAt: userWorkspaces.joinedAt,
      createdAt: userWorkspaces.createdAt,
    })
    .from(userWorkspaces)
    .innerJoin(users, eq(userWorkspaces.userId, users.id))
    .where(eq(userWorkspaces.workspaceId, workspaceId))
    .orderBy(asc(userWorkspaces.role), asc(userWorkspaces.createdAt));

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    imageUrl: row.imageUrl,
    jobTitle: row.jobTitle,
    role: row.role,
    status: row.status,
    userIsActive: row.userIsActive,
    invitedAt: row.invitedAt ? row.invitedAt.toISOString() : null,
    joinedAt: row.joinedAt ? row.joinedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));
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
