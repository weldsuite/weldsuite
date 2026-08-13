/**
 * Billing routes — /api/billing/* surface for the full Stripe subscription UX.
 * Ported from apps/api-worker/src/routes/billing.ts (W3 legacy phase-out).
 *
 * READ:  subscription, plans, plans-page, invoices, payments, phone-numbers,
 *        phone-subscription (proxied to billing-worker Stripe phone sub),
 *        domains, limits (master DB; phone-numbers/domains read the tenant DB),
 *        payment-methods (Stripe API — no local mirror)
 * WRITE: validate-downgrade, checkout, seats, cancel, reactivate (Stripe API),
 *        payment-methods/setup-intent, payment-methods/:id/default,
 *        DELETE payment-methods/:id (Stripe API),
 *        enterprise-inquiry (sales email; NEW — never existed on any worker)
 *
 * Phone/credit Stripe writes + webhooks still live on billing-worker; this
 * worker is the browser-facing surface and proxies those reads so the
 * platform never calls billing-worker directly.
 *
 * Scoping mirrors the original exactly: all subscription/plan/invoice/payment
 * state lives in the MASTER database keyed by the internal workspace id
 * (resolved from the Clerk org id); only /phone-numbers, /domains, and the
 * checkout billing-address pre-fill touch the tenant DB.
 *
 * Permissions:
 *  - /subscription, /plans, /plans-page, /phone-numbers, /domains, /limits
 *    intentionally have no object-level `requirePermission` gate (mirrors the
 *    api-worker source — member-facing feature gates such as weldcall-gate and
 *    the WeldDesk chat-widget call /subscription and /limits for every role;
 *    Clerk auth + org resolution is enforced by the shared /api/* middleware).
 *  - /phone-subscription exposes Stripe phone-line pricing, so it is gated on
 *    `billing:read` like invoices/payments.
 *  - /invoices, /payments and /payment-methods expose Stripe hosted-invoice URLs
 *    and payment method brand/last4, so they are gated on `billing:read` — matching the
 *    platform UI, which returns AccessDenied on that same permission
 *    (apps/web/platform/app/settings/billing/page.tsx). No member-facing feature
 *    gate reads them, so this does not affect plain members.
 *  - WRITE endpoints (Stripe mutations) are gated on `billing:manage` ALONE.
 *    `billing:read` is the view-only grant ("View billing" in the catalog) and
 *    must never authorize spending money; the ADMIN role holds `billing:read`
 *    (migrated from `settings:billing:read`) but is deliberately denied
 *    `billing:manage` (scripts/setup-clerk-permissions.ts). OWNER resolves to
 *    `*` so owners keep full access.
 *  - /enterprise-inquiry is the ONE write gated on the `general:read` baseline
 *    instead: it spends no money and is reachable from the member-facing
 *    pricing dialog. See the note on the route itself.
 *
 * Phone subscription pricing (`GET /phone-subscription`) is proxied to
 * billing-worker rather than reimplemented: `/phone-numbers` (tenant DB) has
 * no price column, and Stripe remains the source of truth for `totalMonthly`.
 *
 * Entity events: none — the entity-events catalog has no billing/subscription
 * entity type (checked packages/core/entity-events/src/events/), and these
 * mutations write master-DB + Stripe state, not tenant entities.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';
import type { Env, Variables } from '../../types';
import { getMasterDb, masterSchema, schema } from '../../db';
import { success, error } from '../../lib/response';
import {
  createStripeCustomer,
  updateStripeCustomer,
  createSubscriptionCheckoutSession,
  retrieveSubscription,
  updateSubscriptionQuantity,
  retrieveInvoice,
  cancelSubscriptionAtPeriodEnd,
  reactivateSubscription,
  createSetupIntent,
  detachPaymentMethod,
  listPaymentMethods,
  retrievePaymentMethod,
  retrieveStripeCustomer,
  setCustomerDefaultPaymentMethod,
  setSubscriptionDefaultPaymentMethod,
  type StripePaymentMethod,
  type StripeSubscription,
} from '../../lib/stripe';
import {
  getAccurateMemberCount,
  calculateEffectiveSeatLimit,
  syncClerkSeatLimit,
  getWorkspaceByOrgId,
  getPlanById,
  mapSubscription,
  renderEnterpriseInquiryEmail,
  fetchPhoneSubscription,
} from '../../services/billing';
import { sendInternalTransactionalEmail } from '../../services/internal-email';

const { workspaces, plans, billingInvoices, billingPayments } = masterSchema;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Stripe mutations require the write grant. `billing:read` is view-only and
 *  must NOT authorize spend; OWNER resolves to `*` and is unaffected. */
const canManageBilling = requirePermission('billing:manage');

/** Invoice/payment history — view-only billing grant. */
const canReadBilling = requirePermission('billing:read');

/** Stripe key guard — STRIPE_SECRET_KEY is optional in Env. */
function requireStripeKey(c: { env: Env }): string | null {
  return c.env.STRIPE_SECRET_KEY ?? null;
}

// ============================================================================
// READ: GET /subscription — Current subscription + seat info (master DB)
// ============================================================================

