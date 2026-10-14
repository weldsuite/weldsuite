/**
 * Member-count helpers — Clerk is the source of truth for workspace
 * membership (webhooks can be missed), so seat/limit reads fetch the real
 * count from Clerk and reconcile `user_workspaces` in the background when
 * the DB drifts.
 *
 * Ported from apps/api-worker/src/lib/members.ts (W3 legacy-worker
 * phase-out). Pure functions — no Hono context.
 */

import { eq, inArray, or, sql } from 'drizzle-orm';
import type { Env } from '../types';
import {
  getTenantDbForWorkspace,
  masterSchema,
  schema,
  type Database,
  type MasterDatabase,
} from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { logSafe } from '@weldsuite/worker-kit/log-safe';

const { users, userWorkspaces } = masterSchema;

export interface ClerkMembershipListItem {
  id: string;
  role: string;
  created_at: number;
  public_user_data: {
    user_id: string;
    first_name: string | null;
    last_name: string | null;
    identifier: string;
  };
}

/**
 * Remove a user from a Clerk organization. Clerk addresses the membership by
 * the member's user id (`DELETE /organizations/{org}/memberships/{user_id}`),
 * not by the membership id. Returns true when the user is no longer a member,
 * including when Clerk says they weren't one (404).
 */
export async function removeClerkMembership(
  secretKey: string,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const resp = await fetch(
    `https://api.clerk.com/v1/organizations/${orgId}/memberships/${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${secretKey}` } },
  );
  if (resp.ok || resp.status === 404) return true;
  console.error('[member-count] Clerk membership delete failed:', resp.status);
  return false;
}

type TenantMemberRef = { userId: string; email: string | null; deletedAt: Date | null };

/**
 * Clerk memberships of people WeldSuite already removed: the user has a
 * soft-deleted member row and no live one, neither by user id nor by email (a
 * pending re-invite). A user with no row at all is left alone, since that is
 * a membership.created webhook that hasn't landed yet.
 *
 * These exist because the team-members DELETE route used to address Clerk by
 * membership id, which Clerk 404s, so the member was removed here but stayed
 * in the Clerk organization and kept taking a seat.
 */
export function pickRemovedMemberships(
  memberships: ClerkMembershipListItem[],
  tenantRows: TenantMemberRef[],
): ClerkMembershipListItem[] {
  const liveUserIds = new Set<string>();
  const liveEmails = new Set<string>();
  const removedUserIds = new Set<string>();
  for (const row of tenantRows) {
    if (row.deletedAt) {
      removedUserIds.add(row.userId);
    } else {
      liveUserIds.add(row.userId);
      if (row.email) liveEmails.add(row.email.toLowerCase());
    }
  }

  return memberships.filter((m) => {
    const userId = m.public_user_data.user_id;
    const email = m.public_user_data.identifier?.toLowerCase();
    return (
      removedUserIds.has(userId) &&
      !liveUserIds.has(userId) &&
      !(email && liveEmails.has(email))
    );
  });
}

async function loadTenantMemberRefs(
  tenantDb: Database,
  memberships: ClerkMembershipListItem[],
): Promise<TenantMemberRef[]> {
  if (memberships.length === 0) return [];
  const { workspaceMembers } = schema;
  const userIds = memberships.map((m) => m.public_user_data.user_id);
  const emails = memberships
    .map((m) => m.public_user_data.identifier?.toLowerCase())
    .filter((e): e is string => Boolean(e));

  return tenantDb
    .select({
      userId: workspaceMembers.userId,
      email: workspaceMembers.email,
      deletedAt: workspaceMembers.deletedAt,
    })
    .from(workspaceMembers)
    .where(
      emails.length > 0
        ? or(
            inArray(workspaceMembers.userId, userIds),
            inArray(sql`lower(${workspaceMembers.email})`, emails),
          )
        : inArray(workspaceMembers.userId, userIds),
    );
}

/**
 * Splits Clerk memberships into the ones that hold a seat and the ones left
 * behind by members WeldSuite already removed, and finishes removing the
 * latter from Clerk (best effort) so they stop counting against Clerk's cap
 * and lose access. When the tenant DB can't be read, every membership counts.
 */
async function dropRemovedMemberships(
  env: Env,
  clerkOrgId: string,
  memberships: ClerkMembershipListItem[],
): Promise<ClerkMembershipListItem[]> {
  let removed: ClerkMembershipListItem[];
  try {
    const tenantDb = await getTenantDbForWorkspace(env, clerkOrgId);
    removed = pickRemovedMemberships(memberships, await loadTenantMemberRefs(tenantDb, memberships));
  } catch (err) {
    console.warn('[member-count] Could not check memberships against the tenant DB:', err);
    return memberships;
  }
  if (removed.length === 0) return memberships;

  console.warn(
    `[member-count] ${removed.length} removed member(s) still in Clerk org ${logSafe(clerkOrgId)}, removing`,
  );
  await Promise.allSettled(
    removed.map((m) => removeClerkMembership(env.CLERK_SECRET_KEY, clerkOrgId, m.public_user_data.user_id)),
  );

  const removedIds = new Set(removed.map((m) => m.id));
  return memberships.filter((m) => !removedIds.has(m.id));
}

