/**
 * Billing service helpers — ported from api-worker (`src/lib/clerk.ts` and the
 * mapping logic inside `src/routes/billing.ts`).
 *
 * Pure functions, no Hono context. All billing state lives in the MASTER
 * database (workspaces / plans / billingInvoices / billingPayments /
 * workspaceUsage / workspaceCredits), keyed by the internal workspace id.
 *
 * Seat truth is reconciled against Clerk (source of truth for memberships) by
 * `getAccurateMemberCount` — that lives in ./member-count and is re-exported
 * here so the billing routes and /api/member-limits + /api/prepaid-seats all
 * share ONE implementation. Do not re-inline a copy: it mutates the master DB
 * (inserts users/userWorkspaces, deletes stale rows) and drives the seat
 * guards on the checkout/seats money paths.
 */

import { eq } from 'drizzle-orm';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { fetchBillingWorker } from '@weldsuite/worker-kit/billing-worker';
import { logSafe } from '@weldsuite/worker-kit/log-safe';

export { getAccurateMemberCount, syncUserWorkspacesFromClerk } from './member-count';
export type { ClerkMembershipListItem } from './member-count';

type Workspace = typeof masterSchema.workspaces.$inferSelect;
type Plan = typeof masterSchema.plans.$inferSelect;

// ============================================================================
// Effective seat limit + Clerk sync (ported from api-worker lib/clerk.ts)
// ============================================================================

/**
 * Computes the number that should be written to Clerk's
 * `max_allowed_memberships`.
 *
 * Rules:
 *  1. If the plan has a hard cap (`maxUsers`), that wins.
 *  2. If the plan charges per-user (`pricePerUser > 0`), the limit is
 *     `includedUsers + purchasedSeats` — but never below `activeMemberCount`
 *     so existing members aren't locked out.
 *  3. Otherwise return 0, which means "unlimited" in Clerk.
 */
export function calculateEffectiveSeatLimit(
  plan: {
    maxUsers: number | null;
    pricePerUser: string | null;
    includedUsers: number | null;
  },
  purchasedSeats: number,
  activeMemberCount: number,
): number {
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

    const res = await fetch(`https://api.clerk.com/v1/organizations/${clerkOrgId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${clerkSecretKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[Clerk Sync] Failed to update max_allowed_memberships for ${logSafe(clerkOrgId)}: ${res.status} ${logSafe(text)}`,
      );
    }
  } catch (err) {
    console.error('[Clerk Sync] Error syncing seat limit to Clerk:', err);
  }
}

// ============================================================================
// Master-DB lookups + mappers shared by the billing routes
// ============================================================================

/** Load the workspace row for a Clerk org id (billing state lives in master). */
export async function getWorkspaceByOrgId(
  masterDb: MasterDatabase,
  clerkOrgId: string,
): Promise<Workspace | undefined> {
  const [workspace] = await masterDb
    .select()
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);
  return workspace;
}

/** Load a plan row by id, or null when unset/missing. */
export async function getPlanById(
  masterDb: MasterDatabase,
  planId: string | null,
): Promise<Plan | null> {
  if (!planId) return null;
  const [plan] = await masterDb
    .select()
    .from(masterSchema.plans)
    .where(eq(masterSchema.plans.id, planId))
    .limit(1);
  return plan ?? null;
}

// ============================================================================
// Enterprise sales inquiry
//
// Rendering moved to @weldsuite/emails ('internal.enterprise-inquiry',
// sent via sendSystemEmail in routes/billing/index.ts). Nothing here anymore:
// the route builds the template props directly from the validated request
// body and the Clerk-resolved context.
// ============================================================================

/**
 * Subscription payload — identical field set to api-worker's
 * `GET /api/billing/subscription` response (also embedded in /plans-page).
 */
export function mapSubscription(workspace: Workspace, plan: Plan | null, usedSeats: number) {
  return {
    id: workspace.id,
    planId: plan?.id || null,
    planName: plan?.name || 'Free',
    planSlug: plan?.slug || 'free',
    status: workspace.subscriptionStatus || (workspace.isActive ? 'active' : 'canceled'),
    cycle: workspace.subscriptionCycle || 'monthly',
    purchasedSeats: workspace.purchasedSeats || 0,
    usedSeats,
    currentPeriodStart: workspace.subscriptionCurrentPeriodStart?.toISOString() || null,
    currentPeriodEnd: workspace.subscriptionCurrentPeriodEnd?.toISOString() || null,
    cancelAtPeriodEnd: workspace.subscriptionCancelAtPeriodEnd || false,
    stripeCustomerId: workspace.stripeCustomerId,
    stripeSubscriptionId: workspace.stripeSubscriptionId,
    // Pay-or-delete policy state (trial ended → add payment or workspace is
    // torn down after the 30-day grace window). A workspace is "locked" once
    // `scheduledDeletionAt` is stamped: the platform UI shows the paywall and
    // the billing-worker's deletion sweep is armed. These clear on checkout.
    paidPlanRequired: workspace.paidPlanRequired ?? false,
    trialExpiredAt: workspace.trialExpiredAt?.toISOString() || null,
    scheduledDeletionAt: workspace.scheduledDeletionAt?.toISOString() || null,
    isLocked: workspace.scheduledDeletionAt != null,
  };
}

// ============================================================================
// Billing-worker proxies (phone subscription pricing)
// ============================================================================

/** Discriminated result from a billing-worker proxy call. */
export type BillingWorkerProxyFailure =
  | { kind: 'bad_request'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'upstream'; message: string };

export type PhoneSubscriptionProxyResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: BillingWorkerProxyFailure };

function upstreamErrorMessage(
  body: Record<string, unknown> | null,
  fallback: string,
): string {
  return (body && typeof body.error === 'string' && body.error) || fallback;
}

/**
 * Fetch Stripe phone-line subscription pricing from billing-worker.
 * Pure of Hono — callers pass env + Authorization and map the result to HTTP.
 *
 * Upstream 5xx / network / timeout → `{ ok: false, error: { kind: 'upstream' } }`
 * (never `{ exists: false }`, which would falsely claim "no subscription").
 */
export async function fetchPhoneSubscription(params: {
  env: Pick<Env, 'ENVIRONMENT'>;
  authorization?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<PhoneSubscriptionProxyResult> {
  try {
    const resp = await fetchBillingWorker(params.env, '/api/billing/phone/subscription', {
      method: 'GET',
      authorization: params.authorization,
      fetchImpl: params.fetchImpl,
    });
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;

    if (!resp.ok) {
      const message = upstreamErrorMessage(body, 'Failed to fetch phone subscription');
      if (resp.status === 400) return { ok: false, error: { kind: 'bad_request', message } };
      if (resp.status === 404) return { ok: false, error: { kind: 'not_found', message } };
      return { ok: false, error: { kind: 'upstream', message } };
    }

    return { ok: true, data: body ?? { exists: false } };
  } catch (err) {
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError');
    let message = 'Failed to fetch phone subscription';
    if (aborted) message = 'Billing worker timed out';
    else if (err instanceof Error) message = err.message;
    return { ok: false, error: { kind: 'upstream', message } };
  }
}

