/**
 * Stripe Billing Webhook Handler
 *
 * Handles Stripe billing events (subscriptions, invoices, product/price sync).
 * Includes seat-based billing support via subscription item quantity.
 * Persists all billing state (subscription, invoices, payments) to the database.
 */

import { Hono } from 'hono';
import { eq, and, isNull, or, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Env } from '../index';
import { getMasterDb, masterSchema } from '../lib/db';
import {
  verifyStripeSignature,
  isOurOwnSync,
  retrieveSubscription,
  createStripeSubscription,
  stripeApiRequest,
} from '../lib/stripe';
import { calculateEffectiveSeatLimit, syncClerkSeatLimit, getMemberCount } from '../lib/clerk';
import { updateSubscriptionCredits } from '../services/credits';
import { grantCredits } from '@weldsuite/credits';
import { CloudflareRegistrar, CloudflareApiError } from '@weldsuite/cloudflare-registrar';
import type {
  StripeEvent,
  StripeCheckoutSession,
  StripeSubscription,
  StripeInvoice,
  StripeProduct,
  StripePrice,
  StripePaymentIntent,
  StripeCharge,
  StripeConnectAccount,
} from '../types/stripe';

const {
  workspaces,
  plans,
  billingInvoices,
  billingPayments,
  userAppInstalls,
  appDeveloperAccounts,
} = masterSchema;

// "Trial ended → add payment or workspace is deleted" policy grace period.
// Applies only to workspaces.paidPlanRequired === true (new signups; existing
// workspaces are grandfathered onto the free-downgrade path). See
// handleSubscriptionDeleted below and workspace-worker's deletion-sweep cron.
const GRACE_PERIOD_DAYS = 30;

// ============================================================================
// Domain Registration helpers (Task 5b)
// ============================================================================

/** Issue a Stripe refund for a given payment intent. */
async function issueRefund(env: Env, paymentIntentId: string): Promise<void> {
  try {
    await stripeApiRequest(env.STRIPE_SECRET_KEY, 'POST', '/v1/refunds', {
      payment_intent: paymentIntentId,
    });
  } catch (err) {
    console.error('[Domain Registration] Stripe refund failed:', err);
    throw err;
  }
}

// Helper: extract subscription cycle from Stripe subscription
function getSubscriptionCycle(subscription: StripeSubscription): 'monthly' | 'yearly' {
  const interval = subscription.items?.data?.[0]?.price?.recurring?.interval;
  return interval === 'year' ? 'yearly' : 'monthly';
}

// Helper: extract customer ID from string or object
function extractCustomerId(customer: string | { id: string }): string {
  return typeof customer === 'string' ? customer : customer.id;
}

// Helper: extract subscription ID from string or object
function extractSubscriptionId(subscription: string | { id: string } | null): string | null {
  if (!subscription) return null;
  return typeof subscription === 'string' ? subscription : subscription.id;
}

export const webhookRoutes = new Hono<{ Bindings: Env }>();

// ============================================================================
// Main webhook handler
// ============================================================================

webhookRoutes.post('/', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('stripe-signature');

  if (!signature) {
    console.error('[Stripe Webhook] Missing stripe-signature header');
    return c.json({ error: 'Missing signature' }, 400);
  }

  const webhookSecret = c.env.STRIPE_BILLING_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Stripe Webhook] Missing STRIPE_BILLING_WEBHOOK_SECRET');
    return c.json({ error: 'Webhook not configured' }, 500);
  }

  try {
    await verifyStripeSignature(rawBody, signature, webhookSecret);
  } catch (err: any) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return c.json({ error: 'Invalid signature' }, 400);
  }

  const event: StripeEvent = JSON.parse(rawBody);
  console.log(`[Stripe Webhook] Received event: ${event.type}`);

  const masterDb = getMasterDb(c.env);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      // Delayed payment methods (SEPA, bank transfer) complete the session
      // with payment_status='unpaid' and fire async_payment_succeeded later —
      // both paths route through the same handler; the topup branch grants
      // only once payment_status is 'paid' (idempotent on session id).
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(c.env, masterDb, event.data.object as StripeCheckoutSession);
        break;

      case 'checkout.session.expired':
        await handleCheckoutExpired(c.env, masterDb, event.data.object as StripeCheckoutSession);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(c.env, masterDb, event.data.object as StripeSubscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(c.env, masterDb, event.data.object as StripeSubscription);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(c.env, masterDb, event.data.object as StripeInvoice);
        break;

      case 'invoice.created':
      case 'invoice.finalized':
        await handleInvoiceUpsert(masterDb, event.data.object as StripeInvoice);
        break;

      case 'invoice.upcoming':
        // Fired ~3 days before the next billing period. We use it to clean up
        // any agent-package line items whose workspace flagged them for
        // cancellation — delete them with proration_behavior=none so the new
        // invoice won't include them.
        await handleInvoiceUpcoming(c.env, masterDb, event.data.object as StripeInvoice);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(masterDb, event.data.object as StripeInvoice);
        break;

      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(masterDb, event.data.object as StripePaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(masterDb, event.data.object as StripePaymentIntent);
        break;

      case 'charge.refunded':
        await handleChargeRefunded(masterDb, event.data.object as StripeCharge);
        break;

      case 'product.created':
      case 'product.updated':
        await handleProductUpdated(masterDb, event.data.object as StripeProduct);
        break;

      case 'product.deleted':
        await handleProductDeleted(masterDb, event.data.object as StripeProduct);
        break;

      case 'price.created':
      case 'price.updated':
        await handlePriceUpdated(masterDb, event.data.object as StripePrice);
        break;

      case 'price.deleted':
        await handlePriceDeleted(masterDb, event.data.object as StripePrice);
        break;

      case 'account.updated':
        await handleConnectAccountUpdated(masterDb, event.data.object as StripeConnectAccount);
        break;

      default:
        console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    return c.json({ received: true });
  } catch (error: any) {
    console.error('[Stripe Webhook] Error processing event:', error);
    return c.json({ error: error.message }, 500);
  }
});

// ============================================================================
// Checkout Completed
// ============================================================================

