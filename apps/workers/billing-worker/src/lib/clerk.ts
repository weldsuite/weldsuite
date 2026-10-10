/**
 * Clerk seat-limit helpers for billing-worker.
 *
 * Keeps Clerk's `max_allowed_memberships` in sync with the effective seat
 * limit derived from the workspace plan + purchased seats.
 */

import { eq } from 'drizzle-orm';
import { managedSeatCap } from '@weldsuite/core-domain/partners';
import type { Env } from '../index';
import { type getMasterDb, masterSchema } from './db';
import { logSafe } from '@weldsuite/text';

const { userWorkspaces } = masterSchema;

// ============================================================================
// Calculate effective seat limit
// ============================================================================

/**
 * Computes the number that should be written to Clerk's `max_allowed_memberships`.
 *
 * Rules:
 *  1. If the plan has a hard cap (`maxUsers`), that wins.
 *  2. If the plan charges per-user (`pricePerUser > 0`), the limit is
 *     `includedUsers + purchasedSeats` — but never below `activeMemberCount`
 *     so existing members aren't locked out.
 *  3. Otherwise return 0, which means "unlimited" in Clerk (we'll pass 0 to
 *     Clerk, which removes the limit).
 *
 * A partner-managed workspace ignores the plan: its limit is the licence's
 * `maxSeats` (null = unlimited = 0). Pass `managed` for those.
 */
export function calculateEffectiveSeatLimit(
  plan: {
    maxUsers: number | null;
    pricePerUser: string | null;
    includedUsers: number | null;
  } | null,
  purchasedSeats: number,
  activeMemberCount: number,
  managed?: { maxSeats: number | null },
): number {
  if (managed) return managed.maxSeats != null && managed.maxSeats > 0 ? managed.maxSeats : 0;
  if (!plan) return 0;

  // Hard cap takes precedence
  if (plan.maxUsers != null && plan.maxUsers > 0) {
    return plan.maxUsers;
  }

  // Per-user pricing → dynamic limit
  const pricePerUser = plan.pricePerUser ? Number.parseFloat(plan.pricePerUser) : 0;
  if (pricePerUser > 0) {
    const includedUsers = plan.includedUsers ?? 1;
    const prepaid = includedUsers + purchasedSeats;
    return Math.max(prepaid, activeMemberCount);
  }

  // No limit (free/unlimited plan without per-user pricing)
  return 0;
}

// ============================================================================
// Sync limit to Clerk
// ============================================================================

/**
 * PATCHes the Clerk organization's `max_allowed_memberships`.
 * Fire-and-forget — errors are logged, never thrown.
 *
 * When `effectiveLimit` is 0 we send `null` to Clerk, which removes the cap.
 */
