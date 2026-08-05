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
import type { CreditTopupCheckoutInput } from '@weldsuite/app-api-client/schemas/credits';
import { eq } from 'drizzle-orm';
import { masterSchema } from '../db';
import type { Env } from '../types';
import { fetchBillingWorker } from '../lib/billing-worker';

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

// ============================================================================
// Billing-worker proxy (prepaid credit topup Checkout)
// ============================================================================

export type CreditCheckoutProxyFailure =
  | { kind: 'bad_request'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'upstream'; message: string };

export type CreditCheckoutProxyResult =
  | { ok: true; url: string }
  | { ok: false; error: CreditCheckoutProxyFailure };

/**
 * Create a Stripe Checkout session for a prepaid credit package via
 * billing-worker. Credits are granted by the webhook after payment — this
 * only returns the hosted Checkout URL.
 */
export async function createCreditTopupCheckout(params: {
  env: Pick<Env, 'ENVIRONMENT'>;
  authorization?: string | null;
  body: CreditTopupCheckoutInput;
  fetchImpl?: typeof fetch;
}): Promise<CreditCheckoutProxyResult> {
  try {
    const resp = await fetchBillingWorker(params.env, '/api/billing/credits/checkout', {
      method: 'POST',
      authorization: params.authorization,
      body: params.body,
      fetchImpl: params.fetchImpl,
    });
    const payload = (await resp.json().catch(() => null)) as Record<string, unknown> | null;

    if (!resp.ok) {
      const message =
        (payload && typeof payload.error === 'string' && payload.error) ||
        'Failed to start credit checkout';
      if (resp.status === 400) return { ok: false, error: { kind: 'bad_request', message } };
      if (resp.status === 404) return { ok: false, error: { kind: 'not_found', message } };
      return { ok: false, error: { kind: 'upstream', message } };
    }

    const url = payload && typeof payload.url === 'string' ? payload.url : null;
    if (!url) {
      return {
        ok: false,
        error: { kind: 'upstream', message: 'Billing worker returned no checkout URL' },
      };
    }

    return { ok: true, url };
  } catch (err) {
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError');
    const message = aborted
      ? 'Billing worker timed out'
      : err instanceof Error
        ? err.message
        : 'Failed to start credit checkout';
    return { ok: false, error: { kind: 'upstream', message } };
  }
}

