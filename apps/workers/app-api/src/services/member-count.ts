/**
 * Member-count helpers — Clerk is the source of truth for workspace
 * membership (webhooks can be missed), so seat/limit reads fetch the real
 * count from Clerk and reconcile `user_workspaces` in the background when
 * the DB drifts.
 *
 * Ported from apps/api-worker/src/lib/members.ts (W3 legacy-worker
 * phase-out). Pure functions — no Hono context.
 */

import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { masterSchema, type MasterDatabase } from '../db';
import { generateId } from '../lib/id';

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
 * Fetches the real organization membership count from Clerk's API,
 * ensuring accuracy even when webhooks have failed. If the DB count
 * differs from Clerk, syncs userWorkspaces in the background.
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

    const clerkCount = memberships.total_count;

    // If counts match, no sync needed
    if (clerkCount === dbCount) {
      return clerkCount;
    }

    // Counts differ — sync userWorkspaces from Clerk data (fire-and-forget)
    console.warn(
      `[member-count] Member count mismatch for workspace ${workspaceId}: DB=${dbCount}, Clerk=${clerkCount}. Syncing...`,
    );

    syncUserWorkspacesFromClerk(masterDb, workspaceId, dbMembers, memberships.data).catch(
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