app.get('/subscription', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const masterDb = getMasterDb(c.env);

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');

  const plan = await getPlanById(masterDb, workspace.planId);

  // Accurate member count (syncs with Clerk if webhooks have failed)
  const activeMemberCount = await getAccurateMemberCount(
    c.env,
    orgId,
    workspace.id,
    masterDb,
  );

  return success(c, mapSubscription(workspace, plan, activeMemberCount));
});

// ============================================================================
// READ: GET /plans — List available plans (master DB)
// ============================================================================

app.get('/plans', async (c) => {
  const masterDb = getMasterDb(c.env);

  const allPlans = await masterDb
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.isActive, true),
        isNull(plans.deletedAt),
        // The free plan is retired — hidden from selection, existing free
        // workspaces are grandfathered (their subscription still resolves by id).
        ne(plans.slug, 'free'),
      ),
    )
    .orderBy(plans.sortOrder);

  return success(
    c,
    allPlans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      description: plan.description,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly,
      currency: plan.currency,
      pricePerUser: plan.pricePerUser,
      includedUsers: plan.includedUsers,
      maxUsers: plan.maxUsers,
      features: plan.features,
      monthlyCredits: plan.monthlyCredits,
      isDefault: plan.isDefault,
      hasApiAccess: plan.hasApiAccess,
      badge: plan.badge,
      sortOrder: plan.sortOrder,
      stripePriceIdMonthly: plan.stripePriceIdMonthly,
      stripePriceIdYearly: plan.stripePriceIdYearly,
    })),
  );
});

// ============================================================================
// READ: GET /plans-page — Plans + current subscription (combined for UI)
// ============================================================================

app.get('/plans-page', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const masterDb = getMasterDb(c.env);

  // Fetch plans (the retired free plan is hidden from selection; existing free
  // workspaces are grandfathered and their subscription still resolves by id).
  const allPlans = await masterDb
    .select()
    .from(plans)
    .where(and(eq(plans.isActive, true), isNull(plans.deletedAt), ne(plans.slug, 'free')))
    .orderBy(plans.sortOrder);

  const features = (f: PlanFeatures | null | undefined) => f || {};
  const toCents = (v: string | null | undefined) => Math.round(parseFloat(v || '0') * 100);

  const mappedPlans = allPlans.map((plan) => {
    const f = features(plan.features);
    return {
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      description: plan.description,
      monthlyPrice: toCents(plan.priceMonthly),
      yearlyPrice: toCents(plan.priceYearly),
      currency: plan.currency,
      pricePerSeat: toCents(plan.pricePerUser),
      isPerSeatPricing: !!plan.pricePerUser,
      includedUsers: plan.includedUsers,
      maxMembers: plan.maxUsers,
      emailsPerMonth: f.emailsPerMonth || 0,
      aiCreditsPerMonth: f.aiCreditsPerMonth || 0,
      monthlyCredits: plan.monthlyCredits,
      isDefault: plan.isDefault,
      isActive: plan.isActive,
      hasApiAccess: plan.hasApiAccess,
      badge: plan.badge,
      displayOrder: plan.sortOrder,
      highlighted: plan.slug === 'scale' || !!plan.badge,
      requiresContact: false,
      maxDomains: f.maxDomains ?? null,
      maxEmailAccounts: f.maxEmailAccounts ?? null,
      maxCustomDomains: plan.maxCustomDomains ?? f.maxCustomDomains ?? null,
      taskExecutions: f.taskExecutions,
      removeBranding: plan.removeBranding || f.removeBranding || false,
      prioritySupport: f.prioritySupport || false,
      customEmailDomain: f.customEmailDomain || false,
      sso: f.sso || false,
      customIntegrations: f.customIntegrations || false,
      stripePriceIdMonthly: plan.stripePriceIdMonthly,
      stripePriceIdYearly: plan.stripePriceIdYearly,
    };
  });

  // Fetch subscription
  const workspace = await getWorkspaceByOrgId(masterDb, orgId);

  let subscription: ReturnType<typeof mapSubscription> | null = null;
  if (workspace) {
    const plan = await getPlanById(masterDb, workspace.planId);

    // Accurate member count (syncs with Clerk if webhooks have failed)
    const activeMemberCount = await getAccurateMemberCount(
      c.env,
      orgId,
      workspace.id,
      masterDb,
    );

    subscription = mapSubscription(workspace, plan, activeMemberCount);
  }

  return success(c, { plans: mappedPlans, subscription });
});

// ============================================================================
// READ: GET /invoices — List invoices from master DB
// ============================================================================

