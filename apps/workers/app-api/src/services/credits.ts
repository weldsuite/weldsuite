/**
 * Credits service — subscription-plan allocation over the prepaid wallet.
 *
 * The balance itself is a PREPAID WALLET (see @weldsuite/credits): topups
 * persist indefinitely and are NEVER overwritten by allocation logic. A plan
 * with monthly credits grants them ON TOP of the remaining balance each
 * billing cycle; base-fee-only plans (allocation 0) leave the wallet alone.
 *
 * All credit/usage data lives in the master database, scoped by the internal
 * `workspaceId`. Both the HTTP credits routes and billing webhooks call these.
 */

import { grantCredits, getOrCreateWorkspaceCredits, type CreditsDb } from '@weldsuite/credits';
import { eq } from 'drizzle-orm';
import { masterSchema } from '../db';

const { workspaceCredits } = masterSchema;

export { getOrCreateWorkspaceCredits };

/**
 * Update subscription credits allocation. Called when a subscription is
 * created, changed, or renewed.
 * - Mid-period upgrade: the allocation increase is granted immediately.
 * - Period renewal (`resetPeriod`): the monthly allocation is granted
 *   additively, idempotent on (workspace, periodStart) against replays.
 * - The wallet balance is never reduced here — prepaid credits survive
 *   renewals, downgrades, and cancellations.
 */
export async function updateSubscriptionCredits(
  db: CreditsDb,
  workspaceId: string,
  params: {
    planCredits: number;
    subscribedCredits: number;
    stripeCreditsItemId?: string;
    stripeCreditsPriceId?: string;
    periodStart?: string;
    periodEnd?: string;
    resetPeriod?: boolean;
  },
) {
  const {
    planCredits,
    subscribedCredits,
    stripeCreditsItemId,
    stripeCreditsPriceId,
    periodStart,
    periodEnd,
    resetPeriod,
  } = params;

  const newMonthlyAllocation = planCredits + subscribedCredits;

  const credits = await getOrCreateWorkspaceCredits(db, workspaceId);
  const previousAllocation = credits.monthlyAllocation;
  const allocationDiff = newMonthlyAllocation - previousAllocation;

  const updateData: Record<string, unknown> = {
    planCredits,
    subscribedCredits,
    monthlyAllocation: newMonthlyAllocation,
    updatedAt: new Date(),
  };
  if (stripeCreditsItemId !== undefined) updateData.stripeCreditsItemId = stripeCreditsItemId;
  if (stripeCreditsPriceId !== undefined) updateData.stripeCreditsPriceId = stripeCreditsPriceId;
  if (periodStart) updateData.periodStart = new Date(periodStart);
  if (periodEnd) updateData.periodEnd = new Date(periodEnd);
  if (resetPeriod) updateData.lastResetAt = new Date();

  await db.update(workspaceCredits).set(updateData).where(eq(workspaceCredits.workspaceId, workspaceId));

  // Additive grants only — never a wipe.
  let granted = 0;
  let newBalance = credits.currentBalance;

  if (resetPeriod && newMonthlyAllocation > 0) {
    const grant = await grantCredits(db, {
      workspaceId,
      amount: newMonthlyAllocation,
      type: 'monthly_allocation',
      idempotencyKey: periodStart ? `monthly_grant:${workspaceId}:${periodStart}` : undefined,
      description: `Monthly plan credits: +${newMonthlyAllocation}`,
      metadata: { reason: 'period_renewal', planCredits, subscribedCredits, periodStart, periodEnd },
    });
    if (!grant.duplicate) granted = newMonthlyAllocation;
    newBalance = grant.newBalance;
  } else if (!resetPeriod && allocationDiff > 0) {
    const grant = await grantCredits(db, {
      workspaceId,
      amount: allocationDiff,
      type: 'adjustment',
      description: `Subscription credits increased by ${allocationDiff}`,
      metadata: {
        reason: 'subscription_change',
        previousAllocation,
        newAllocation: newMonthlyAllocation,
        planCredits,
        subscribedCredits,
      },
    });
    granted = allocationDiff;
    newBalance = grant.newBalance;
  }

  return {
    planCredits,
    subscribedCredits,
    monthlyAllocation: newMonthlyAllocation,
    currentBalance: newBalance,
    allocationChange: granted,
    periodReset: resetPeriod || false,
  };
}
