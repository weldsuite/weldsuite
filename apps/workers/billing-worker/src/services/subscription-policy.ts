/**
 * What a workspace's plan does when its billing changes underneath it.
 *
 * Shared by the Stripe webhooks (routes/webhooks.ts), the admin billing API
 * (services/admin-billing.ts) and the comp sweep (services/comp-sweep.ts), so
 * "the subscription ended" means the same thing whether Stripe, an admin or an
 * expiring comp caused it.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '../index';
import { type getMasterDb, masterSchema } from '../lib/db';
import { createStripeSubscription } from '../lib/stripe';
import { syncClerkSeatLimit } from '../lib/clerk';
import { updateSubscriptionCredits } from './credits';
import { logSafe } from '@weldsuite/text';

const { workspaces, plans } = masterSchema;

type MasterDb = ReturnType<typeof getMasterDb>;
type WorkspaceRow = typeof workspaces.$inferSelect;

// "Trial ended → add payment or workspace is deleted" policy grace period.
// Applies only to workspaces.paidPlanRequired === true (new signups; existing
// workspaces are grandfathered onto the free-downgrade path). See
// applySubscriptionEnded below and workspace-worker's deletion-sweep cron.
export const GRACE_PERIOD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Convert a Stripe unix-seconds timestamp to a Date (null when absent). */
export function unixToDate(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

/**
 * True while an admin-granted comp plan is in force. A comp with no end date
 * runs until an admin ends it; the comp sweep ends dated ones.
 */
export function isCompActive(
  workspace: { compGrantedAt: Date | null; compEndsAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!workspace.compGrantedAt) return false;
  return workspace.compEndsAt == null || workspace.compEndsAt.getTime() > now.getTime();
}

/** Match a plan by monthly/yearly Stripe price ID, falling back to the Stripe product ID. */
export async function findPlanForStripePrice(
  masterDb: MasterDb,
  priceId: string,
  productId: string | undefined,
): Promise<typeof plans.$inferSelect | undefined> {
  const [plan] = await masterDb
    .select()
    .from(plans)
    .where(and(
      eq(plans.stripePriceIdMonthly, priceId),
      isNull(plans.deletedAt)
    ));

  const [yearlyPlan] = plan ? [] : await masterDb
    .select()
    .from(plans)
    .where(and(
      eq(plans.stripePriceIdYearly, priceId),
      isNull(plans.deletedAt)
    ));

  const matchedPlan = plan || yearlyPlan;
  if (matchedPlan || !productId) return matchedPlan;

  // Fallback: find plan by Stripe product ID (handles new price IDs created by
  // Stripe, and subscribers left on a price the admin console has archived)
  const [productPlan] = await masterDb
    .select()
    .from(plans)
    .where(and(
      eq(plans.stripeProductId, productId),
      isNull(plans.deletedAt)
    ));

  if (productPlan) {
    console.log(`[Billing] Matched plan ${productPlan.name} by product ID ${productId} (price ID ${priceId} not found)`);
  }
  return productPlan;
}

/** Point the workspace's monthly credit allocation at a plan's credits. */
export async function syncSubscriptionCredits(
  _env: Env,
  masterDb: MasterDb,
  workspaceId: string,
  _clerkOrgId: string,
  planId: string,
) {
  try {
    const [plan] = await masterDb
      .select()
      .from(plans)
      .where(eq(plans.id, planId));

    if (!plan) {
      console.error('[Billing] Plan not found for credits sync:', planId);
      return;
    }

    const planCredits = plan.monthlyCredits || 0;

    await updateSubscriptionCredits(masterDb, workspaceId, {
      planCredits,
      subscribedCredits: 0,
    });

    console.log(`[Billing] Credits synced for workspace ${workspaceId}`);
  } catch (error) {
    console.error('[Billing] Error syncing credits:', error);
  }
}

export async function resetCreditsToFreeTier(
  _env: Env,
  masterDb: MasterDb,
  workspaceId: string,
  _clerkOrgId: string,
) {
  try {
    const [freePlan] = await masterDb
      .select()
      .from(plans)
      .where(and(eq(plans.slug, 'free'), isNull(plans.deletedAt)));

    const freeCredits = freePlan?.monthlyCredits || 0;

    await updateSubscriptionCredits(masterDb, workspaceId, {
      planCredits: freeCredits,
      subscribedCredits: 0,
    });

    console.log(`[Billing] Credits reset to free tier for workspace ${workspaceId}`);
  } catch (error) {
    console.error('[Billing] Error resetting credits:', error);
  }
}

export type SubscriptionEndedOutcome = 'skipped_inactive' | 'grace_period' | 'downgraded_to_free';

/**
 * The workspace no longer has a paid plan subscription (it was cancelled, or a
 * comp ran out). Callers have already decided the plan subscription is gone;
 * this applies the policy:
 *
 *  - `paidPlanRequired` (new signups): no free plan. Start (or keep) the 30-day
 *    "add payment or be deleted" grace period; workspace-worker's deletion
 *    sweep tears the workspace down once `scheduledDeletionAt` passes.
 *  - Grandfathered workspaces: downgrade to the free plan, reset credits and
 *    the Clerk seat cap, and start a $0 free subscription so `invoice.paid`
 *    keeps renewing their monthly credits.
 */
export async function applySubscriptionEnded(
  env: Env,
  masterDb: MasterDb,
  workspace: WorkspaceRow,
): Promise<SubscriptionEndedOutcome> {
  if (workspace.paidPlanRequired) {
    if (!workspace.isActive) {
      console.log(`[Billing] Workspace ${workspace.id} is already inactive, skipping deletion scheduling`);
      return 'skipped_inactive';
    }

    // Idempotent: if a grace period is already running (e.g. a duplicate/
    // retried webhook, or subscription.updated already handled it), don't
    // push the deletion date out further.
    const trialExpiredAt = workspace.trialExpiredAt ?? new Date();
    const scheduledDeletionAt =
      workspace.scheduledDeletionAt ??
      new Date(trialExpiredAt.getTime() + GRACE_PERIOD_DAYS * DAY_MS);

    await masterDb
      .update(workspaces)
      .set({
        subscriptionStatus: 'canceled',
        stripeSubscriptionId: null,
        subscriptionCancelAtPeriodEnd: false,
        trialExpiredAt,
        scheduledDeletionAt,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspace.id));

    console.log(
      `[Billing] Workspace ${workspace.id} has no active paid subscription — scheduled for deletion at ${scheduledDeletionAt.toISOString()}`,
    );
    return 'grace_period';
  }

  // Grandfathered workspace (paidPlanRequired === false) — keep the existing
  // free-plan downgrade behavior.
  const [freePlan] = await masterDb
    .select()
    .from(plans)
    .where(and(
      eq(plans.slug, 'free'),
      isNull(plans.deletedAt)
    ));

  // Downgrade to free plan, reset purchased seats, clear subscription state
  await masterDb
    .update(workspaces)
    .set({
      planId: freePlan?.id || null,
      stripeSubscriptionId: null,
      purchasedSeats: 0,
      subscriptionStatus: 'canceled',
      subscriptionCycle: null,
      subscriptionCurrentPeriodStart: null,
      subscriptionCurrentPeriodEnd: null,
      subscriptionCancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspace.id));

  console.log(`[Billing] Downgraded workspace ${workspace.id} to free plan`);

  // Reset credits to free tier
  if (workspace.clerkOrgId) {
    await resetCreditsToFreeTier(env, masterDb, workspace.id, workspace.clerkOrgId);
  }

  // Sync seat limit to Clerk (free plan's maxUsers, purchasedSeats = 0)
  if (workspace.clerkOrgId && env.CLERK_SECRET_KEY && freePlan) {
    try {
      const effectiveLimit = freePlan.maxUsers ?? 0;
      await syncClerkSeatLimit(env.CLERK_SECRET_KEY, workspace.clerkOrgId, effectiveLimit);
    } catch (err) {
      console.error('[Billing] Failed to sync Clerk seat limit after downgrade:', err);
    }
  }

  // Create a new $0 free subscription so invoice.paid continues firing
  if (freePlan?.stripePriceIdMonthly && workspace.stripeCustomerId && env.STRIPE_SECRET_KEY) {
    try {
      const newSubscription = await createStripeSubscription(env.STRIPE_SECRET_KEY, {
        customerId: workspace.stripeCustomerId,
        priceId: freePlan.stripePriceIdMonthly,
        metadata: {
          workspaceId: workspace.id,
          planId: freePlan.id,
        },
      });

      await masterDb
        .update(workspaces)
        .set({
          stripeSubscriptionId: newSubscription.id,
          subscriptionStatus: 'active',
          subscriptionCycle: 'monthly',
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspace.id));

      console.log(`[Billing] Created new free subscription ${logSafe(newSubscription.id)} for workspace ${logSafe(workspace.id)}`);
    } catch (subError) {
      console.error('[Billing] Failed to create free subscription after downgrade:', subError);
    }
  }

  return 'downgraded_to_free';
}

/**
 * The plan subscription ended while a comp is in force: forget the Stripe
 * subscription but keep the comped plan and seats. `subscriptionStatus` goes
 * back to null so the platform reads the workspace as active, not cancelled.
 */
export async function detachEndedSubscriptionFromComp(
  masterDb: MasterDb,
  workspaceId: string,
): Promise<void> {
  await masterDb
    .update(workspaces)
    .set({
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      subscriptionCycle: null,
      subscriptionCurrentPeriodStart: null,
      subscriptionCurrentPeriodEnd: null,
      subscriptionCancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
}