app.get('/invoices', canReadBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const limit = Math.min(parseInt(c.req.query('limit') || '10', 10), 100);
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const offset = (page - 1) * limit;

  const masterDb = getMasterDb(c.env);

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');

  const invoices = await masterDb
    .select()
    .from(billingInvoices)
    .where(eq(billingInvoices.workspaceId, workspace.id))
    .orderBy(desc(billingInvoices.createdAt))
    .limit(limit)
    .offset(offset);

  return success(
    c,
    invoices.map((inv) => ({
      id: inv.stripeInvoiceId,
      number: inv.number,
      amount: inv.amountPaid || inv.amountDue || 0,
      currency: inv.currency,
      status: inv.status,
      periodStart: inv.periodStart?.toISOString() || null,
      periodEnd: inv.periodEnd?.toISOString() || null,
      pdfUrl: inv.pdfUrl,
      hostedUrl: inv.hostedUrl,
      createdAt: inv.createdAt?.toISOString() || null,
      taxAmount: inv.taxAmount || 0,
      subtotalAmount: inv.subtotalAmount || 0,
      customerCountry: inv.customerCountry || null,
      customerTaxExempt: inv.customerTaxExempt || null,
    })),
  );
});

// ============================================================================
// READ: GET /payments — List payments from master DB
// ============================================================================

app.get('/payments', canReadBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const page = Math.max(parseInt(c.req.query('page') || '1', 10), 1);
  const offset = (page - 1) * limit;

  const masterDb = getMasterDb(c.env);

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');

  const payments = await masterDb
    .select()
    .from(billingPayments)
    .where(eq(billingPayments.workspaceId, workspace.id))
    .orderBy(desc(billingPayments.createdAt))
    .limit(limit)
    .offset(offset);

  return success(
    c,
    payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      paymentMethodType: p.paymentMethodType,
      paymentMethodBrand: p.paymentMethodBrand,
      paymentMethodLast4: p.paymentMethodLast4,
      failureMessage: p.failureMessage,
      refundedAmount: p.refundedAmount,
      invoiceId: p.invoiceId,
      createdAt: p.createdAt?.toISOString() || null,
    })),
  );
});

// ============================================================================
// READ: GET /phone-numbers — Workspace phone numbers (tenant DB, billing view)
// ============================================================================

app.get('/phone-numbers', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const db = c.get('tenantDb');

    const { voipPhoneNumbers } = schema;
    const numbers = await db
      .select()
      .from(voipPhoneNumbers)
      .where(isNull(voipPhoneNumbers.deletedAt));

    return success(c, numbers);
  } catch (err) {
    console.error('[Billing] Failed to fetch phone numbers:', err);
    return success(c, []);
  }
});

// ============================================================================
// READ: GET /phone-subscription — Stripe phone-line costs (proxied to billing-worker)
// ============================================================================

app.get('/phone-subscription', canReadBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const result = await fetchPhoneSubscription({
    env: c.env,
    authorization: c.req.header('Authorization'),
  });

  if (!result.ok) {
    if (result.error.kind === 'bad_request') return error.badRequest(c, result.error.message);
    if (result.error.kind === 'not_found') return error.notFound(c, 'Phone subscription');
    console.error('[Billing] phone-subscription proxy failed:', result.error.message);
    return error.internal(c, result.error.message);
  }

  // Caller-specific Stripe pricing — never let intermediaries or the browser cache it.
  c.header('Cache-Control', 'no-store');
  return success(c, result.data);
});

// ============================================================================
// READ: GET /domains — Workspace domains (tenant DB, billing view)
// ============================================================================

app.get('/domains', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const db = c.get('tenantDb');

    const { hostDomains } = schema;
    const domains = await db.select().from(hostDomains).where(isNull(hostDomains.deletedAt));

    return success(c, domains);
  } catch (err) {
    console.error('[Billing] Failed to fetch domains:', err);
    return success(c, []);
  }
});

// ============================================================================
// READ: GET /limits — Plan limits + current usage (master DB)
// ============================================================================

app.get('/limits', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const masterDb = getMasterDb(c.env);

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');

  const plan = await getPlanById(masterDb, workspace.planId);
  const features = (plan?.features || {}) as PlanFeatures;

  // Accurate member count (syncs with Clerk if webhooks have failed)
  const activeMemberCount = await getAccurateMemberCount(
    c.env,
    orgId,
    workspace.id,
    masterDb,
  );

  // Usage counters live in the master DB (centralized usage tables)
  let emailsSentThisMonth = 0;
  let aiCreditsUsedThisMonth = 0;
  let creditsBalance = 0;
  let creditsMonthlyAllocation = 0;

  try {
    const [usage] = await masterDb
      .select()
      .from(masterSchema.workspaceUsage)
      .where(eq(masterSchema.workspaceUsage.workspaceId, workspace.id))
      .limit(1);

    if (usage) {
      emailsSentThisMonth = usage.emailsSentThisMonth;
      aiCreditsUsedThisMonth = usage.aiCreditsUsedThisMonth;
    }

    const [credits] = await masterDb
      .select()
      .from(masterSchema.workspaceCredits)
      .where(eq(masterSchema.workspaceCredits.workspaceId, workspace.id))
      .limit(1);

    if (credits) {
      creditsBalance = credits.currentBalance;
      creditsMonthlyAllocation = credits.monthlyAllocation;
    }
  } catch (err) {
    console.warn('[billing/limits] Could not fetch usage:', err);
  }

  return success(c, {
    planId: plan?.id || null,
    planName: plan?.name || 'Free',
    removeBranding: plan?.removeBranding || features.removeBranding || false,
    maxMembers: plan?.maxUsers ?? null,
    purchasedSeats: workspace.purchasedSeats || 0,
    emailsPerMonth: features.emailsPerMonth || 0,
    aiCreditsPerMonth: features.aiCreditsPerMonth || 0,
    monthlyCredits: plan?.monthlyCredits || 0,
    currentUsage: {
      memberCount: activeMemberCount,
      emailsSentThisMonth,
      aiCreditsUsedThisMonth,
      creditsBalance,
      creditsMonthlyAllocation,
    },
  });
});