export async function syncClerkSeatLimit(
  clerkSecretKey: string,
  clerkOrgId: string,
  effectiveLimit: number,
): Promise<void> {
  try {
    const body = JSON.stringify({
      max_allowed_memberships: effectiveLimit > 0 ? effectiveLimit : null,
    });

    const res = await fetch(
      `https://api.clerk.com/v1/organizations/${clerkOrgId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${clerkSecretKey}`,
          'Content-Type': 'application/json',
        },
        body,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[Clerk Sync] Failed to update max_allowed_memberships for ${logSafe(clerkOrgId)}: ${res.status} ${logSafe(text)}`,
      );
    } else {
      console.log(
        `[Clerk Sync] Set max_allowed_memberships=${effectiveLimit || 'null'} for org ${clerkOrgId}`,
      );
    }
  } catch (err) {
    console.error('[Clerk Sync] Error syncing seat limit to Clerk:', err);
  }
}

export type SeatPlan = Parameters<typeof calculateEffectiveSeatLimit>[0];

/** Recompute the workspace's effective seat limit and push it to Clerk. */
export async function applyClerkSeatLimit(
  env: Env,
  clerkSecretKey: string,
  masterDb: ReturnType<typeof getMasterDb>,
  clerkOrgId: string,
  workspaceId: string,
  plan: SeatPlan | null,
  seats: number,
): Promise<void> {
  const cap = await managedSeatCap(masterDb, workspaceId);
  if (cap.managed) {
    // Partner workspace: the licence decides, not the plan or purchased seats.
    await syncClerkSeatLimit(clerkSecretKey, clerkOrgId, calculateEffectiveSeatLimit(null, 0, 0, cap));
    return;
  }
  if (!plan) return;
  const memberCount = await getMemberCount(env, masterDb, clerkOrgId, workspaceId);
  const effectiveLimit = calculateEffectiveSeatLimit(plan, seats, memberCount);
  await syncClerkSeatLimit(clerkSecretKey, clerkOrgId, effectiveLimit);
}

/**
 * Best-effort Clerk seat-limit sync for an already-resolved plan. Never throws.
 * Partner-managed workspaces use the licence's seat cap and need no plan.
 */
export async function trySyncClerkSeatLimit(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  clerkOrgId: string | null,
  workspaceId: string,
  plan: SeatPlan | null | undefined,
  seats: number,
  context: string,
): Promise<void> {
  if (!clerkOrgId || !env.CLERK_SECRET_KEY) return;
  try {
    await applyClerkSeatLimit(env, env.CLERK_SECRET_KEY, masterDb, clerkOrgId, workspaceId, plan ?? null, seats);
  } catch (err) {
    console.error(`[Clerk Sync] Failed to sync seat limit after ${context}:`, err);
  }
}

// ============================================================================
// Get member count
// ============================================================================

/**
 * Returns the BILLABLE member count for a Clerk organization. EXTERNAL_GUEST
 * members are excluded — they're free.
 *
 * Source of truth is the Clerk memberships list, filtered by the
 * `public_metadata.member_type` tag we set when adding a guest. The fallback
 * (master DB) cannot distinguish guests yet (the `user_workspaces` master
 * table has no memberType column), so it returns the total — slight
 * over-count under DB-only fallback, but better than blocking billing.
 */
export async function getMemberCount(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  clerkOrgId: string,
  workspaceId: string,
): Promise<number> {
  // Paginate Clerk memberships and filter out guests. limit=100 is the
  // maximum Clerk allows; for workspaces with >100 members we paginate.
  try {
    let billable = 0;
    let offset = 0;
    const pageSize = 100;
    let total = Infinity;

    while (offset < total) {
      const res = await fetch(
        `https://api.clerk.com/v1/organizations/${clerkOrgId}/memberships?limit=${pageSize}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } },
      );
      if (!res.ok) {
        throw new Error(`Clerk memberships API ${res.status}`);
      }
      const page = (await res.json()) as {
        data: Array<{ public_metadata?: Record<string, unknown> | null }>;
        total_count: number;
      };
      total = page.total_count;
      for (const m of page.data ?? []) {
        const metaType = (m.public_metadata as { member_type?: string } | null)?.member_type;
        if (metaType !== 'EXTERNAL_GUEST') billable += 1;
      }
      if (!page.data || page.data.length < pageSize) break;
      offset += pageSize;
    }

    return billable;
  } catch (err) {
    console.warn('[Clerk Sync] Failed to fetch billable member count from Clerk, falling back to DB:', err);
  }

  // Fallback: count from master DB. NOTE: master `user_workspaces` does not
  // currently track memberType, so this over-counts when guests exist.
  // Acceptable for a fallback-only path; primary path is the Clerk API
  // above which DOES filter guests correctly.
  const rows = await masterDb
    .select({ id: userWorkspaces.id, status: userWorkspaces.status })
    .from(userWorkspaces)
    .where(eq(userWorkspaces.workspaceId, workspaceId));

  return rows.filter(r => r.status === 'ACTIVE' || r.status === 'PENDING').length;
}