async function handleCheckoutCompleted(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  session: StripeCheckoutSession
) {
  console.log('[Stripe Webhook] Processing checkout.session.completed');

  // Domain registration checkout (mode='payment')
  if (session.metadata?.kind === 'domain_registration') {
    await handleDomainRegistrationCheckout(env, session);
    return;
  }

  // Prepaid credit topup checkout (mode='payment')
  if (session.metadata?.kind === 'credit_topup') {
    await handleCreditTopupCheckout(masterDb, session);
    return;
  }

  // WeldApps marketplace — paid app subscription checkout (mode='subscription')
  if (session.metadata?.appId) {
    await handleAppSubscriptionCheckoutCompleted(masterDb, session);
    return;
  }

  if (session.mode !== 'subscription') {
    console.log('[Stripe Webhook] Not a subscription checkout, skipping');
    return;
  }

  // Agent-package checkout — AI/agent billing has been removed. Log and
  // no-op rather than touching the (now-deleted) agent-purchase tables.
  if (session.metadata?.type === 'agent_purchase') {
    console.warn('[Stripe Webhook] Ignoring agent_purchase checkout — AI is currently unavailable');
    return;
  }

  // Handle phone number checkout separately
  if (session.metadata?.type === 'phone_checkout') {
    const workspaceId = session.metadata.workspaceId;
    const clerkOrgId = session.metadata.clerkOrgId;
    const subscriptionId = session.subscription as string;

    if (!workspaceId || !subscriptionId) {
      console.error('[Stripe Webhook] Phone checkout missing workspaceId or subscription');
      return;
    }

    await masterDb
      .update(workspaces)
      .set({
        stripePhoneSubscriptionId: subscriptionId,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId));

    console.log(`[Stripe Webhook] Linked phone subscription ${subscriptionId} to workspace ${workspaceId}`);
    return;
  }

  const workspaceId = session.metadata?.workspaceId;
  const planId = session.metadata?.planId;
  const subscriptionId = session.subscription as string;
  const seatsStr = session.metadata?.seats;

  if (!workspaceId || !planId) {
    console.error('[Stripe Webhook] Missing workspaceId or planId in session metadata');
    return;
  }

  const [workspace] = await masterDb
    .select({
      planId: workspaces.planId,
      clerkOrgId: workspaces.clerkOrgId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    console.error(`[Stripe Webhook] Workspace not found: ${workspaceId}`);
    return;
  }

  // Get seat count and subscription details from Stripe
  let purchasedSeats = seatsStr ? parseInt(seatsStr, 10) : 0;
  let cycle: 'monthly' | 'yearly' = 'monthly';
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;

  if (env.STRIPE_SECRET_KEY) {
    try {
      const sub = await retrieveSubscription(env.STRIPE_SECRET_KEY, subscriptionId);
      purchasedSeats = purchasedSeats || sub.items?.data?.[0]?.quantity || 0;
      cycle = getSubscriptionCycle(sub);
      periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000) : null;
      periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
    } catch {
      // Fall back to defaults
    }
  }

  const [updated] = await masterDb
    .update(workspaces)
    .set({
      planId,
      stripeSubscriptionId: subscriptionId,
      purchasedSeats,
      subscriptionStatus: 'active',
      subscriptionCycle: cycle,
      subscriptionCurrentPeriodStart: periodStart,
      subscriptionCurrentPeriodEnd: periodEnd,
      subscriptionCancelAtPeriodEnd: false,
      // A paid subscription is active again — lift the "pay or be deleted"
      // paywall/deletion schedule, if one was set.
      trialExpiredAt: null,
      scheduledDeletionAt: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
    .returning();

  if (!updated) {
    console.error(`[Stripe Webhook] Failed to update workspace ${workspaceId}`);
    return;
  }

  console.log(`[Stripe Webhook] Updated workspace ${workspaceId} to plan ${planId} with ${purchasedSeats} seats`);

  // Reverse-sync customer details from checkout to workspace billing details
  if (session.customer_details?.address) {
    try {
      const addr = session.customer_details.address;
      const taxIds = session.customer_details.tax_ids;
      const vatNumber = taxIds?.find(t => t.type === 'eu_vat')?.value || null;

      // Update workspace settings in tenant DB if available
      // Note: This is a best-effort sync — the authoritative data is on the Stripe customer
      console.log(`[Stripe Webhook] Checkout customer details: country=${addr.country}, taxExempt=${session.customer_details.tax_exempt}, vatNumber=${vatNumber ? 'present' : 'none'}`);
    } catch (err) {
      console.warn('[Stripe Webhook] Failed to reverse-sync checkout details:', err);
    }
  }

  // Sync credits
  if (workspace.clerkOrgId) {
    await syncSubscriptionCredits(env, masterDb, workspaceId, workspace.clerkOrgId, planId);
  }

  // Sync seat limit to Clerk
  if (workspace.clerkOrgId && env.CLERK_SECRET_KEY) {
    try {
      const [plan] = await masterDb
        .select({
          maxUsers: plans.maxUsers,
          pricePerUser: plans.pricePerUser,
          includedUsers: plans.includedUsers,
        })
        .from(plans)
        .where(eq(plans.id, planId));

      if (plan) {
        const memberCount = await getMemberCount(env, masterDb, workspace.clerkOrgId, workspaceId);
        const effectiveLimit = calculateEffectiveSeatLimit(plan, purchasedSeats, memberCount);
        await syncClerkSeatLimit(env.CLERK_SECRET_KEY, workspace.clerkOrgId, effectiveLimit);
      }
    } catch (err) {
      console.error('[Stripe Webhook] Failed to sync Clerk seat limit after checkout:', err);
    }
  }
}

// ============================================================================
// Subscription Updated
// ============================================================================

async function handleSubscriptionUpdated(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  subscription: StripeSubscription
) {
  console.log('[Stripe Webhook] Processing subscription update');

  // WeldApps marketplace — paid app subscription, not a plan/seat subscription
  if (subscription.metadata?.appId) {
    await handleAppSubscriptionStatusChange(masterDb, subscription);
    return;
  }

  // Check if this is a phone subscription (by metadata or by matching stripePhoneSubscriptionId)
  if (subscription.metadata?.type === 'phone') {
    console.log('[Stripe Webhook] Phone subscription update, skipping plan/seat changes');
    return;
  }

  // Check if this subscription matches a phone subscription by ID
  const [phoneWorkspace] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.stripePhoneSubscriptionId, subscription.id));

  if (phoneWorkspace) {
    console.log(`[Stripe Webhook] Phone subscription update for workspace ${phoneWorkspace.id}, skipping plan/seat changes`);
    return;
  }

  // Same skip for the agents subscription — plan/seat state doesn't apply.
  if (subscription.metadata?.type === 'agent_purchase') {
    console.log('[Stripe Webhook] Agents subscription update, skipping plan/seat changes');
    return;
  }
  const [agentsWorkspace] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.stripeAgentsSubscriptionId, subscription.id));
  if (agentsWorkspace) {
    console.log(
      `[Stripe Webhook] Agents subscription update for workspace ${agentsWorkspace.id}, skipping plan/seat changes`,
    );
    return;
  }

  let [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.stripeSubscriptionId, subscription.id));

  if (!workspace) {
    const customerId = extractCustomerId(subscription.customer);

    const [workspaceByCustomer] = await masterDb
      .select()
      .from(workspaces)
      .where(eq(workspaces.stripeCustomerId, customerId));

    if (!workspaceByCustomer) {
      console.log('[Stripe Webhook] No workspace found for subscription, may be new');
      return;
    }

    workspace = workspaceByCustomer;

    // Only auto-assign subscription if it's not a phone subscription
    if (!workspaceByCustomer.stripeSubscriptionId && subscription.metadata?.type !== 'phone') {
      await masterDb
        .update(workspaces)
        .set({
          stripeSubscriptionId: subscription.id,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceByCustomer.id));
    }
  }

  // Get the price ID, product ID, and quantity from the subscription
  const priceId = subscription.items.data[0]?.price.id;
  const productId = subscription.items.data[0]?.price.product;
  const quantity = subscription.items.data[0]?.quantity || 0;

  if (!priceId) {
    console.warn('[Stripe Webhook] No price ID in subscription');
    return;
  }

  // Find the plan by Stripe price ID
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

  let matchedPlan = plan || yearlyPlan;

  // Fallback: find plan by Stripe product ID (handles new price IDs created by Stripe)
  if (!matchedPlan && productId) {
    const [productPlan] = await masterDb
      .select()
      .from(plans)
      .where(and(
        eq(plans.stripeProductId, productId),
        isNull(plans.deletedAt)
      ));

    if (productPlan) {
      matchedPlan = productPlan;
      console.log(`[Stripe Webhook] Matched plan ${productPlan.name} by product ID ${productId} (price ID ${priceId} not found)`);
    }
  }

  const updateSet: Record<string, any> = {
    purchasedSeats: quantity,
    subscriptionStatus: subscription.status,
    subscriptionCycle: getSubscriptionCycle(subscription),
    subscriptionCurrentPeriodStart: subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000)
      : null,
    subscriptionCurrentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
    subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end,
    updatedAt: new Date(),
  };

  if (matchedPlan && workspace.planId !== matchedPlan.id) {
    updateSet.planId = matchedPlan.id;
    console.log(`[Stripe Webhook] Updated workspace ${workspace.id} to plan ${matchedPlan.name}`);
  }

  // A paid subscription became active/trialing again — lift the "pay or be
  // deleted" paywall/deletion schedule, if one was set. past_due/unpaid/
  // canceled are left untouched here; the terminal canceled case is handled
  // by handleSubscriptionDeleted (invoked below when status is canceled/unpaid).
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    updateSet.trialExpiredAt = null;
    updateSet.scheduledDeletionAt = null;
  }

  await masterDb
    .update(workspaces)
    .set(updateSet)
    .where(eq(workspaces.id, workspace.id));

  console.log(`[Stripe Webhook] Updated workspace ${workspace.id} seats to ${quantity}`);

  // Sync credits when plan changes
  if (matchedPlan && workspace.planId !== matchedPlan.id && workspace.clerkOrgId) {
    await syncSubscriptionCredits(env, masterDb, workspace.id, workspace.clerkOrgId, matchedPlan.id);
  }

  // Sync seat limit to Clerk
  const effectivePlan = matchedPlan || (workspace.planId ? await (async () => {
    const [p] = await masterDb.select().from(plans).where(eq(plans.id, workspace.planId!));
    return p;
  })() : null);

  if (workspace.clerkOrgId && env.CLERK_SECRET_KEY && effectivePlan) {
    try {
      const memberCount = await getMemberCount(env, masterDb, workspace.clerkOrgId, workspace.id);
      const effectiveLimit = calculateEffectiveSeatLimit(effectivePlan, quantity, memberCount);
      await syncClerkSeatLimit(env.CLERK_SECRET_KEY, workspace.clerkOrgId, effectiveLimit);
    } catch (err) {
      console.error('[Stripe Webhook] Failed to sync Clerk seat limit after subscription update:', err);
    }
  }

  // Handle subscription status changes
  if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
    await handleSubscriptionDeleted(env, masterDb, subscription);
  }
}