// ============================================================================
// READ: POST /validate-downgrade — Check if downgrade is safe
// ============================================================================

const validateDowngradeSchema = z.object({
  targetPlanId: z.string().min(1),
});

app.post('/validate-downgrade', zValidator('json', validateDowngradeSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const body = c.req.valid('json');

  const masterDb = getMasterDb(c.env);

  const targetPlan = await getPlanById(masterDb, body.targetPlanId);
  if (!targetPlan) return error.notFound(c, 'Target plan');

  const blockers: string[] = [];

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');

  // Check member limit (accurate count from Clerk)
  const activeMemberCount = await getAccurateMemberCount(
    c.env,
    orgId,
    workspace.id,
    masterDb,
  );

  const maxMembers = targetPlan.maxUsers;
  if (maxMembers !== null && activeMemberCount > maxMembers) {
    blockers.push(
      `You have ${activeMemberCount} member${activeMemberCount !== 1 ? 's' : ''} but the ${targetPlan.name} plan only allows ${maxMembers}. Please remove ${activeMemberCount - maxMembers} member${activeMemberCount - maxMembers !== 1 ? 's' : ''} first.`,
    );
  }

  return success(c, {
    canDowngrade: blockers.length === 0,
    blockers,
  });
});

// ============================================================================
// WRITE: POST /checkout — Create Stripe Checkout session
// ============================================================================

const checkoutSchema = z.object({
  planId: z.string().min(1),
  seats: z.number().int().min(1),
  cycle: z.enum(['monthly', 'yearly']),
  successUrl: z.string().optional(),
  cancelUrl: z.string().optional(),
});

app.post('/checkout', canManageBilling, zValidator('json', checkoutSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const stripeKey = requireStripeKey(c);
  if (!stripeKey) return error.internal(c, 'Stripe is not configured');

  const body = c.req.valid('json');

  const masterDb = getMasterDb(c.env);

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');

  const plan = await getPlanById(masterDb, body.planId);
  if (!plan) return error.notFound(c, 'Plan');

  // Validate seat count against plan's max users
  if (plan.maxUsers !== null && body.seats > plan.maxUsers) {
    return error.badRequest(
      c,
      `The ${plan.name} plan allows a maximum of ${plan.maxUsers} seats. Please reduce your seat count or choose a higher plan.`,
    );
  }

  // Validate seat count is not below active member count
  const activeMemberCount = await getAccurateMemberCount(
    c.env,
    orgId,
    workspace.id,
    masterDb,
  );
  if (body.seats < activeMemberCount) {
    return error.badRequest(
      c,
      `Cannot purchase ${body.seats} seats — you have ${activeMemberCount} active members. Remove members first.`,
    );
  }

  const priceId = body.cycle === 'yearly' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;
  if (!priceId) {
    return error.badRequest(c, `No ${body.cycle} Stripe price configured for this plan`);
  }

  // Trial eligibility: the 14-day trial applies to the Business plan only, and
  // only for workspaces still on the legacy free plan converting to their first
  // paid subscription. New signups already receive their Business trial at
  // provisioning, and paid → paid switches must not reset the trial, so both
  // keep the current plan's slug !== 'free'.
  const currentPlan = await getPlanById(masterDb, workspace.planId);
  const currentPlanSlug = currentPlan?.slug ?? null;
  const trialPeriodDays = currentPlanSlug === 'free' && plan.slug === 'business' ? 14 : undefined;

  // Ensure customer exists
  let customerId = workspace.stripeCustomerId;
  if (!customerId) {
    const customer = await createStripeCustomer(stripeKey, {
      name: workspace.name,
      metadata: {
        workspaceId: workspace.id,
        clerkOrgId: orgId,
      },
    });
    customerId = customer.id;

    await masterDb
      .update(workspaces)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
  }

  // Sync billing details to the Stripe customer before checkout so the
  // checkout form is pre-filled (tenant-DB workspaceSettings → Stripe).
  try {
    const tenantDb = c.get('tenantDb');
    const { workspaceSettings } = schema;
    const [settings] = await tenantDb
      .select()
      .from(workspaceSettings)
      .where(isNull(workspaceSettings.deletedAt))
      .limit(1);

    if (settings?.addressLine1 && settings?.country) {
      await updateStripeCustomer(stripeKey, customerId, {
        name: settings.legalName || workspace.name,
        address: {
          line1: settings.addressLine1 || undefined,
          line2: settings.addressLine2 || undefined,
          city: settings.city || undefined,
          state: settings.state || undefined,
          postal_code: settings.postalCode || undefined,
          country: settings.country || undefined,
        },
      });
    }
  } catch (err) {
    // Non-critical: if billing details sync fails, checkout can still proceed
    console.warn('[Billing] Failed to sync billing details to Stripe customer:', err);
  }

  const session = await createSubscriptionCheckoutSession(stripeKey, {
    customerId,
    priceId,
    quantity: Math.max(1, body.seats),
    successUrl: body.successUrl || 'https://app.weldsuite.org/settings/billing?success=true',
    cancelUrl: body.cancelUrl || 'https://app.weldsuite.org/settings/billing?canceled=true',
    metadata: {
      workspaceId: workspace.id,
      planId: plan.id,
      seats: body.seats.toString(),
    },
    automaticTax: true,
    taxIdCollection: true,
    billingAddressCollection: 'required',
    trialPeriodDays,
  });

  return success(c, { url: session.url });
});

