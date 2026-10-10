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
 *
 * A partner-managed workspace ignores its plan: its limit is the licence's
 * `maxSeats` (null = unlimited), the same number billing-worker writes to Clerk
 * (docs/plans/reseller-licensing.md).
 */

import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, masterSchema } from '@weldsuite/worker-kit/db';
import { getAccurateMemberCount } from './member-count';
import { countPendingSeatInvitations } from './clerk-seat-cap';

export interface SeatLimit {
  /** Maximum members, or null when the plan is unlimited. */
  limit: number | null;
  /**
   * Seats in use: the live member count from Clerk plus the pending
   * invitations that will take a seat once accepted. Clerk counts both
   * against its cap, so leaving the invitations out offers seats it refuses.
   */
  current: number;
  atLimit: boolean;
  planName: string;
  /** Set for a partner-managed workspace: the partner whose licence sets the limit. */
  managedBy?: string;
}

/**
 * A hard cap wins (Free = 1, Business = 10). Otherwise a per-seat plan is
 * limited by what it has paid for. A plan with neither is unlimited (null).
 */
function planSeatLimit(
  plan: { maxUsers: number | null; pricePerUser: string | null; includedUsers: number | null },
  purchasedSeats: number | null,
): number | null {
  if (plan.maxUsers != null && plan.maxUsers > 0) return plan.maxUsers;
  const pricePerUser = plan.pricePerUser ? Number.parseFloat(plan.pricePerUser) : 0;
  if (pricePerUser > 0) return (plan.includedUsers ?? 1) + (purchasedSeats ?? 0);
  return null;
}

/** Not found — the caller decides whether that is a 404 or a pass-through. */
export async function getWorkspaceSeatLimit(
  env: Env,
  orgId: string,
): Promise<SeatLimit | null> {
  const masterDb = getMasterDb(env);
  const { workspaces, plans, workspaceLicences, partners } = masterSchema;

  const [workspace] = await masterDb
    .select({
      id: workspaces.id,
      planId: workspaces.planId,
      purchasedSeats: workspaces.purchasedSeats,
      billingMode: workspaces.billingMode,
      partnerId: workspaces.partnerId,
    })
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId));

  if (!workspace) return null;

  let limit: number | null = null;
  let planName = 'Free';
  let managedBy: string | undefined;

  if (workspace.billingMode === 'partner') {
    const [licence] = await masterDb
      .select({ maxSeats: workspaceLicences.maxSeats })
      .from(workspaceLicences)
      .where(eq(workspaceLicences.workspaceId, workspace.id));
    limit = licence?.maxSeats ?? null;
    planName = 'Licence';
    if (workspace.partnerId) {
      const [partner] = await masterDb
        .select({ name: partners.name })
        .from(partners)
        .where(eq(partners.id, workspace.partnerId));
      managedBy = partner?.name;
    }
  } else if (workspace.planId) {
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
      limit = planSeatLimit(plan, workspace.purchasedSeats);
    }
  }

  const [members, pendingInvitations] = await Promise.all([
    getAccurateMemberCount(env, orgId, workspace.id, masterDb),
    countPendingSeatInvitations(env, orgId),
  ]);
  const current = members + (pendingInvitations ?? 0);

  return {
    limit,
    current,
    atLimit: limit !== null && current >= limit,
    planName,
    ...(managedBy ? { managedBy } : {}),
  };
}
