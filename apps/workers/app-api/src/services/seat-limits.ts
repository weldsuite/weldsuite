/**
 * Seat-limit helpers.
 *
 * One place to answer "how many members may this workspace have, and is it
 * full?", shared by the read-only /api/member-limits surface and the invite
 * path that has to refuse when the workspace is already at its cap.
 *
 * Mirrors billing-worker's `calculateEffectiveSeatLimit`, which is what
 * actually gets written to Clerk's `max_allowed_memberships`. Keep the two in
 * step: Clerk is the hard gate, this is the friendly one in front of it.
 *
 * `limit === null` means unlimited.
 */

import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, masterSchema } from '../db';
import { getAccurateMemberCount } from './member-count';

export interface SeatLimit {
  /** Maximum members, or null when the plan is unlimited. */
  limit: number | null;
  /** Live member count from Clerk (guests excluded by the counter). */
  current: number;
  atLimit: boolean;
  planName: string;
}

/** Not found — the caller decides whether that is a 404 or a pass-through. */
export async function getWorkspaceSeatLimit(
  env: Env,
  orgId: string,
): Promise<SeatLimit | null> {
  const masterDb = getMasterDb(env);
  const { workspaces, plans } = masterSchema;

  const [workspace] = await masterDb
    .select({
      id: workspaces.id,
      planId: workspaces.planId,
      purchasedSeats: workspaces.purchasedSeats,
    })
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId));

  if (!workspace) return null;

  let limit: number | null = null;
  let planName = 'Free';

  if (workspace.planId) {
    const [plan] = await masterDb
      .select({
        name: plans.name,
        maxUsers: plans.maxUsers,
        pricePerUser: plans.pricePerUser,
        includedUsers: plans.includedUsers,
      })
      .from(plans)
      .where(eq(plans.id, workspace.planId));

    if (plan) {
      planName = plan.name;

      // A hard cap wins (Free = 1, Business = 10). Otherwise a per-seat plan
      // is limited by what it has paid for. A plan with neither is unlimited.
      if (plan.maxUsers != null && plan.maxUsers > 0) {
        limit = plan.maxUsers;
      } else {
        const pricePerUser = plan.pricePerUser ? parseFloat(plan.pricePerUser) : 0;
        if (pricePerUser > 0) {
          limit = (plan.includedUsers ?? 1) + (workspace.purchasedSeats ?? 0);
        }
      }
    }
  }

  const current = await getAccurateMemberCount(env, orgId, workspace.id, masterDb);

  return {
    limit,
    current,
    atLimit: limit !== null && current >= limit,
    planName,
  };
}