// ============================================================================
// WRITE: POST /seats — Update seat count
// ============================================================================

const seatsSchema = z.object({
  seatCount: z.number().int().min(1, 'Seat count must be at least 1'),
});

app.post('/seats', canManageBilling, zValidator('json', seatsSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const stripeKey = requireStripeKey(c);
  if (!stripeKey) return error.internal(c, 'Stripe is not configured');

  const body = c.req.valid('json');

  const masterDb = getMasterDb(c.env);

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');
  if (!workspace.stripeSubscriptionId) return error.badRequest(c, 'No active subscription');

  // Accurate member count to prevent reducing below usage
  const activeMemberCount = await getAccurateMemberCount(
    c.env,
    orgId,
    workspace.id,
    masterDb,
  );

  if (body.seatCount < activeMemberCount) {
    return error.badRequest(
      c,
      `Cannot reduce to ${body.seatCount} seats — you have ${activeMemberCount} active members. Remove members first.`,
    );
  }

  // Validate seat count against plan's max users
  if (workspace.planId) {
    const [currentPlan] = await masterDb
      .select({ maxUsers: plans.maxUsers, name: plans.name })
      .from(plans)
      .where(eq(plans.id, workspace.planId));

    if (currentPlan && currentPlan.maxUsers !== null && body.seatCount > currentPlan.maxUsers) {
      return error.badRequest(
        c,
        `The ${currentPlan.name} plan allows a maximum of ${currentPlan.maxUsers} seats. Please upgrade your plan for more seats.`,
      );
    }
  }

  // Get subscription to find the item ID and current quantity
  const subscription = await retrieveSubscription(stripeKey, workspace.stripeSubscriptionId);
  const itemId = subscription.items?.data?.[0]?.id;
  if (!itemId) return error.internal(c, 'Subscription item not found');

  const currentQuantity = subscription.items?.data?.[0]?.quantity || 0;

  // Skip Stripe call if quantity already matches
  if (body.seatCount === currentQuantity) {
    return success(c, { purchasedSeats: currentQuantity });
  }

  const isUpgrade = body.seatCount > currentQuantity;

  // Update quantity on Stripe
  const updatedSubscription = await updateSubscriptionQuantity(
    stripeKey,
    workspace.stripeSubscriptionId,
    itemId,
    body.seatCount,
  );

  // Helper: sync Clerk seat limit after seat count change
  const syncSeatsToClerk = async (newSeatCount: number) => {
    if (!workspace.planId) return;
    try {
      const [plan] = await masterDb
        .select({
          maxUsers: plans.maxUsers,
          pricePerUser: plans.pricePerUser,
          includedUsers: plans.includedUsers,
        })
        .from(plans)
        .where(eq(plans.id, workspace.planId));

      if (plan) {
        const effectiveLimit = calculateEffectiveSeatLimit(plan, newSeatCount, activeMemberCount);
        await syncClerkSeatLimit(c.env.CLERK_SECRET_KEY, orgId, effectiveLimit);
      }
    } catch (err) {
      console.error('[Billing] Failed to sync Clerk seat limit after seat change:', err);
    }
  };

  // For downgrades, update local DB immediately (no payment needed, credit applied)
  if (!isUpgrade) {
    await masterDb
      .update(workspaces)
      .set({
        purchasedSeats: body.seatCount,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspace.id));

    await syncSeatsToClerk(body.seatCount);

    return success(c, { purchasedSeats: body.seatCount });
  }

  // For upgrades, check if the proration invoice was auto-paid
  if (updatedSubscription.latest_invoice) {
    const invoiceId =
      typeof updatedSubscription.latest_invoice === 'string'
        ? updatedSubscription.latest_invoice
        : updatedSubscription.latest_invoice.id;

    const invoice = await retrieveInvoice(stripeKey, invoiceId);

    if (invoice.status === 'paid') {
      // Payment succeeded — update local DB
      await masterDb
        .update(workspaces)
        .set({
          purchasedSeats: body.seatCount,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspace.id));

      await syncSeatsToClerk(body.seatCount);

      return success(c, { purchasedSeats: body.seatCount });
    }

    // Invoice not paid yet — return payment URL, don't update local seats.
    // The invoice.paid webhook will update purchasedSeats when the customer pays.
    return success(c, {
      purchasedSeats: currentQuantity, // Keep current until paid
      paymentRequired: true,
      paymentUrl: invoice.hosted_invoice_url || null,
    });
  }

  // No invoice created (shouldn't happen for upgrades, but handle gracefully)
  return success(c, { purchasedSeats: currentQuantity });
});