// ============================================================================
// Subscription Deleted
// ============================================================================

async function handleSubscriptionDeleted(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  subscription: StripeSubscription
) {
  console.log('[Stripe Webhook] Processing subscription deletion');

  // WeldApps marketplace — paid app subscription. subscriptionStatus is set
  // to Stripe's ('canceled'); the userAppInstalls.status column (active/
  // revoked) is left untouched — the app-api uninstall flow owns revocation.
  if (subscription.metadata?.appId) {
    await handleAppSubscriptionStatusChange(masterDb, subscription);
    return;
  }

  // Check if this is a phone subscription
  const [phoneWorkspace] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.stripePhoneSubscriptionId, subscription.id));

  if (phoneWorkspace) {
    await masterDb
      .update(workspaces)
      .set({ stripePhoneSubscriptionId: null, updatedAt: new Date() })
      .where(eq(workspaces.id, phoneWorkspace.id));
    console.log(`[Stripe Webhook] Cleared phone subscription for workspace ${phoneWorkspace.id}`);
    return;
  }

  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.stripeSubscriptionId, subscription.id));

  if (!workspace) {
    console.log('[Stripe Webhook] No workspace found for deleted subscription');
    return;
  }

  // New-signup / no-free-plan policy: the trial/subscription ended without an
  // active paid subscription. Instead of downgrading to a free plan, start (or
  // preserve) the 30-day "add payment or be deleted" grace period — the
  // workspace-worker deletion-sweep cron tears the workspace down once
  // scheduledDeletionAt elapses.
  if (workspace.paidPlanRequired) {
    if (!workspace.isActive) {
      console.log(`[Stripe Webhook] Workspace ${workspace.id} is already inactive, skipping deletion scheduling`);
      return;
    }

    // Idempotent: if a grace period is already running (e.g. a duplicate/
    // retried webhook, or subscription.updated already handled it), don't
    // push the deletion date out further.
    const trialExpiredAt = workspace.trialExpiredAt ?? new Date();
    const scheduledDeletionAt =
      workspace.scheduledDeletionAt ??
      new Date(trialExpiredAt.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

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
      `[Stripe Webhook] Workspace ${workspace.id} trial/subscription ended with no active paid subscription — scheduled for deletion at ${scheduledDeletionAt.toISOString()}`,
    );
    return;
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

  console.log(`[Stripe Webhook] Downgraded workspace ${workspace.id} to free plan`);

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
      console.error('[Stripe Webhook] Failed to sync Clerk seat limit after downgrade:', err);
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

      console.log(`[Stripe Webhook] Created new free subscription ${newSubscription.id} for workspace ${workspace.id}`);
    } catch (subError) {
      console.error('[Stripe Webhook] Failed to create free subscription after downgrade:', subError);
    }
  }
}