/**
 * Fetches the real organization membership count from Clerk's API,
 * ensuring accuracy even when webhooks have failed. Members WeldSuite already
 * removed but Clerk still lists are not counted (and are removed from Clerk).
 * If the DB count differs from Clerk, syncs userWorkspaces in the background.
 * Falls back to the DB count when Clerk is unreachable.
 */
export async function getAccurateMemberCount(
  env: Env,
  clerkOrgId: string,
  workspaceId: string,
  masterDb: MasterDatabase,
): Promise<number> {
  // Get DB count (fast, always available)
  const dbMembers = await masterDb
    .select()
    .from(userWorkspaces)
    .where(eq(userWorkspaces.workspaceId, workspaceId));

  const dbCount = dbMembers.filter(
    (m) => m.status === 'ACTIVE' || m.status === 'PENDING',
  ).length;

  // Fetch real count from Clerk (source of truth)
  try {
    const membershipsResp = await fetch(
      `https://api.clerk.com/v1/organizations/${clerkOrgId}/memberships?limit=500`,
      { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } },
    );

    if (!membershipsResp.ok) {
      console.warn(
        `[member-count] Clerk memberships API returned ${membershipsResp.status}, using DB count`,
      );
      return dbCount;
    }

    const memberships = (await membershipsResp.json()) as {
      data: ClerkMembershipListItem[];
      total_count: number;
    };

    const seatMemberships = await dropRemovedMemberships(env, clerkOrgId, memberships.data);
    const clerkCount = memberships.total_count - (memberships.data.length - seatMemberships.length);

    // If counts match, no sync needed
    if (clerkCount === dbCount) {
      return clerkCount;
    }

    // Counts differ — sync userWorkspaces from Clerk data (fire-and-forget)
    console.warn(
      `[member-count] Member count mismatch for workspace ${logSafe(workspaceId)}: DB=${dbCount}, Clerk=${logSafe(clerkCount)}. Syncing...`,
    );

    syncUserWorkspacesFromClerk(masterDb, workspaceId, dbMembers, seatMemberships).catch(
      (err) => {
        console.error('[member-count] Background member sync failed:', err);
      },
    );

    return clerkCount;
  } catch (err) {
    console.warn('[member-count] Failed to fetch from Clerk API, using DB count:', err);
    return dbCount;
  }
}

/**
 * Reconciles userWorkspaces with Clerk membership data.
 * Adds missing members and removes stale ones.
 */
export async function syncUserWorkspacesFromClerk(
  masterDb: MasterDatabase,
  workspaceId: string,
  dbMembers: (typeof userWorkspaces.$inferSelect)[],
  clerkMembers: ClerkMembershipListItem[],
): Promise<void> {
  const existingByUserId = new Map(dbMembers.map((m) => [m.userId, m]));
  const clerkUserIds = new Set<string>();

  // Add/update members from Clerk
  for (const member of clerkMembers) {
    const userId = member.public_user_data.user_id;
    clerkUserIds.add(userId);

    const existing = existingByUserId.get(userId);
    if (!existing) {
      // Ensure the user record exists (webhook may not have fired yet)
      await masterDb
        .insert(users)
        .values({
          id: userId,
          email: member.public_user_data.identifier || '',
          firstName: member.public_user_data.first_name,
          lastName: member.public_user_data.last_name,
        })
        .onConflictDoNothing();

      // Member exists in Clerk but not in DB — add it
      await masterDb
        .insert(userWorkspaces)
        .values({
          id: generateId('uw'),
          userId,
          workspaceId,
          clerkMembershipId: member.id,
          role: member.role,
          status: 'ACTIVE',
          joinedAt: new Date(member.created_at),
        })
        .onConflictDoNothing();
    } else if (existing.status !== 'ACTIVE') {
      // Member exists but wrong status — fix it
      await masterDb
        .update(userWorkspaces)
        .set({ status: 'ACTIVE', clerkMembershipId: member.id, updatedAt: new Date() })
        .where(eq(userWorkspaces.id, existing.id));
    }
  }

  // Remove members that are no longer in Clerk
  for (const dbMember of dbMembers) {
    if (dbMember.status === 'ACTIVE' && !clerkUserIds.has(dbMember.userId)) {
      await masterDb.delete(userWorkspaces).where(eq(userWorkspaces.id, dbMember.id));
    }
  }
}