// ============================================================================
// WRITE: POST /cancel — Cancel subscription at period end
// ============================================================================

app.post('/cancel', canManageBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const stripeKey = requireStripeKey(c);
  if (!stripeKey) return error.internal(c, 'Stripe is not configured');

  const masterDb = getMasterDb(c.env);

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');
  if (!workspace.stripeSubscriptionId) return error.badRequest(c, 'No active subscription');

  await cancelSubscriptionAtPeriodEnd(stripeKey, workspace.stripeSubscriptionId);

  return success(c, { success: true });
});

// ============================================================================
// WRITE: POST /reactivate — Reactivate canceled subscription
// ============================================================================

app.post('/reactivate', canManageBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const stripeKey = requireStripeKey(c);
  if (!stripeKey) return error.internal(c, 'Stripe is not configured');

  const masterDb = getMasterDb(c.env);

  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');
  if (!workspace.stripeSubscriptionId) return error.badRequest(c, 'No subscription to reactivate');

  await reactivateSubscription(stripeKey, workspace.stripeSubscriptionId);

  return success(c, { success: true });
});

// ============================================================================
// WRITE: POST /enterprise-inquiry — "Contact Sales" from the pricing dialog
// ============================================================================

/**
 * NEW endpoint (not a port): the platform's EnterpriseContactForm has always
 * POSTed here, but no worker ever registered the route, so every submission
 * 404'd and the form showed its error state. Built here to close that gap.
 *
 * Delivery is email to the sales inbox — the same destination the sibling
 * "Contact sales" fallback in billing-settings-section.tsx already opens via
 * `mailto:sales@weldsuite.com`. There is no enterprise_inquiries table and this
 * work item forbids migrations, so email is the whole transport (and matches
 * where the inquiries were already going).
 *
 * Permission: `general:read` — the MEMBER/VIEWER baseline
 * (LEGACY_MEMBER_PERMISSIONS carries `settings:general:read`, which
 * migratePermissionKeys maps to `general:read`). The form is rendered inside
 * pricing-dialog.tsx, which any member can open to ask about upgrading, so a
 * `billing:*` gate here would 403 exactly the users the form exists to serve.
 */
const enterpriseInquirySchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().email().max(320),
  teamSize: z.string().trim().min(1).max(50),
  useCase: z.string().trim().max(5000).optional(),
  source: z.string().trim().max(50).optional(),
});

/** Fixed internal destination — never derived from the request body. */
const ENTERPRISE_INQUIRY_TO = 'sales@weldsuite.com';
const ENTERPRISE_INQUIRY_FROM = 'WeldSuite <noreply@mail.weldsuite.org>';

app.post(
  '/enterprise-inquiry',
  requirePermission('general:read'),
  zValidator('json', enterpriseInquirySchema),
  async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    if (!orgId) return error.orgRequired(c);

    const inquiry = c.req.valid('json');

    const masterDb = getMasterDb(c.env);
    const workspace = await getWorkspaceByOrgId(masterDb, orgId);
    const plan = workspace ? await getPlanById(masterDb, workspace.planId) : null;

    const { subject, html, text } = renderEnterpriseInquiryEmail(inquiry, {
      orgId,
      userId,
      workspaceId: workspace?.id ?? null,
      planSlug: plan?.slug ?? null,
    });

    try {
      await sendInternalTransactionalEmail(c.env, {
        from: ENTERPRISE_INQUIRY_FROM,
        to: [ENTERPRISE_INQUIRY_TO],
        subject,
        html,
        text,
        // Lets sales reply straight to the prospect. The address is validated as
        // an email by the schema, so it cannot inject extra header lines.
        headers: { 'Reply-To': inquiry.contactEmail },
      });
    } catch (err) {
      console.error('[Billing] Enterprise inquiry send failed:', err);
      return error.internal(
        c,
        `Could not submit your inquiry. Please email ${ENTERPRISE_INQUIRY_TO} directly.`,
      );
    }

    return success(c, { success: true }, 201);
  },
);

// ============================================================================
// Payment methods — settings → billing → "Payment methods"
//
// Stripe stays the source of truth: there is no local mirror table and nothing
// to keep in sync. "Primary" is Stripe's own default, written in two places
// because a subscription's `default_payment_method` overrides the customer's
// (see `setSubscriptionDefaultPaymentMethod`). The workspace's phone and agent
// subscriptions are updated alongside the plan subscription so one primary
// method covers every bill the workspace receives.
//
// Adding a method happens entirely in the browser via Stripe Elements against
// a SetupIntent — card data never reaches this worker.
// ============================================================================