// ============================================================================
// WeldApps Marketplace — App Subscriptions
// ============================================================================
//
// Paid user-created apps subscribe through the same Stripe account as plan
// billing, tagged with metadata.appId/workspaceId/installId (session +
// subscription). None of the plan/seat/credits logic above applies to them.

/**
 * checkout.session.completed for a paid app subscription — link the Stripe
 * subscription to the (already-created, revoked/incomplete) install row and
 * mark it active. Idempotent: safe to replay, always targets the same row.
 */
async function handleAppSubscriptionCheckoutCompleted(
  masterDb: ReturnType<typeof getMasterDb>,
  session: StripeCheckoutSession,
) {
  const appId = session.metadata?.appId;
  const workspaceId = session.metadata?.workspaceId;
  const installId = session.metadata?.installId;
  const subscriptionId = extractSubscriptionId(session.subscription);

  if (!appId || !workspaceId || !subscriptionId) {
    console.error(
      `[Stripe Webhook] App subscription checkout ${session.id} missing appId/workspaceId/subscription`,
    );
    return;
  }

  const where = installId
    ? eq(userAppInstalls.id, installId)
    : and(eq(userAppInstalls.appId, appId), eq(userAppInstalls.workspaceId, workspaceId));

  const result = await masterDb
    .update(userAppInstalls)
    .set({
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: 'active',
      updatedAt: new Date(),
    })
    .where(where)
    .returning({ id: userAppInstalls.id });

  if (result.length === 0) {
    console.error(
      `[Stripe Webhook] App subscription checkout ${session.id}: no install row matched (app=${appId} workspace=${workspaceId} installId=${installId})`,
    );
    return;
  }

  console.log(
    `[Stripe Webhook] App subscription activated: app=${appId} workspace=${workspaceId} sub=${subscriptionId}`,
  );
}

/**
 * customer.subscription.updated/deleted for a paid app subscription — mirror
 * Stripe's status onto userAppInstalls.subscriptionStatus. Deliberately does
 * NOT touch userAppInstalls.status (active/revoked) — even on 'canceled' —
 * because the app-api uninstall flow is the sole owner of that column.
 */
async function handleAppSubscriptionStatusChange(
  masterDb: ReturnType<typeof getMasterDb>,
  subscription: StripeSubscription,
) {
  const appId = subscription.metadata?.appId;
  const workspaceId = subscription.metadata?.workspaceId;

  if (!appId || !workspaceId) {
    console.error(
      `[Stripe Webhook] App subscription ${subscription.id} update missing appId/workspaceId metadata`,
    );
    return;
  }

  await masterDb
    .update(userAppInstalls)
    .set({
      subscriptionStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      updatedAt: new Date(),
    })
    .where(and(eq(userAppInstalls.appId, appId), eq(userAppInstalls.workspaceId, workspaceId)));

  console.log(
    `[Stripe Webhook] App install subscriptionStatus -> ${subscription.status} (app=${appId} workspace=${workspaceId})`,
  );
}

// ============================================================================
// WeldApps Marketplace — Connect Account Updates
// ============================================================================

/**
 * account.updated (Stripe Connect) — refresh payoutsEnabled for the developer
 * workspace whose Express account this is. onboardedAt is set the first time
 * the account becomes payout-ready and never cleared afterwards.
 */
async function handleConnectAccountUpdated(
  masterDb: ReturnType<typeof getMasterDb>,
  account: StripeConnectAccount,
) {
  const [devAccount] = await masterDb
    .select()
    .from(appDeveloperAccounts)
    .where(eq(appDeveloperAccounts.stripeConnectAccountId, account.id));

  if (!devAccount) {
    console.log(`[Stripe Webhook] account.updated for unknown Connect account ${account.id}, skipping`);
    return;
  }

  const payoutsEnabled = Boolean(account.charges_enabled && account.payouts_enabled);

  await masterDb
    .update(appDeveloperAccounts)
    .set({
      payoutsEnabled,
      onboardedAt: payoutsEnabled && !devAccount.onboardedAt ? new Date() : devAccount.onboardedAt,
      updatedAt: new Date(),
    })
    .where(eq(appDeveloperAccounts.id, devAccount.id));

  console.log(
    `[Stripe Webhook] Connect account ${account.id} (workspace=${devAccount.workspaceId}) payoutsEnabled=${payoutsEnabled}`,
  );
}

// ============================================================================
// Invoice Paid
// ============================================================================

async function handleInvoicePaid(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  invoice: StripeInvoice
) {
  console.log('[Stripe Webhook] Processing invoice.paid');

  // Always upsert the invoice into the database
  await handleInvoiceUpsert(masterDb, invoice);

  const subscriptionId = extractSubscriptionId(invoice.subscription);

  if (!subscriptionId) {
    console.log('[Stripe Webhook] invoice.paid has no subscription, skipping credit sync');
    return;
  }

  // Check if this invoice belongs to a phone subscription — skip credit sync
  const [phoneWorkspace] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.stripePhoneSubscriptionId, subscriptionId));

  if (phoneWorkspace) {
    console.log(`[Stripe Webhook] Phone subscription invoice paid for workspace ${phoneWorkspace.id}, skipping credit sync`);
    return;
  }

  // Skip credit sync for initial subscription creation — credits handled in checkout
  if (invoice.billing_reason === 'subscription_create') {
    console.log('[Stripe Webhook] Skipping credit sync for subscription_create invoice — initial credits handled elsewhere');
    return;
  }

  const [workspace] = await masterDb
    .select({
      id: workspaces.id,
      clerkOrgId: workspaces.clerkOrgId,
      planId: workspaces.planId,
    })
    .from(workspaces)
    .where(eq(workspaces.stripeSubscriptionId, subscriptionId));

  if (!workspace) {
    console.log('[Stripe Webhook] No workspace found for invoice subscription', subscriptionId);
    return;
  }

  if (!workspace.clerkOrgId) {
    console.error('[Stripe Webhook] Workspace has no clerkOrgId:', workspace.id);
    return;
  }

  if (!env.STRIPE_SECRET_KEY) {
    console.warn('[Stripe Webhook] STRIPE_SECRET_KEY not configured');
    return;
  }

  const subscription = await retrieveSubscription(env.STRIPE_SECRET_KEY, subscriptionId);
  const periodStart = subscription.current_period_start
    ? new Date(subscription.current_period_start * 1000)
    : new Date();
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Sync purchasedSeats from the paid subscription quantity
  const paidQuantity = subscription.items?.data?.[0]?.quantity || 0;
  if (paidQuantity > 0) {
    await masterDb
      .update(workspaces)
      .set({
        purchasedSeats: paidQuantity,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspace.id));
    console.log(`[Stripe Webhook] Updated workspace ${workspace.id} purchasedSeats to ${paidQuantity} after invoice paid`);
  }

  let planCredits = 0;
  let plan: typeof plans.$inferSelect | undefined;
  if (workspace.planId) {
    const [p] = await masterDb
      .select()
      .from(plans)
      .where(eq(plans.id, workspace.planId));
    plan = p;
    if (plan) {
      planCredits = plan.monthlyCredits || 0;
    }
  }

  try {
    await updateSubscriptionCredits(masterDb, workspace.id, {
      planCredits,
      subscribedCredits: 0,
      resetPeriod: true,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    });

    console.log(`[Stripe Webhook] Credits reset for workspace ${workspace.id} — allocation: ${planCredits}`);
  } catch (error) {
    console.error('[Stripe Webhook] Error resetting credits on invoice.paid:', error);
  }

  // Sync seat limit to Clerk after purchasedSeats update
  if (workspace.clerkOrgId && env.CLERK_SECRET_KEY && plan) {
    try {
      const currentSeats = paidQuantity > 0 ? paidQuantity : 0;
      const memberCount = await getMemberCount(env, masterDb, workspace.clerkOrgId, workspace.id);
      const effectiveLimit = calculateEffectiveSeatLimit(plan, currentSeats, memberCount);
      await syncClerkSeatLimit(env.CLERK_SECRET_KEY, workspace.clerkOrgId, effectiveLimit);
    } catch (err) {
      console.error('[Stripe Webhook] Failed to sync Clerk seat limit after invoice.paid:', err);
    }
  }
}

