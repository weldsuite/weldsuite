/**
 * Shared Idempotent Provisioning Service
 *
 * Used by both the onboard endpoint and the Clerk webhook handler.
 * Uses async provisioning: creates Neon project + triggers Cloudflare Workflow.
 * The workflow handles schema init, member insertion, billing setup,
 * databaseProvisionedAt, and encrypting/storing the connection URI.
 * Race-safe: UPDATE ... WHERE neon_project_id IS NULL — only one caller wins.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { workspaces, plans } from '@weldsuite/db/schema/master';
import {
  createProvisioningService,
  type InitialMember,
} from '@weldsuite/neon-provisioning';
import type { Env } from '../index';
import { MIGRATION_JOURNAL } from '../generated/tenant-migrations';

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

    // 2. Determine plan slug (defaults to the trial plan for new workspaces)
    let planSlug = 'business';
    if (workspace?.planId) {
      const [plan] = await masterDb
        .select({ slug: plans.slug })
        .from(plans)
        .where(eq(plans.id, workspace.planId))
        .limit(1);
      planSlug = plan?.slug || 'business';
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

/** Length of the free trial granted to every new workspace, in days. */
const TRIAL_PERIOD_DAYS = 14;

/** Default plan every new workspace starts a trial on. */
const DEFAULT_PLAN_SLUG = 'business';

/**
 * Set up Stripe billing for a new workspace.
 * Creates a Stripe customer and a 14-day trialing subscription on the default
 * plan (Business).
 *
 * TODO(pricing): the premium model requires a card up front at trial start,
 * but ONLY for brand-new signups. Existing / grandfathered workspaces are never
 * required to add a card. This function runs in a non-interactive provisioning
 * workflow, so it cannot collect a card here — enforcing card-required for new
 * signups means starting their trial through a Stripe Checkout session during
 * onboarding instead of auto-creating the cardless trial below. Existing
 * accounts changing plans keep going through the in-app flow with no new card
 * requirement. Until that onboarding change lands, the trial is created cardless
 * and cancels at trial end if no card is added (trial_settings below).
 * Returns a result object with IDs and any warnings.
 */
export async function setupWorkspaceBilling(
  env: Env,
  masterDb: any,
  workspaceId: string,
  workspaceName: string,
  clerkOrgId: string,
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
    const customerRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        'Authorization': stripeAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        name: workspaceName,
        'metadata[workspaceId]': workspaceId,
        'metadata[clerkOrgId]': clerkOrgId,
      }),
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

  // Step 2: Look up the default plan's Stripe price
  const [defaultPlan] = await masterDb
    .select({
      id: plans.id,
      stripePriceIdMonthly: plans.stripePriceIdMonthly,
    })
    .from(plans)
    .where(and(eq(plans.slug, DEFAULT_PLAN_SLUG), isNull(plans.deletedAt)));

  if (!defaultPlan) {
    console.error(`[Billing] No ${DEFAULT_PLAN_SLUG} plan found in database — cannot create trial subscription`);
    return { customerId, warning: `No ${DEFAULT_PLAN_SLUG} plan found in database` };
  }

  if (!defaultPlan.stripePriceIdMonthly) {
    console.error(`[Billing] ${DEFAULT_PLAN_SLUG} plan has no stripePriceIdMonthly — cannot create trial subscription`);
    return { customerId, warning: `${DEFAULT_PLAN_SLUG} plan has no stripePriceIdMonthly` };
  }

  // Step 3: Create a 14-day trialing subscription with no payment method.
  // `trial_settings[end_behavior][missing_payment_method]=cancel` makes the
  // subscription cancel itself when the trial ends and no card was added,
  // instead of generating an unpaid invoice.
  const subRes = await fetch('https://api.stripe.com/v1/subscriptions', {
    method: 'POST',
    headers: {
      'Authorization': stripeAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: customerId,
      'items[0][price]': defaultPlan.stripePriceIdMonthly,
      trial_period_days: String(TRIAL_PERIOD_DAYS),
      'trial_settings[end_behavior][missing_payment_method]': 'cancel',
      'metadata[workspaceId]': workspaceId,
      'metadata[planId]': defaultPlan.id,
      'metadata[clerkOrgId]': clerkOrgId,
    }),
  });

  if (!subRes.ok) {
    const err = await subRes.text();
    throw new Error(`Stripe subscription creation failed: ${err}`);
  }

  const subscription = await subRes.json() as {
    id: string;
    status?: string;
    current_period_start?: number;
    current_period_end?: number;
  };

  await masterDb
    .update(workspaces)
    .set({
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status || 'trialing',
      subscriptionCycle: 'monthly',
      subscriptionCurrentPeriodStart: subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000)
        : null,
      subscriptionCurrentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));

  console.log(`[Billing] Created ${TRIAL_PERIOD_DAYS}-day trial subscription ${subscription.id} for workspace ${workspaceId}`);
  return { customerId, subscriptionId: subscription.id };
}
