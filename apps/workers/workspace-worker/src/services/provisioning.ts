/**
 * Shared Idempotent Provisioning Service
 *
 * Used by both the onboard endpoint and the Clerk webhook handler.
 * Uses async provisioning: creates Neon project + triggers Cloudflare Workflow.
 * The workflow handles schema init, member insertion, billing setup,
 * databaseProvisionedAt, and encrypting/storing the connection URI.
 * Race-safe: UPDATE ... WHERE neon_project_id IS NULL — only one caller wins.
 */

import { eq } from 'drizzle-orm';
import { workspaces, plans, users } from '@weldsuite/db/schema/master';
import {
  createProvisioningService,
  type InitialMember,
} from '@weldsuite/neon-provisioning';
import type { Env } from '../index';
import { MIGRATION_JOURNAL } from '../generated/tenant-migrations';
import { invalidatePoolState } from '../workflows/refill-pool';

export interface ProvisionKickoffResult {
  /** True if the database is provisioned or async provisioning was successfully (re)triggered. */
  ok: boolean;
  /**
   * True when the workspace is ALREADY fully usable when this call returns —
   * a warm pre-migrated pool slot was claimed and personalized inline, so the
   * caller can skip the provisioning wait/polling entirely.
   */
  ready?: boolean;
  error?: string;
}

export async function provisionWorkspaceDatabase(
  env: Env,
  masterDb: any,
  workspaceId: string,
  workspaceName: string,
  initialMember?: InitialMember,
  region?: string,
  selectedApps?: string[],
  slug?: string,
  seedSampleData?: boolean,
): Promise<ProvisionKickoffResult> {
  try {
    // 1. Skip only if provisioning actually COMPLETED. A workspace whose Neon
    //    project exists but never finished provisioning (databaseProvisionedAt
    //    null) must fall through so provisionForWorkspace can re-trigger the
    //    workflow — otherwise it stays stuck forever.
    const [workspace] = await masterDb
      .select({
        neonProjectId: workspaces.neonProjectId,
        neonRoleName: workspaces.neonRoleName,
        databaseProvisionedAt: workspaces.databaseProvisionedAt,
        planId: workspaces.planId,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    if (workspace?.neonProjectId && workspace?.neonRoleName && workspace?.databaseProvisionedAt) {
      console.log(`[Provisioning] Workspace ${workspaceId} already provisioned, skipping`);
      return { ok: true, ready: true };
    }

    // 2. Determine plan slug. Drives Neon placement — free tenants land on a
    //    shared project shard rather than a dedicated project — so defaulting
    //    to a paid slug here would give every unresolved workspace its own
    //    Neon project at full cost.
    let planSlug = DEFAULT_PLAN_SLUG;
    if (workspace?.planId) {
      const [plan] = await masterDb
        .select({ slug: plans.slug })
        .from(plans)
        .where(eq(plans.id, workspace.planId))
        .limit(1);
      planSlug = plan?.slug || DEFAULT_PLAN_SLUG;
    }

    const effectiveRegion = region || env.NEON_DEFAULT_REGION || 'aws-eu-central-1';

    // 3. Create provisioning service and provision (async — triggers Cloudflare Workflow)
    const provisioningService = createProvisioningService({
      NEON_API_KEY: env.NEON_API_KEY,
      NEON_ORG_ID: env.NEON_ORG_ID,
      NEON_DEFAULT_REGION: effectiveRegion,
      PROVISION_WORKSPACE: env.PROVISION_WORKSPACE,
      // Enables the instant warm-slot path to store the encrypted connection
      // URL when it marks the workspace ready inline.
      DATABASE_ENCRYPTION_KEY: env.DATABASE_ENCRYPTION_KEY,
    });

    const latestSchemaVersion = MIGRATION_JOURNAL[MIGRATION_JOURNAL.length - 1]?.tag;

    const result = await provisioningService.provisionForWorkspace(
      masterDb,
      workspaceId,
      workspaceName,
      planSlug,
      initialMember,
      selectedApps,
      slug,
      latestSchemaVersion,
      seedSampleData,
    );

    if (!result.success) {
      console.error(`[Provisioning] Failed: ${result.error}`);
      return { ok: false, error: result.error || 'Provisioning failed' };
    }

    console.log(
      `[Provisioning] Neon database for workspace ${workspaceId}: ` +
      `${result.neonProjectId} — ${result.ready ? 'INSTANT (warm slot, ready now)' : 'async provisioning via Cloudflare Workflow'}`
    );

    // Provisioning drains the warm pool, so the refill cron's cached "settled"
    // verdict is now stale. Clearing it lets the next tick top the pool back up
    // instead of trusting the cache for hours. Best-effort: a failure here only
    // delays the refill until the cache entry expires on its own.
    await invalidatePoolState(env);

    return { ok: true, ready: result.ready === true };
  } catch (error) {
    console.error('[Provisioning] Error provisioning database:', error);
    // Don't throw — workspace creation should still return — but report the
    // failure so the caller can mark the workspace as 'failed' for the UI.
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown provisioning error' };
  }
}

export interface BillingResult {
  customerId?: string;
  subscriptionId?: string;
  warning?: string;
}

/**
 * Plan every new workspace starts on. Free is single-seat and open-ended, and
 * replaced the 14-day Business trial — there is no trial any more.
 *
 * Must stay in step with DEFAULT_PLAN_SLUG in routes/webhooks/clerk.ts and the
 * plan lookup in routes/onboard.ts.
 */
const DEFAULT_PLAN_SLUG = 'free';

/**
 * Resolve the email to put on the workspace's Stripe customer.
 *
 * Prefers the email carried in the provisioning payload — every normal signup
 * path (`/api/onboard` and the platform onboarding routes) sets it. The Clerk
 * `organization.created` webhook can build an initial member from just a
 * `userId` when the creator's master row isn't found yet, so fall back to
 * looking the user up. Returns undefined when neither yields an address; the
 * caller then creates the customer without one rather than failing signup.
 */
export async function resolveOwnerEmail(
  masterDb: any,
  initialMember?: { userId?: string; email?: string },
): Promise<string | undefined> {
  if (initialMember?.email) return initialMember.email;
  if (!initialMember?.userId) return undefined;

  const [owner] = await masterDb
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, initialMember.userId))
    .limit(1);

  return owner?.email || undefined;
}