// ============================================================================
// Invoice Upsert (invoice.created, invoice.finalized, and called from invoice.paid)
// ============================================================================

async function handleInvoiceUpsert(
  masterDb: ReturnType<typeof getMasterDb>,
  invoice: StripeInvoice
) {
  console.log(`[Stripe Webhook] Upserting invoice ${invoice.id}`);

  const subscriptionId = extractSubscriptionId(invoice.subscription);
  const customerId = invoice.customer;

  // Find workspace by subscription ID or customer ID
  let workspace: { id: string } | undefined;

  if (subscriptionId) {
    const [ws] = await masterDb
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(or(
        eq(workspaces.stripeSubscriptionId, subscriptionId),
        eq(workspaces.stripePhoneSubscriptionId, subscriptionId)
      ));
    workspace = ws;
  }

  if (!workspace && customerId) {
    const [ws] = await masterDb
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.stripeCustomerId, customerId));
    workspace = ws;
  }

  if (!workspace) {
    console.log('[Stripe Webhook] No workspace found for invoice, skipping DB insert');
    return;
  }

  const now = new Date();

  await masterDb
    .insert(billingInvoices)
    .values({
      id: nanoid(),
      workspaceId: workspace.id,
      stripeInvoiceId: invoice.id,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      number: invoice.number,
      amountDue: invoice.amount_due || 0,
      amountPaid: invoice.amount_paid || 0,
      currency: invoice.currency,
      status: invoice.status,
      billingReason: invoice.billing_reason,
      periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
      periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
      pdfUrl: invoice.invoice_pdf,
      hostedUrl: invoice.hosted_invoice_url,
      paidAt: invoice.status === 'paid' ? now : null,
      taxAmount: invoice.tax || 0,
      subtotalAmount: invoice.subtotal || 0,
      customerCountry: invoice.customer_address?.country || null,
      customerTaxExempt: invoice.customer_tax_exempt || null,
      createdAt: invoice.created ? new Date(invoice.created * 1000) : now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: billingInvoices.stripeInvoiceId,
      set: {
        amountDue: invoice.amount_due || 0,
        amountPaid: invoice.amount_paid || 0,
        status: invoice.status,
        billingReason: invoice.billing_reason,
        periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
        periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
        pdfUrl: invoice.invoice_pdf,
        hostedUrl: invoice.hosted_invoice_url,
        paidAt: invoice.status === 'paid' ? now : undefined,
        taxAmount: invoice.tax || 0,
        subtotalAmount: invoice.subtotal || 0,
        customerCountry: invoice.customer_address?.country || null,
        customerTaxExempt: invoice.customer_tax_exempt || null,
        updatedAt: now,
      },
    });

  console.log(`[Stripe Webhook] Upserted invoice ${invoice.id} for workspace ${workspace.id}`);
}

// ============================================================================
// Invoice Payment Failed
// ============================================================================

async function handleInvoicePaymentFailed(
  masterDb: ReturnType<typeof getMasterDb>,
  invoice: StripeInvoice
) {
  console.log('[Stripe Webhook] Processing invoice payment failure');

  const subscriptionId = extractSubscriptionId(invoice.subscription);

  if (!subscriptionId) return;

  // Check if this is a phone subscription payment failure
  const [phoneWorkspace] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.stripePhoneSubscriptionId, subscriptionId));

  if (phoneWorkspace) {
    console.warn(`[Stripe Webhook] Phone subscription payment failed for workspace ${phoneWorkspace.id}`);
    return;
  }

  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.stripeSubscriptionId, subscriptionId));

  if (workspace) {
    console.warn(`[Stripe Webhook] Payment failed for workspace ${workspace.id}`);
  }

  // Update the invoice status in DB if it exists
  await masterDb
    .update(billingInvoices)
    .set({
      status: 'open', // Payment failed, invoice remains open
      updatedAt: new Date(),
    })
    .where(eq(billingInvoices.stripeInvoiceId, invoice.id));
}

// ============================================================================
// Payment Intent Succeeded
// ============================================================================

async function handlePaymentIntentSucceeded(
  masterDb: ReturnType<typeof getMasterDb>,
  paymentIntent: StripePaymentIntent
) {
  console.log(`[Stripe Webhook] Processing payment_intent.succeeded: ${paymentIntent.id}`);

  const customerId = paymentIntent.customer;
  if (!customerId) {
    console.log('[Stripe Webhook] Payment intent has no customer, skipping');
    return;
  }

  // Find workspace by customer ID
  const [workspace] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.stripeCustomerId, customerId));

  if (!workspace) {
    console.log('[Stripe Webhook] No workspace found for payment intent customer');
    return;
  }

  // Find linked invoice record if present
  let invoiceRecordId: string | null = null;
  if (paymentIntent.invoice) {
    const [invoiceRecord] = await masterDb
      .select({ id: billingInvoices.id })
      .from(billingInvoices)
      .where(eq(billingInvoices.stripeInvoiceId, paymentIntent.invoice));
    invoiceRecordId = invoiceRecord?.id || null;
  }

  // Extract payment method details from the first charge
  const charge = paymentIntent.charges?.data?.[0];
  const pmDetails = charge?.payment_method_details;

  await masterDb
    .insert(billingPayments)
    .values({
      id: nanoid(),
      workspaceId: workspace.id,
      invoiceId: invoiceRecordId,
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: charge?.id || null,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: 'succeeded',
      paymentMethodType: pmDetails?.type || null,
      paymentMethodBrand: pmDetails?.card?.brand || null,
      paymentMethodLast4: pmDetails?.card?.last4 || pmDetails?.sepa_debit?.last4 || null,
      failureCode: null,
      failureMessage: null,
      refundedAmount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: billingPayments.stripePaymentIntentId,
      set: {
        status: 'succeeded',
        stripeChargeId: charge?.id || null,
        paymentMethodType: pmDetails?.type || null,
        paymentMethodBrand: pmDetails?.card?.brand || null,
        paymentMethodLast4: pmDetails?.card?.last4 || pmDetails?.sepa_debit?.last4 || null,
        updatedAt: new Date(),
      },
    });

  console.log(`[Stripe Webhook] Recorded successful payment ${paymentIntent.id} for workspace ${workspace.id}`);
}

