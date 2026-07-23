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
import { masterSchema, type MasterDatabase } from '../db';

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
  const pricePerUser = plan.pricePerUser ? parseFloat(plan.pricePerUser) : 0;
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
        `[Clerk Sync] Failed to update max_allowed_memberships for ${clerkOrgId}: ${res.status} ${text}`,
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
// ============================================================================

export interface EnterpriseInquiry {
  companyName: string;
  contactName: string;
  contactEmail: string;
  teamSize: string;
  useCase?: string;
  source?: string;
}

export interface EnterpriseInquiryContext {
  /** Clerk org id the inquiry was sent from. */
  orgId: string;
  /** Clerk user id of the submitter — the authenticated identity, not form input. */
  userId: string;
  /** Internal workspace id, when resolvable. */
  workspaceId?: string | null;
  /** Current plan slug, for sales triage. */
  planSlug?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the sales-facing notification for an enterprise inquiry.
 *
 * Every interpolated value is escaped: `useCase` / `companyName` etc. are
 * free-text fields straight from an authenticated-but-untrusted form, and this
 * HTML is rendered in a sales inbox.
 *
 * The workspace/user identifiers come from the request context (Clerk), NOT
 * from the form body — a submitter must not be able to spoof which workspace
 * an inquiry appears to originate from.
 */
export function renderEnterpriseInquiryEmail(
  inquiry: EnterpriseInquiry,
  ctx: EnterpriseInquiryContext,
): { subject: string; html: string; text: string } {
  const subject = `Enterprise inquiry — ${inquiry.companyName} (${inquiry.teamSize})`;

  const rows: Array<[string, string]> = [
    ['Company', inquiry.companyName],
    ['Team size', inquiry.teamSize],
    ['Contact', inquiry.contactName],
    ['Email', inquiry.contactEmail],
    ['Use case', inquiry.useCase?.trim() || '—'],
    ['Source', inquiry.source || 'unknown'],
    ['Workspace', ctx.workspaceId || '—'],
    ['Clerk org', ctx.orgId],
    ['Clerk user', ctx.userId],
    ['Current plan', ctx.planSlug || '—'],
  ];

  const html = [
    '<h2>New enterprise inquiry</h2>',
    '<table cellpadding="6" style="border-collapse:collapse">',
    ...rows.map(
      ([label, value]) =>
        `<tr><td style="border:1px solid #ddd"><strong>${escapeHtml(label)}</strong></td>` +
        `<td style="border:1px solid #ddd">${escapeHtml(value)}</td></tr>`,
    ),
    '</table>',
  ].join('');

  const text = rows.map(([label, value]) => `${label}: ${value}`).join('\n');

  return { subject, html, text };
}

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
