/**
 * Scheduled-Deletion Sweep
 *
 * Enforcement side of the "add payment or your workspace is deleted in 30
 * days" policy (see `workspaces.paidPlanRequired` / `trialExpiredAt` /
 * `scheduledDeletionAt` in packages/core/db/src/schema/master.ts). The
 * billing-worker webhook handler (`handleSubscriptionDeleted` in
 * apps/workers/billing-worker/src/routes/webhooks.ts) stamps a workspace with
 * `scheduledDeletionAt` when its trial/subscription ends without an active
 * paid subscription; this sweep finds workspaces whose grace period has
 * elapsed and tears them down.
 *
 * Teardown reuses the EXISTING Clerk-org-deletion cascade: deleting the Clerk
 * organization fires `organization.deleted`, which `handleOrganizationDeleted`
 * (routes/webhooks/clerk.ts) picks up to set `isActive = false` and call
 * `provisioningService.deleteWorkspaceDatabase(...)`. Beyond triggering the
 * cascade, the sweep stamps `deletedAt` on the workspace to guard against
 * re-processing.
 *
 * Two schedule sources feed this sweep, differing only in whether they suspend
 * the workspace up front:
 *   - Trial-expiry policy (billing webhook): keeps `isActive = true` during the
 *     grace window so the owner can rescue the workspace by adding payment
 *     (which clears `scheduledDeletionAt`).
 *   - Admin console (apps/web/admin): suspends immediately (`isActive = false`)
 *     when an admin schedules deletion, while retaining data for cancellation.
 * Because a suspended workspace is `isActive = false`, the sweep guards on
 * `deletedAt IS NULL` (not `isActive`) so both sources are torn down, and
 * stamps `deletedAt` once teardown is triggered so the next run excludes it.
 * Re-triggering a Clerk org that is already gone is harmless anyway (a 404 is
 * treated as success).
 */

import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { getMasterDb } from '../db';
import type { Env } from '../index';

/** Rows processed per sweep run — keeps a single cron invocation short; the
 *  daily cron fires again tomorrow to pick up anything left over. */
const SWEEP_BATCH_LIMIT = 50;

export interface DeletionSweepResult {
  processed: number;
  succeeded: number;
  failed: number;
}

/**
 * Best-effort cancel of any lingering Stripe subscription before deleting the
 * Clerk org. In the normal flow this is already a no-op: by the time
 * `scheduledDeletionAt` is set, `handleSubscriptionDeleted` has already
 * cleared `stripeSubscriptionId` on the workspace. This only matters if a
 * subscription was reattached out-of-band. Never throws — a failure here must
 * not block the Clerk-org deletion that actually tears the workspace down.
 */
async function cancelLingeringStripeSubscription(env: Env, stripeSubscriptionId: string): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return;
  try {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${btoa(`${env.STRIPE_SECRET_KEY}:`)}`,
      },
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      console.warn(
        `[DeletionSweep] Failed to cancel lingering Stripe subscription ${stripeSubscriptionId}: ${res.status} ${text}`,
      );
    }
  } catch (err) {
    console.warn(`[DeletionSweep] Error canceling Stripe subscription ${stripeSubscriptionId}:`, err);
  }
}

/** Deletes the Clerk organization, which triggers the existing
 *  organization.deleted cascade (see module docstring). Throws on failure so
 *  the caller can count it as a failed workspace in the batch. */
async function deleteClerkOrganization(env: Env, clerkOrgId: string): Promise<void> {
  const res = await fetch(`https://api.clerk.com/v1/organizations/${clerkOrgId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
    },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Clerk organization deletion failed: ${res.status} ${text}`);
  }
}

/**
 * Finds workspaces past their scheduled-deletion date and tears them down.
 * Each workspace is isolated in its own try/catch so one failure never aborts
 * the rest of the batch.
 */
export async function sweepScheduledDeletions(env: Env): Promise<DeletionSweepResult> {
  const masterDb = getMasterDb(env);
  const now = new Date();

  const due = await masterDb
    .select({
      id: workspaces.id,
      clerkOrgId: workspaces.clerkOrgId,
      stripeSubscriptionId: workspaces.stripeSubscriptionId,
      scheduledDeletionAt: workspaces.scheduledDeletionAt,
    })
    .from(workspaces)
    .where(and(
      isNull(workspaces.deletedAt),
      isNotNull(workspaces.scheduledDeletionAt),
      lte(workspaces.scheduledDeletionAt, now),
    ))
    .limit(SWEEP_BATCH_LIMIT);

  if (due.length === 0) {
    console.log('[DeletionSweep] No workspaces due for deletion');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  console.log(`[DeletionSweep] ${due.length} workspace(s) due for deletion`);

  let succeeded = 0;
  let failed = 0;

  for (const workspace of due) {
    if (!workspace.clerkOrgId) {
      console.warn(`[DeletionSweep] Workspace ${workspace.id} has no clerkOrgId, skipping`);
      continue;
    }

    try {
      if (workspace.stripeSubscriptionId) {
        await cancelLingeringStripeSubscription(env, workspace.stripeSubscriptionId);
      }

      await deleteClerkOrganization(env, workspace.clerkOrgId);

      // Stamp deletedAt so this workspace is never re-processed, even if the
      // async organization.deleted cascade hasn't landed by the next sweep.
      await masterDb
        .update(workspaces)
        .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
        .where(eq(workspaces.id, workspace.id));

      console.log(
        `[DeletionSweep] Deleted Clerk org ${workspace.clerkOrgId} for workspace ${workspace.id} ` +
        `(scheduled at ${workspace.scheduledDeletionAt?.toISOString()}) — organization.deleted cascade will finish teardown`,
      );
      succeeded++;
    } catch (error) {
      console.error(`[DeletionSweep] Failed to delete workspace ${workspace.id} (org ${workspace.clerkOrgId}):`, error);
      failed++;
    }
  }

  console.log(`[DeletionSweep] Done: ${succeeded} succeeded, ${failed} failed, ${due.length} processed`);
  return { processed: due.length, succeeded, failed };
}