/** Every Stripe subscription a workspace can be billed on. */
function workspaceSubscriptionIds(workspace: {
  stripeSubscriptionId: string | null;
  stripePhoneSubscriptionId: string | null;
  stripeAgentsSubscriptionId: string | null;
}): string[] {
  return [
    workspace.stripeSubscriptionId,
    workspace.stripePhoneSubscriptionId,
    workspace.stripeAgentsSubscriptionId,
  ].filter((id): id is string => Boolean(id));
}

/** Normalize Stripe's `string | { id }` expandable fields to a plain id. */
function toId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * Subscription statuses that still produce invoices. A workspace keeps its
 * `stripe*SubscriptionId` columns after cancellation, so the stored ids alone
 * say nothing about whether anything is still being billed — the status has to
 * come from Stripe.
 */
const BILLING_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
]);

/**
 * Fetch the workspace's subscriptions that Stripe still reports as billing.
 * Unreadable ids (deleted, or belonging to a rotated Stripe account) are
 * treated as not billing rather than failing the whole request.
 */
async function getBillingSubscriptions(
  stripeKey: string,
  workspace: {
    stripeSubscriptionId: string | null;
    stripePhoneSubscriptionId: string | null;
    stripeAgentsSubscriptionId: string | null;
  },
): Promise<StripeSubscription[]> {
  const results = await Promise.all(
    workspaceSubscriptionIds(workspace).map(async (id) => {
      try {
        return await retrieveSubscription(stripeKey, id);
      } catch (err) {
        console.error(`[Billing] Could not retrieve subscription ${id}:`, err);
        return null;
      }
    }),
  );

  return results.filter(
    (sub): sub is StripeSubscription =>
      sub !== null && BILLING_SUBSCRIPTION_STATUSES.has(sub.status ?? ''),
  );
}

/** Shape the billing page renders — one row per saved method. */
function mapPaymentMethod(pm: StripePaymentMethod, defaultPaymentMethodId: string | null) {
  const card = pm.card ?? null;
  const sepa = pm.sepa_debit ?? null;

  return {
    id: pm.id,
    type: pm.type,
    brand: card?.brand ?? null,
    last4: card?.last4 ?? sepa?.last4 ?? null,
    expMonth: card?.exp_month ?? null,
    expYear: card?.exp_year ?? null,
    country: card?.country ?? sepa?.country ?? null,
    bankCode: sepa?.bank_code ?? null,
    holderName: pm.billing_details?.name ?? null,
    isDefault: pm.id === defaultPaymentMethodId,
    createdAt: pm.created ? new Date(pm.created * 1000).toISOString() : null,
  };
}

/**
 * Resolve the effective default: the plan subscription's own default wins,
 * falling back to the customer-level default for workspaces with no
 * subscription yet (free plan, or a trial that never checked out).
 */
async function resolveDefaultPaymentMethodId(
  stripeKey: string,
  customerId: string,
  subscriptionId: string | null,
): Promise<string | null> {
  if (subscriptionId) {
    try {
      const subscription = await retrieveSubscription(stripeKey, subscriptionId);
      const subDefault = toId(subscription.default_payment_method);
      if (subDefault) return subDefault;
    } catch (err) {
      // A stale/canceled subscription id must not break the list — fall through
      // to the customer-level default.
      console.error('[Billing] Could not read subscription default payment method:', err);
    }
  }

  const customer = await retrieveStripeCustomer(stripeKey, customerId);
  return toId(customer.invoice_settings?.default_payment_method);
}

// READ: GET /payment-methods — saved methods + which one is primary
app.get('/payment-methods', canReadBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const stripeKey = requireStripeKey(c);
  if (!stripeKey) return error.internal(c, 'Stripe is not configured');

  const masterDb = getMasterDb(c.env);
  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');

  // No Stripe customer yet — the workspace has never paid for anything. An
  // empty list is the correct answer, not an error.
  if (!workspace.stripeCustomerId) return success(c, []);

  try {
    const [methods, defaultPaymentMethodId] = await Promise.all([
      listPaymentMethods(stripeKey, workspace.stripeCustomerId),
      resolveDefaultPaymentMethodId(
        stripeKey,
        workspace.stripeCustomerId,
        workspace.stripeSubscriptionId,
      ),
    ]);

    // Primary first, then newest — matches the reading order of the UI.
    const mapped = methods.data
      .map((pm) => mapPaymentMethod(pm, defaultPaymentMethodId))
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
      });

    return success(c, mapped);
  } catch (err) {
    console.error('[Billing] Failed to list payment methods:', err);
    return error.internal(c, 'Could not load payment methods');
  }
});

// WRITE: POST /payment-methods/setup-intent — client secret for Stripe Elements
app.post('/payment-methods/setup-intent', canManageBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const stripeKey = requireStripeKey(c);
  if (!stripeKey) return error.internal(c, 'Stripe is not configured');

  const masterDb = getMasterDb(c.env);
  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');

  try {
    // A workspace can add a card before it ever subscribes, so the customer is
    // created on demand here exactly as /checkout does.
    let customerId = workspace.stripeCustomerId;
    if (!customerId) {
      const customer = await createStripeCustomer(stripeKey, {
        name: workspace.name,
        metadata: { workspaceId: workspace.id, clerkOrgId: orgId },
      });
      customerId = customer.id;

      await masterDb
        .update(workspaces)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(workspaces.id, workspace.id));
    }

    const setupIntent = await createSetupIntent(stripeKey, {
      customerId,
      metadata: { workspaceId: workspace.id, clerkOrgId: orgId },
    });

    if (!setupIntent.client_secret) {
      return error.internal(c, 'Stripe did not return a client secret');
    }

    return success(c, { clientSecret: setupIntent.client_secret }, 201);
  } catch (err) {
    console.error('[Billing] Failed to create setup intent:', err);
    return error.internal(c, 'Could not start adding a payment method');
  }
});