/**
 * Set up Stripe billing for a new workspace.
 *
 * Creates the Stripe customer only. New workspaces start on Free, which has no
 * price and therefore no subscription — one is created later, through the
 * in-app upgrade flow, if and when the workspace moves to a paid plan. The
 * customer is still created up front so that upgrade has something to attach
 * to and so invoices/receipts reach the right address.
 *
 * This replaces the auto-created cardless 14-day Business trial. That trial
 * relied on `trial_settings[end_behavior][missing_payment_method]=cancel` to
 * cancel itself, and on the `paidPlanRequired` deletion policy to tear down the
 * workspace afterwards. Neither applies now: Free is open-ended, so there is
 * nothing to expire and nothing to reclaim.
 *
 * Returns a result object with IDs and any warnings.
 *
 * `ownerEmail` is the signing-up user's email. Stripe needs it to reach the
 * customer at all — trial-ending and failed-payment emails go nowhere without
 * it, and the Stripe dashboard shows the customer as nameless-by-email.
 */
export async function setupWorkspaceBilling(
  env: Env,
  masterDb: any,
  workspaceId: string,
  workspaceName: string,
  clerkOrgId: string,
  ownerEmail?: string,
): Promise<BillingResult> {
  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) return { warning: 'STRIPE_SECRET_KEY not configured' };

  const stripeAuth = `Basic ${btoa(`${stripeKey}:`)}`;

  // Check if already set up
  const [workspace] = await masterDb
    .select({
      stripeCustomerId: workspaces.stripeCustomerId,
      stripeSubscriptionId: workspaces.stripeSubscriptionId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (workspace?.stripeCustomerId && workspace?.stripeSubscriptionId) {
    console.log(`[Billing] Workspace ${workspaceId} already has Stripe billing`);
    return { customerId: workspace.stripeCustomerId, subscriptionId: workspace.stripeSubscriptionId };
  }

  // Step 1: Create Stripe customer if needed
  let customerId = workspace?.stripeCustomerId;
  if (!customerId) {
    const customerParams = new URLSearchParams({
      name: workspaceName,
      'metadata[workspaceId]': workspaceId,
      'metadata[clerkOrgId]': clerkOrgId,
    });
    if (ownerEmail) customerParams.set('email', ownerEmail);

    const customerRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        'Authorization': stripeAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: customerParams,
    });

    if (!customerRes.ok) {
      const err = await customerRes.text();
      throw new Error(`Stripe customer creation failed: ${err}`);
    }

    const customer = await customerRes.json() as { id: string };
    customerId = customer.id;

    await masterDb
      .update(workspaces)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));

    console.log(`[Billing] Created Stripe customer ${customerId} for workspace ${workspaceId}`);
  }

  // No subscription: Free has no Stripe price. The workspace gets one when it
  // upgrades, through the in-app billing flow, which is also where a card is
  // collected. Leaving subscriptionStatus null here is what marks a workspace
  // as "on Free" for the billing surfaces.
  return { customerId };
}