// ============================================================================
// Payment Intent Failed
// ============================================================================

async function handlePaymentIntentFailed(
  masterDb: ReturnType<typeof getMasterDb>,
  paymentIntent: StripePaymentIntent
) {
  console.log(`[Stripe Webhook] Processing payment_intent.payment_failed: ${paymentIntent.id}`);

  const customerId = paymentIntent.customer;
  if (!customerId) {
    console.log('[Stripe Webhook] Payment intent has no customer, skipping');
    return;
  }

  // Find workspace by customer ID
  const [workspace] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.stripeCustomerId, customerId));

  if (!workspace) {
    console.log('[Stripe Webhook] No workspace found for failed payment intent customer');
    return;
  }

  // Find linked invoice record if present
  let invoiceRecordId: string | null = null;
  if (paymentIntent.invoice) {
    const [invoiceRecord] = await masterDb
      .select({ id: billingInvoices.id })
      .from(billingInvoices)
      .where(eq(billingInvoices.stripeInvoiceId, paymentIntent.invoice));
    invoiceRecordId = invoiceRecord?.id || null;
  }

  const charge = paymentIntent.charges?.data?.[0];
  const pmDetails = charge?.payment_method_details;

  await masterDb
    .insert(billingPayments)
    .values({
      id: nanoid(),
      workspaceId: workspace.id,
      invoiceId: invoiceRecordId,
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: charge?.id || null,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: 'failed',
      paymentMethodType: pmDetails?.type || null,
      paymentMethodBrand: pmDetails?.card?.brand || null,
      paymentMethodLast4: pmDetails?.card?.last4 || pmDetails?.sepa_debit?.last4 || null,
      failureCode: paymentIntent.last_payment_error?.code || null,
      failureMessage: paymentIntent.last_payment_error?.message || null,
      refundedAmount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: billingPayments.stripePaymentIntentId,
      set: {
        status: 'failed',
        failureCode: paymentIntent.last_payment_error?.code || null,
        failureMessage: paymentIntent.last_payment_error?.message || null,
        updatedAt: new Date(),
      },
    });

  console.log(`[Stripe Webhook] Recorded failed payment ${paymentIntent.id} for workspace ${workspace.id}`);
}

// ============================================================================
// Credit Topup Checkout
// ============================================================================

/**
 * Grant purchased credits after a topup checkout is paid. Idempotent on the
 * checkout session id — Stripe webhook replays and the async-payment
 * double-fire record exactly one ledger row.
 */
async function handleCreditTopupCheckout(
  masterDb: ReturnType<typeof getMasterDb>,
  session: StripeCheckoutSession
) {
  const workspaceId = session.metadata?.workspaceId;
  const packageId = session.metadata?.packageId;

  if (!workspaceId) {
    console.error(`[Stripe Webhook] Credit topup ${session.id} missing workspaceId metadata`);
    return;
  }

  // Delayed payment methods complete the session with payment_status='unpaid';
  // the grant happens when checkout.session.async_payment_succeeded re-fires.
  if (session.payment_status && session.payment_status !== 'paid') {
    console.log(`[Stripe Webhook] Credit topup ${session.id} not paid yet (${session.payment_status}), skipping`);
    return;
  }

  // Authoritative credit amount from the package row; metadata is the fallback
  // (packages are global/admin-managed, metadata could be stale or tampered).
  let credits = parseInt(session.metadata?.credits ?? '', 10);
  if (packageId) {
    const [pkg] = await masterDb
      .select({ credits: masterSchema.creditPackages.credits })
      .from(masterSchema.creditPackages)
      .where(eq(masterSchema.creditPackages.id, packageId))
      .limit(1);
    if (pkg) credits = pkg.credits;
  }

  if (!Number.isInteger(credits) || credits <= 0) {
    console.error(`[Stripe Webhook] Credit topup ${session.id} has no valid credit amount`);
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;

  const result = await grantCredits(masterDb, {
    workspaceId,
    amount: credits,
    type: 'purchase',
    idempotencyKey: `stripe_checkout:${session.id}`,
    referenceId: packageId?.slice(0, 30),
    referenceType: 'credit_package',
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: paymentIntentId ?? undefined,
    amountPaid: session.amount_total != null ? (session.amount_total / 100).toFixed(2) : undefined,
    currency: session.currency ? session.currency.toUpperCase() : undefined,
    description: `Credit topup: +${credits} credits`,
    metadata: { packageId, checkoutSessionId: session.id },
    userId: session.metadata?.userId,
  });

  console.log(
    `[Stripe Webhook] Credit topup ${session.id}: +${credits} credits for workspace ${workspaceId} ` +
      `(newBalance=${result.newBalance}${result.duplicate ? ', duplicate replay ignored' : ''})`,
  );
}

// ============================================================================
// Charge Refunded
// ============================================================================

async function handleChargeRefunded(
  masterDb: ReturnType<typeof getMasterDb>,
  charge: StripeCharge
) {
  console.log(`[Stripe Webhook] Processing charge.refunded: ${charge.id}`);

  // Update the existing payment record's refunded amount
  await masterDb
    .update(billingPayments)
    .set({
      refundedAmount: charge.amount_refunded,
      updatedAt: new Date(),
    })
    .where(eq(billingPayments.stripeChargeId, charge.id));

  console.log(`[Stripe Webhook] Updated refund amount for charge ${charge.id}: ${charge.amount_refunded}`);

  // If this charge paid for a credit topup, claw the credits back. Only on a
  // FULL refund — partial refunds are an admin decision, not an automatic
  // clawback. The balance may go negative: visible debt beats hidden loss.
  const paymentIntentId =
    typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId || !charge.refunded) return;

  const [purchase] = await masterDb
    .select({
      id: masterSchema.creditTransactions.id,
      workspaceId: masterSchema.creditTransactions.workspaceId,
      amount: masterSchema.creditTransactions.amount,
    })
    .from(masterSchema.creditTransactions)
    .where(
      and(
        eq(masterSchema.creditTransactions.stripePaymentIntentId, paymentIntentId),
        eq(masterSchema.creditTransactions.type, 'purchase'),
      ),
    )
    .limit(1);

  if (!purchase || purchase.amount <= 0) return;

  const clawback = await grantCredits(masterDb, {
    workspaceId: purchase.workspaceId,
    amount: -purchase.amount,
    type: 'adjustment',
    idempotencyKey: `refund_clawback:${charge.id}`,
    referenceId: purchase.id,
    referenceType: 'credit_transaction',
    description: `Topup refunded — clawback of ${purchase.amount} credits`,
    metadata: { chargeId: charge.id, paymentIntentId, purchaseTransactionId: purchase.id },
  });

  console.log(
    `[Stripe Webhook] Clawed back ${purchase.amount} credits for refunded charge ${charge.id} ` +
      `(newBalance=${clawback.newBalance}${clawback.duplicate ? ', duplicate replay ignored' : ''})`,
  );
}