// WRITE: POST /payment-methods/:id/default — mark a method as primary
app.post('/payment-methods/:id/default', canManageBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const stripeKey = requireStripeKey(c);
  if (!stripeKey) return error.internal(c, 'Stripe is not configured');

  const paymentMethodId = c.req.param('id');

  const masterDb = getMasterDb(c.env);
  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');
  if (!workspace.stripeCustomerId) return error.notFound(c, 'Payment method', paymentMethodId);

  try {
    // Payment method ids are guessable, so ownership is verified against this
    // workspace's customer before any write.
    const paymentMethod = await retrievePaymentMethod(stripeKey, paymentMethodId);
    if (toId(paymentMethod.customer) !== workspace.stripeCustomerId) {
      return error.notFound(c, 'Payment method', paymentMethodId);
    }

    await setCustomerDefaultPaymentMethod(stripeKey, workspace.stripeCustomerId, paymentMethodId);

    // Subscription-level defaults override the customer default, so every
    // subscription still billing has to be updated too. Canceled ones are
    // filtered out first — writing to them would fail as a matter of course,
    // which would make a genuine failure indistinguishable from noise.
    const billingSubscriptions = await getBillingSubscriptions(stripeKey, workspace);
    const failedSubscriptionIds: string[] = [];

    for (const subscription of billingSubscriptions) {
      try {
        await setSubscriptionDefaultPaymentMethod(stripeKey, subscription.id, paymentMethodId);
      } catch (err) {
        // A live subscription that rejects the write keeps charging the old
        // method, so the caller is told the change landed only partially
        // rather than being shown an unqualified success.
        failedSubscriptionIds.push(subscription.id);
        console.error(
          `[Billing] Could not set default payment method on subscription ${subscription.id}:`,
          err,
        );
      }
    }

    return success(c, {
      success: true,
      id: paymentMethodId,
      partial: failedSubscriptionIds.length > 0,
    });
  } catch (err) {
    console.error('[Billing] Failed to set default payment method:', err);
    return error.internal(c, 'Could not set the primary payment method');
  }
});

// WRITE: DELETE /payment-methods/:id — remove a saved method
app.delete('/payment-methods/:id', canManageBilling, async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const stripeKey = requireStripeKey(c);
  if (!stripeKey) return error.internal(c, 'Stripe is not configured');

  const paymentMethodId = c.req.param('id');

  const masterDb = getMasterDb(c.env);
  const workspace = await getWorkspaceByOrgId(masterDb, orgId);
  if (!workspace) return error.notFound(c, 'Workspace');
  if (!workspace.stripeCustomerId) return error.notFound(c, 'Payment method', paymentMethodId);

  try {
    const paymentMethod = await retrievePaymentMethod(stripeKey, paymentMethodId);
    if (toId(paymentMethod.customer) !== workspace.stripeCustomerId) {
      return error.notFound(c, 'Payment method', paymentMethodId);
    }

    // Removing a method that something is still billing against would leave
    // the next invoice with nothing to charge. Require another method to be
    // promoted first.
    //
    // The check spans every billing subscription, not just the plan one:
    // setting a primary writes the phone and agents subscriptions too, so any
    // of them can hold this method as its own default. Subscriptions Stripe
    // reports as canceled are excluded, otherwise a workspace that stopped
    // subscribing could never remove its last card.
    const billingSubscriptions = await getBillingSubscriptions(stripeKey, workspace);

    if (billingSubscriptions.length > 0) {
      const blockedBySubscription = billingSubscriptions.some(
        (sub) => toId(sub.default_payment_method) === paymentMethodId,
      );

      // A subscription with no default of its own falls back to the customer
      // default, so that method is equally load-bearing.
      const someSubscriptionInherits = billingSubscriptions.some(
        (sub) => toId(sub.default_payment_method) === null,
      );
      const customer = someSubscriptionInherits
        ? await retrieveStripeCustomer(stripeKey, workspace.stripeCustomerId)
        : null;
      const blockedByCustomerDefault =
        toId(customer?.invoice_settings?.default_payment_method) === paymentMethodId;

      if (blockedBySubscription || blockedByCustomerDefault) {
        return error.badRequest(
          c,
          'This is your primary payment method. Set another method as primary before removing it.',
        );
      }
    }

    await detachPaymentMethod(stripeKey, paymentMethodId);

    return c.body(null, 204);
  } catch (err) {
    console.error('[Billing] Failed to remove payment method:', err);
    return error.internal(c, 'Could not remove the payment method');
  }
});

export { app as billingRoutes };