// ============================================================================
// Credits Sync Helpers
// ============================================================================

async function syncSubscriptionCredits(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  workspaceId: string,
  clerkOrgId: string,
  planId: string,
) {
  try {
    const [plan] = await masterDb
      .select()
      .from(plans)
      .where(eq(plans.id, planId));

    if (!plan) {
      console.error('[Stripe Webhook] Plan not found for credits sync:', planId);
      return;
    }

    const planCredits = plan.monthlyCredits || 0;

    await updateSubscriptionCredits(masterDb, workspaceId, {
      planCredits,
      subscribedCredits: 0,
    });

    console.log(`[Stripe Webhook] Credits synced for workspace ${workspaceId}`);
  } catch (error) {
    console.error('[Stripe Webhook] Error syncing credits:', error);
  }
}

async function resetCreditsToFreeTier(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  workspaceId: string,
  clerkOrgId: string
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

    console.log(`[Stripe Webhook] Credits reset to free tier for workspace ${workspaceId}`);
  } catch (error) {
    console.error('[Stripe Webhook] Error resetting credits:', error);
  }
}

// ============================================================================
// Product/Price Sync Handlers
// ============================================================================

async function handleProductUpdated(
  masterDb: ReturnType<typeof getMasterDb>,
  product: StripeProduct
) {
  console.log('[Stripe Webhook] Processing product update:', product.id);

  if (isOurOwnSync(product.metadata)) {
    console.log('[Stripe Webhook] Skipping - our own sync');
    return;
  }

  const planId = product.metadata?.planId;

  if (planId) {
    const [existingPlan] = await masterDb
      .select()
      .from(plans)
      .where(eq(plans.id, planId));

    if (existingPlan) {
      await masterDb
        .update(plans)
        .set({
          name: product.name,
          description: product.description || existingPlan.description,
          isActive: product.active,
          stripeProductId: product.id,
          updatedAt: new Date(),
        })
        .where(eq(plans.id, planId));
    }
  } else {
    const [existingByStripeId] = await masterDb
      .select()
      .from(plans)
      .where(eq(plans.stripeProductId, product.id));

    if (existingByStripeId) {
      await masterDb
        .update(plans)
        .set({
          name: product.name,
          description: product.description || existingByStripeId.description,
          isActive: product.active,
          updatedAt: new Date(),
        })
        .where(eq(plans.id, existingByStripeId.id));
    }
  }
}

async function handleProductDeleted(
  masterDb: ReturnType<typeof getMasterDb>,
  product: StripeProduct
) {
  const [plan] = await masterDb
    .select()
    .from(plans)
    .where(eq(plans.stripeProductId, product.id));

  if (plan) {
    await masterDb
      .update(plans)
      .set({
        deletedAt: new Date(),
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(plans.id, plan.id));
  }
}

async function handlePriceUpdated(
  masterDb: ReturnType<typeof getMasterDb>,
  price: StripePrice
) {
  if (isOurOwnSync(price.metadata)) return;

  const planId = price.metadata?.planId;
  const billingCycle = price.metadata?.billingCycle;
  const productId = typeof price.product === 'string' ? price.product : (price.product as any)?.id;

  if (!productId) return;

  let targetPlan;

  if (planId) {
    const [plan] = await masterDb
      .select()
      .from(plans)
      .where(eq(plans.id, planId));
    targetPlan = plan;
  }

  if (!targetPlan) {
    const [plan] = await masterDb
      .select()
      .from(plans)
      .where(eq(plans.stripeProductId, productId));
    targetPlan = plan;
  }

  if (!targetPlan) return;

  const interval = price.recurring?.interval;
  const unitAmount = price.unit_amount || 0;
  const priceInUnits = (unitAmount / 100).toFixed(2);

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (interval === 'month' || billingCycle === 'monthly') {
    updates.stripePriceIdMonthly = price.id;
    updates.priceMonthly = priceInUnits;
  } else if (interval === 'year' || billingCycle === 'yearly') {
    updates.stripePriceIdYearly = price.id;
    updates.priceYearly = priceInUnits;
  }

  if (price.currency) {
    updates.currency = price.currency.toUpperCase();
  }

  await masterDb
    .update(plans)
    .set(updates)
    .where(eq(plans.id, targetPlan.id));
}

async function handlePriceDeleted(
  masterDb: ReturnType<typeof getMasterDb>,
  price: StripePrice
) {
  const [plan] = await masterDb
    .select()
    .from(plans)
    .where(or(
      eq(plans.stripePriceIdMonthly, price.id),
      eq(plans.stripePriceIdYearly, price.id)
    ));

  if (plan) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (plan.stripePriceIdMonthly === price.id) {
      updates.stripePriceIdMonthly = null;
    }
    if (plan.stripePriceIdYearly === price.id) {
      updates.stripePriceIdYearly = null;
    }

    await masterDb
      .update(plans)
      .set(updates)
      .where(eq(plans.id, plan.id));
  }
}

// ============================================================================
// Agent-package: invoice.upcoming sweeper
// ============================================================================
//
// Agent/AI billing has been removed (workspace_agent_purchases + agent_packages
// tables are gone). Stripe may still fire `invoice.upcoming` for pre-existing
// agents subscriptions until they're wound down out-of-band — no-op instead
// of touching the deleted tables.

async function handleInvoiceUpcoming(
  _env: Env,
  _masterDb: ReturnType<typeof getMasterDb>,
  invoice: StripeInvoice,
) {
  console.warn(
    `[Stripe Webhook] Ignoring invoice.upcoming for subscription ${invoice.subscription} — AI/agent billing is currently unavailable`,
  );
}

// ============================================================================
// Domain Registration — checkout.session.completed (kind='domain_registration')
// ============================================================================
//
// Idempotency key: stripeSessionId on the host_domains row.
// If the row is already 'active' we skip without re-registering.

async function handleDomainRegistrationCheckout(
  env: Env,
  session: StripeCheckoutSession,
): Promise<void> {
  const sessionId = session.id;
  const workspaceId = session.metadata?.workspaceId;
  const registrationIdsRaw = session.metadata?.registrationIds;

  if (!workspaceId || !registrationIdsRaw) {
    console.error('[Domain Registration] Missing workspaceId or registrationIds in session metadata');
    return;
  }

  let registrationIds: string[];
  try {
    registrationIds = JSON.parse(registrationIdsRaw) as string[];
  } catch {
    console.error('[Domain Registration] Could not parse registrationIds JSON:', registrationIdsRaw);
    return;
  }

  if (registrationIds.length === 0) return;

  const cfToken = env.CLOUDFLARE_API_TOKEN;
  const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!cfToken || !cfAccountId) {
    console.error('[Domain Registration] CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not configured');
    return;
  }

  // Open the tenant DB for this workspace
  const { getTenantDbForWorkspace, schema: tenantSchema } = await import('../lib/tenant-db');
  const tenantDb = await getTenantDbForWorkspace(env, workspaceId);

  const cf = new CloudflareRegistrar({
    accountId: cfAccountId,
    apiToken: cfToken,
  });

  // Retrieve payment intent for potential refunds
  let paymentIntentId: string | null = null;
  try {
    const fullSession = await stripeApiRequest(
      env.STRIPE_SECRET_KEY,
      'GET',
      `/v1/checkout/sessions/${sessionId}`,
    ) as { payment_intent?: string | null };
    paymentIntentId = fullSession.payment_intent ?? null;
  } catch (err) {
    console.warn('[Domain Registration] Could not retrieve payment intent:', err);
  }

  for (const domainId of registrationIds) {
    // Fetch the pending row
    const [domainRow] = await tenantDb
      .select()
      .from(tenantSchema.hostDomains)
      .where(eq(tenantSchema.hostDomains.id, domainId))
      .limit(1);

    if (!domainRow) {
      console.error(`[Domain Registration] Domain row not found: ${domainId}`);
      continue;
    }

    // Idempotency: skip if already processed
    if (domainRow.registrationStatus === 'registered' || domainRow.status === 'active') {
      console.log(`[Domain Registration] Domain ${domainId} already active, skipping`);
      continue;
    }

    // Mark as pending_registration before calling CF (so Stripe retries don't double-register)
    await tenantDb
      .update(tenantSchema.hostDomains)
      .set({
        registrationStatus: 'pending_registration',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tenantSchema.hostDomains.id, domainId),
          eq(tenantSchema.hostDomains.registrationStatus, 'pending_payment'),
        ),
      );

    try {
      const result = await cf.register({
        name: domainRow.fullDomain,
        contact: (domainRow.registrantContact as Record<string, unknown> | null) ?? undefined,
        autoRenew: domainRow.autoRenew ?? true,
        years: 1,
      });

      if (result.status === 'completed') {
        await tenantDb
          .update(tenantSchema.hostDomains)
          .set({
            status: 'active',
            registrationStatus: 'registered',
            externalRegistrarId: result.domain.id,
            registrarStatus: result.domain.status,
            registeredAt: new Date(),
            expiresAt: result.domain.expiresAt ? new Date(result.domain.expiresAt) : null,
            locked: result.domain.locked,
            autoRenew: result.domain.autoRenew,
            registrarSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tenantSchema.hostDomains.id, domainId));

        console.log(`[Domain Registration] Registered ${domainRow.fullDomain} (id=${domainId}) → active`);
      } else {
        // CF returned 202 — async workflow
        await tenantDb
          .update(tenantSchema.hostDomains)
          .set({
            registrationStatus: 'pending_workflow',
            workflowUrl: result.workflowUrl,
            updatedAt: new Date(),
          })
          .where(eq(tenantSchema.hostDomains.id, domainId));

        console.log(`[Domain Registration] ${domainRow.fullDomain} pending CF workflow: ${result.workflowUrl}`);
      }
    } catch (cfErr) {
      const cfError = cfErr instanceof CloudflareApiError ? cfErr : null;
      const errMsg = cfError?.message ?? (cfErr instanceof Error ? cfErr.message : String(cfErr));

      console.error(`[Domain Registration] CF registration failed for ${domainRow.fullDomain}:`, errMsg);

      await tenantDb
        .update(tenantSchema.hostDomains)
        .set({
          status: 'cancelled',
          registrationStatus: 'registration_failed',
          metadata: { error: errMsg, cfStatus: cfError?.status },
          updatedAt: new Date(),
        })
        .where(eq(tenantSchema.hostDomains.id, domainId));

      // Attempt to refund the Stripe payment
      if (paymentIntentId) {
        try {
          await issueRefund(env, paymentIntentId);
          console.log(`[Domain Registration] Refund issued for payment ${paymentIntentId}`);
        } catch (refundErr) {
          console.error('[Domain Registration] Refund failed:', refundErr);
        }
      }
    }
  }
}

// ============================================================================
// Domain Registration — checkout.session.expired
// ============================================================================

async function handleCheckoutExpired(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  session: StripeCheckoutSession,
): Promise<void> {
  if (session.metadata?.kind !== 'domain_registration') return;

  const workspaceId = session.metadata.workspaceId;
  const registrationIdsRaw = session.metadata.registrationIds;
  if (!workspaceId || !registrationIdsRaw) return;

  let registrationIds: string[];
  try {
    registrationIds = JSON.parse(registrationIdsRaw) as string[];
  } catch {
    return;
  }
  if (registrationIds.length === 0) return;

  const { getTenantDbForWorkspace, schema: tenantSchema } = await import('../lib/tenant-db');

  try {
    const tenantDb = await getTenantDbForWorkspace(env, workspaceId);

    await tenantDb
      .update(tenantSchema.hostDomains)
      .set({
        registrationStatus: 'failed',
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(tenantSchema.hostDomains.id, registrationIds),
          eq(tenantSchema.hostDomains.registrationStatus, 'pending_payment'),
        ),
      );

    console.log(`[Domain Registration] Soft-deleted ${registrationIds.length} pending rows for expired session ${session.id}`);
  } catch (err) {
    console.error('[Domain Registration] handleCheckoutExpired failed:', err);
  }
}
