/**
 * Billing operations behind the admin console (routes/admin.ts).
 *
 * Each operation loads the workspace, validates the request against its plan
 * and Stripe state, makes the change (in Stripe first, where Stripe is
 * involved), and writes the result to the master DB right away instead of
 * waiting for the webhook. The webhooks that follow write the same values.
 *
 * Where a Stripe subscription is about to go away, the workspace row stops
 * pointing at it *before* Stripe is called. The `customer.subscription.deleted`
 * webhook then finds no workspace and does nothing, so the ended-subscription
 * policy is applied exactly once (same trick as checkout replacing the $0 sub).
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { grantCredits } from '@weldsuite/credits';
import type { Env } from '../index';
import type { AdminActor } from '../middleware/admin-auth';
import { type getMasterDb, masterSchema } from '../lib/db';
import { getMemberCount, trySyncClerkSeatLimit } from '../lib/clerk';
import { createStripeCustomer, updateStripeCustomer } from '../lib/stripe';
import {
  type AdminStripeCustomer,
  type AdminStripeInvoice,
  type AdminStripePaymentMethod,
  type AdminStripeSubscription,
  type CollectionMethod,
  type ProrationBehavior,
  applySubscriptionCoupon,
  cancelSubscriptionNow,
  clearSubscriptionDiscounts,
  createAdminSubscription,
  createCoupon,
  createRefund,
  expanded,
  previewSubscriptionInvoice,
  retrieveCustomerForAdmin,
  retrieveSubscriptionForAdmin,
  setCancelAtPeriodEnd,
  setSubscriptionTrialEnd,
  subscriptionCoupon,
  subscriptionPeriod,
  updateSubscriptionPlanItem,
  voidStripeInvoice,
} from '../lib/stripe-admin';
import {
  type SubscriptionEndedOutcome,
  applySubscriptionEnded,
  detachEndedSubscriptionFromComp,
  findPlanForStripePrice,
  isCompActive,
  syncSubscriptionCredits,
  unixToDate,
} from './subscription-policy';

const { workspaces, plans, billingInvoices, billingPayments, userWorkspaces, users } = masterSchema;

type MasterDb = ReturnType<typeof getMasterDb>;
type WorkspaceRow = typeof workspaces.$inferSelect;
type PlanRow = typeof plans.$inferSelect;

export interface AdminContext {
  env: Env;
  masterDb: MasterDb;
  actor: AdminActor;
  /** Per-submit id from the console; makes every Stripe write idempotent. */
  requestId: string;
  reason: string;
}

export type AdminErrorCode = 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'NOT_CONFIGURED';

/** A refusal the admin can act on; the route maps it to a 4xx/503 with the message. */
export class AdminBillingError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminBillingError';
  }
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Stripe refuses a trial end more than two years out. */
const MAX_TRIAL_DAYS = 730;
/** Subscriptions whose plan item can still be changed. `incomplete` ones cannot. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);
const RESUMABLE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

function stripeKey(env: Env): string {
  if (!env.STRIPE_SECRET_KEY) throw new AdminBillingError('NOT_CONFIGURED', 'Stripe is not configured');
  return env.STRIPE_SECRET_KEY;
}

function idempotencyKey(ctx: AdminContext, action: string): string {
  return `admin:${action}:${ctx.requestId}`;
}

async function loadWorkspace(masterDb: MasterDb, workspaceId: string): Promise<WorkspaceRow> {
  const [workspace] = await masterDb.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!workspace) throw new AdminBillingError('NOT_FOUND', 'Workspace not found');
  if (workspace.deletedAt) throw new AdminBillingError('CONFLICT', 'This workspace has been deleted');
  return workspace;
}

async function loadPlan(masterDb: MasterDb, planId: string): Promise<PlanRow> {
  const [plan] = await masterDb
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), isNull(plans.deletedAt)))
    .limit(1);
  if (!plan) throw new AdminBillingError('NOT_FOUND', 'Plan not found');
  return plan;
}

function requireSubscriptionId(workspace: WorkspaceRow): string {
  if (!workspace.stripeSubscriptionId) {
    throw new AdminBillingError('CONFLICT', 'This workspace has no Stripe subscription');
  }
  return workspace.stripeSubscriptionId;
}

function assertSeatsWithinPlan(plan: PlanRow, seats: number): void {
  if (plan.maxUsers != null && plan.maxUsers > 0 && seats > plan.maxUsers) {
    throw new AdminBillingError(
      'BAD_REQUEST',
      `The ${plan.name} plan allows at most ${plan.maxUsers} seats.`,
    );
  }
}

/** The admin-deletion schedule survives billing changes; the trial-expiry one does not. */
function liftedPaywall(workspace: WorkspaceRow): Partial<WorkspaceRow> {
  if (workspace.deletionRequestedBy) return {};
  return { trialExpiredAt: null, scheduledDeletionAt: null };
}

function priceIdFor(plan: PlanRow, cycle: 'monthly' | 'yearly'): string {
  const priceId = cycle === 'yearly' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;
  if (!priceId) {
    throw new AdminBillingError(
      'BAD_REQUEST',
      `${plan.name} has no ${cycle} price in Stripe. Open the plan in the catalog and save it to create one.`,
    );
  }
  return priceId;
}

/**
 * The subscription item that carries the plan. Plan subscriptions normally
 * have one item; if there are more, prefer the one whose price or product
 * belongs to a plan.
 */
async function planItemOf(
  masterDb: MasterDb,
  subscription: AdminStripeSubscription,
): Promise<AdminStripeSubscription['items']['data'][number]> {
  const items = subscription.items?.data ?? [];
  if (items.length === 0) throw new AdminBillingError('CONFLICT', 'The Stripe subscription has no items');
  if (items.length === 1) return items[0]!;

  const priceIds = items.map((i) => i.price.id);
  const productIds = items.map((i) => (typeof i.price.product === 'string' ? i.price.product : i.price.product.id));
  const planRows = await masterDb
    .select({
      monthly: plans.stripePriceIdMonthly,
      yearly: plans.stripePriceIdYearly,
      product: plans.stripeProductId,
    })
    .from(plans)
    .where(
      or(
        inArray(plans.stripePriceIdMonthly, priceIds),
        inArray(plans.stripePriceIdYearly, priceIds),
        inArray(plans.stripeProductId, productIds),
      ),
    );
  const known = new Set(planRows.flatMap((p) => [p.monthly, p.yearly, p.product]).filter(Boolean));
  return (
    items.find((i) => {
      const product = typeof i.price.product === 'string' ? i.price.product : i.price.product.id;
      return known.has(i.price.id) || known.has(product);
    }) ?? items[0]!
  );
}

/** Admin emails of the workspace, for a Stripe customer created on its behalf. */
async function workspaceBillingEmail(masterDb: MasterDb, workspaceId: string): Promise<string | undefined> {
  const [row] = await masterDb
    .select({ email: users.email })
    .from(userWorkspaces)
    .innerJoin(users, eq(userWorkspaces.userId, users.id))
    .where(
      and(
        eq(userWorkspaces.workspaceId, workspaceId),
        eq(userWorkspaces.status, 'ACTIVE'),
        eq(userWorkspaces.role, 'org:admin'),
      ),
    )
    .limit(1);
  return row?.email ?? undefined;
}

/** Copy the workspace's billing address to the Stripe customer (best effort). */
async function syncCustomerAddress(env: Env, key: string, workspaceId: string, customerId: string): Promise<boolean> {
  try {
    const { getTenantDbForWorkspace, schema } = await import('../lib/tenant-db');
    const tenantDb = await getTenantDbForWorkspace(env, workspaceId);
    const [settings] = await tenantDb
      .select()
      .from(schema.workspaceSettings)
      .where(isNull(schema.workspaceSettings.deletedAt))
      .limit(1);
    if (!settings?.addressLine1 || !settings.country) return false;
    await updateStripeCustomer(key, customerId, {
      name: settings.legalName || undefined,
      address: {
        line1: settings.addressLine1 || undefined,
        line2: settings.addressLine2 || undefined,
        city: settings.city || undefined,
        state: settings.state || undefined,
        postal_code: settings.postalCode || undefined,
        country: settings.country || undefined,
      },
    });
    return true;
  } catch (err) {
    console.warn(`[Admin Billing] Could not copy the billing address of workspace ${workspaceId} to Stripe:`, err);
    return false;
  }
}

async function ensureCustomer(ctx: AdminContext, workspace: WorkspaceRow): Promise<AdminStripeCustomer> {
  const key = stripeKey(ctx.env);
  if (workspace.stripeCustomerId) {
    const existing = await retrieveCustomerForAdmin(key, workspace.stripeCustomerId);
    if (!existing.deleted) return existing;
  }

  const created = (await createStripeCustomer(key, {
    name: workspace.name,
    email: await workspaceBillingEmail(ctx.masterDb, workspace.id),
    metadata: { workspaceId: workspace.id, clerkOrgId: workspace.clerkOrgId ?? '' },
  })) as { id: string };
  await ctx.masterDb
    .update(workspaces)
    .set({ stripeCustomerId: created.id, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));
  return retrieveCustomerForAdmin(key, created.id);
}

/** The subscription the workspace row points at, when Stripe still bills it. */
async function liveSubscription(key: string, workspace: WorkspaceRow): Promise<AdminStripeSubscription | null> {
  if (!workspace.stripeSubscriptionId) return null;
  try {
    const sub = await retrieveSubscriptionForAdmin(key, workspace.stripeSubscriptionId);
    return LIVE_SUBSCRIPTION_STATUSES.has(sub.status) ? sub : null;
  } catch (err) {
    console.warn(`[Admin Billing] Could not load subscription ${workspace.stripeSubscriptionId}:`, err);
    return null;
  }
}

/** Mirror a subscription's own state onto the workspace row. */
function subscriptionColumns(sub: AdminStripeSubscription) {
  const period = subscriptionPeriod(sub);
  const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
  return {
    subscriptionStatus: sub.status,
    subscriptionCycle: interval === 'year' ? 'yearly' : 'monthly',
    subscriptionCurrentPeriodStart: unixToDate(period.start),
    subscriptionCurrentPeriodEnd: unixToDate(period.end),
    subscriptionCancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

// ============================================================================
// Read: live Stripe snapshot
// ============================================================================

export interface PaymentMethodSummary {
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface InvoiceSummary {
  id: string;
  status: string | null;
  amountDueCents: number;
  currency: string;
  hostedUrl: string | null;
}

export interface StripeSnapshot {
  customer: {
    id: string;
    email: string | null;
    name: string | null;
    balanceCents: number;
    currency: string | null;
    hasAddress: boolean;
    defaultPaymentMethod: PaymentMethodSummary | null;
  } | null;
  subscription: {
    id: string;
    status: string;
    priceId: string | null;
    unitAmountCents: number | null;
    currency: string | null;
    interval: string | null;
    quantity: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    cancelAt: string | null;
    trialEnd: string | null;
    collectionMethod: CollectionMethod;
    daysUntilDue: number | null;
    automaticTax: boolean;
    paymentMethod: PaymentMethodSummary | null;
    discount: {
      couponId: string;
      name: string | null;
      percentOff: number | null;
      amountOffCents: number | null;
      currency: string | null;
      duration: string;
      durationInMonths: number | null;
      endsAt: string | null;
    } | null;
    latestInvoice: InvoiceSummary | null;
  } | null;
  /** Parts that could not be loaded; the rest of the snapshot is still valid. */
  errors: string[];
}

function paymentMethodSummary(pm: AdminStripePaymentMethod | null): PaymentMethodSummary | null {
  if (!pm) return null;
  return {
    type: pm.type,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? pm.sepa_debit?.last4 ?? null,
    expMonth: pm.card?.exp_month ?? null,
    expYear: pm.card?.exp_year ?? null,
  };
}

function invoiceSummary(invoice: AdminStripeInvoice | null): InvoiceSummary | null {
  if (!invoice) return null;
  return {
    id: invoice.id,
    status: invoice.status,
    amountDueCents: invoice.amount_due,
    currency: invoice.currency,
    hostedUrl: invoice.hosted_invoice_url ?? null,
  };
}

function isoFromUnix(seconds: number | null | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function getStripeSnapshot(env: Env, masterDb: MasterDb, workspaceId: string): Promise<StripeSnapshot> {
  const workspace = await loadWorkspace(masterDb, workspaceId);
  const key = stripeKey(env);
  const snapshot: StripeSnapshot = { customer: null, subscription: null, errors: [] };

  if (workspace.stripeCustomerId) {
    try {
      const customer = await retrieveCustomerForAdmin(key, workspace.stripeCustomerId);
      if (customer.deleted) {
        snapshot.errors.push('The Stripe customer has been deleted');
      } else {
        snapshot.customer = {
          id: customer.id,
          email: customer.email ?? null,
          name: customer.name ?? null,
          balanceCents: customer.balance ?? 0,
          currency: customer.currency ?? null,
          hasAddress: Boolean(customer.address?.country),
          defaultPaymentMethod: paymentMethodSummary(
            expanded(customer.invoice_settings?.default_payment_method),
          ),
        };
      }
    } catch (err) {
      snapshot.errors.push(`Customer: ${errorText(err)}`);
    }
  }

  if (workspace.stripeSubscriptionId) {
    try {
      const sub = await retrieveSubscriptionForAdmin(key, workspace.stripeSubscriptionId);
      const item = sub.items?.data?.[0];
      const discount = subscriptionCoupon(sub);
      snapshot.subscription = {
        id: sub.id,
        status: sub.status,
        priceId: item?.price.id ?? null,
        unitAmountCents: item?.price.unit_amount ?? null,
        currency: item?.price.currency ?? null,
        interval: item?.price.recurring?.interval ?? null,
        quantity: item?.quantity ?? 0,
        currentPeriodEnd: isoFromUnix(subscriptionPeriod(sub).end),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        cancelAt: isoFromUnix(sub.cancel_at),
        trialEnd: isoFromUnix(sub.trial_end),
        collectionMethod: sub.collection_method ?? 'charge_automatically',
        daysUntilDue: sub.days_until_due ?? null,
        automaticTax: Boolean(sub.automatic_tax?.enabled),
        paymentMethod: paymentMethodSummary(expanded(sub.default_payment_method)),
        discount: discount
          ? {
              couponId: discount.coupon.id,
              name: discount.coupon.name,
              percentOff: discount.coupon.percent_off,
              amountOffCents: discount.coupon.amount_off,
              currency: discount.coupon.currency,
              duration: discount.coupon.duration,
              durationInMonths: discount.coupon.duration_in_months,
              endsAt: isoFromUnix(discount.end),
            }
          : null,
        latestInvoice: invoiceSummary(expanded(sub.latest_invoice)),
      };
    } catch (err) {
      snapshot.errors.push(`Subscription: ${errorText(err)}`);
    }
  }

  return snapshot;
}

// ============================================================================
// Subscription: change plan / cycle / seats, or start one
// ============================================================================

export interface SubscriptionChangeInput {
  planId: string;
  cycle: 'monthly' | 'yearly';
  seats: number;
  proration: ProrationBehavior;
  /** Only used when a new subscription is started, or to switch an existing one. */
  collectionMethod?: CollectionMethod;
  daysUntilDue?: number;
}

export interface SubscriptionChangeResult {
  subscriptionId: string;
  created: boolean;
  status: string;
  latestInvoice: InvoiceSummary | null;
  before: { planId: string | null; seats: number; cycle: string | null };
  after: { planId: string; seats: number; cycle: string };
  warnings: string[];
}

async function validateSeatsAgainstMembers(ctx: AdminContext, workspace: WorkspaceRow, seats: number): Promise<void> {
  if (!workspace.clerkOrgId) return;
  const members = await getMemberCount(ctx.env, ctx.masterDb, workspace.clerkOrgId, workspace.id);
  if (seats < members) {
    throw new AdminBillingError(
      'BAD_REQUEST',
      `This workspace has ${members} billable members, so it needs at least ${members} seats.`,
    );
  }
}

export async function previewSubscriptionChange(
  ctx: Omit<AdminContext, 'actor' | 'requestId' | 'reason'>,
  workspaceId: string,
  input: SubscriptionChangeInput,
): Promise<{ available: boolean; amountDueCents: number; currency: string; lines: Array<{ description: string; amountCents: number }> }> {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const plan = await loadPlan(ctx.masterDb, input.planId);
  const priceId = priceIdFor(plan, input.cycle);
  const key = stripeKey(ctx.env);
  if (!workspace.stripeCustomerId) return { available: false, amountDueCents: 0, currency: plan.currency, lines: [] };

  const sub = await liveSubscription(key, workspace);
  const item = sub ? await planItemOf(ctx.masterDb, sub) : null;
  const invoice = await previewSubscriptionInvoice(key, {
    customerId: workspace.stripeCustomerId,
    subscriptionId: sub?.id,
    itemId: item?.id,
    priceId,
    quantity: input.seats,
    prorationBehavior: input.proration,
  });
  return {
    available: true,
    amountDueCents: invoice.amount_due,
    currency: invoice.currency,
    lines: (invoice.lines?.data ?? []).slice(0, 12).map((line) => ({
      description: line.description ?? '',
      amountCents: line.amount,
    })),
  };
}

export async function changeSubscription(
  ctx: AdminContext,
  workspaceId: string,
  input: SubscriptionChangeInput,
): Promise<SubscriptionChangeResult> {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  if (isCompActive(workspace)) {
    throw new AdminBillingError(
      'CONFLICT',
      'This workspace is on a comp plan. End the comp before changing its subscription.',
    );
  }
  const plan = await loadPlan(ctx.masterDb, input.planId);
  const priceId = priceIdFor(plan, input.cycle);
  assertSeatsWithinPlan(plan, input.seats);
  await validateSeatsAgainstMembers(ctx, workspace, input.seats);

  const key = stripeKey(ctx.env);
  const warnings: string[] = [];
  const metadata = { workspaceId: workspace.id, planId: plan.id, seats: String(input.seats) };
  const before = {
    planId: workspace.planId,
    seats: workspace.purchasedSeats,
    cycle: workspace.subscriptionCycle,
  };

  const customer = await ensureCustomer(ctx, workspace);
  let hasAddress = Boolean(customer.address?.country);
  const isPaid = Number.parseFloat(plan.priceMonthly) > 0 || Number.parseFloat(plan.priceYearly) > 0;

  const current = await liveSubscription(key, workspace);
  let sub: AdminStripeSubscription;
  let created = false;

  if (current) {
    const item = await planItemOf(ctx.masterDb, current);
    const needsTax = isPaid && !current.automatic_tax?.enabled;
    if (needsTax && !hasAddress) hasAddress = await syncCustomerAddress(ctx.env, key, workspace.id, customer.id);
    if (needsTax && !hasAddress) {
      warnings.push('Tax is not calculated automatically: the customer has no billing address in Stripe.');
    }
    sub = await updateSubscriptionPlanItem(
      key,
      current.id,
      {
        itemId: item.id,
        priceId,
        quantity: input.seats,
        prorationBehavior: input.proration,
        collectionMethod: input.collectionMethod,
        daysUntilDue: input.daysUntilDue,
        automaticTax: needsTax && hasAddress,
        metadata,
      },
      idempotencyKey(ctx, 'subscription.update'),
    );
  } else {
    if (isPaid && !hasAddress) hasAddress = await syncCustomerAddress(ctx.env, key, workspace.id, customer.id);
    if (isPaid && !hasAddress) {
      warnings.push('Tax is not calculated automatically: the customer has no billing address in Stripe.');
    }
    const hasPaymentMethod = Boolean(customer.invoice_settings?.default_payment_method);
    const collectionMethod = input.collectionMethod ?? (hasPaymentMethod ? 'charge_automatically' : 'send_invoice');
    if (isPaid && collectionMethod === 'charge_automatically' && !hasPaymentMethod) {
      throw new AdminBillingError(
        'BAD_REQUEST',
        'The customer has no saved payment method to charge. Choose "Send invoice" instead.',
      );
    }
    sub = await createAdminSubscription(
      key,
      {
        customerId: customer.id,
        priceId,
        quantity: input.seats,
        collectionMethod,
        daysUntilDue: input.daysUntilDue,
        automaticTax: isPaid && hasAddress,
        metadata,
      },
      idempotencyKey(ctx, 'subscription.create'),
    );
    created = true;
  }

  const active = sub.status === 'active' || sub.status === 'trialing';
  await ctx.masterDb
    .update(workspaces)
    .set({
      planId: plan.id,
      stripeSubscriptionId: sub.id,
      purchasedSeats: input.seats,
      ...subscriptionColumns(sub),
      ...(active ? liftedPaywall(workspace) : {}),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspace.id));

  if (workspace.planId !== plan.id) {
    await syncSubscriptionCredits(ctx.env, ctx.masterDb, workspace.id, workspace.clerkOrgId ?? '', plan.id);
  }
  await trySyncClerkSeatLimit(
    ctx.env,
    ctx.masterDb,
    workspace.clerkOrgId,
    workspace.id,
    plan,
    input.seats,
    'admin subscription change',
  );

  const latestInvoice = invoiceSummary(expanded(sub.latest_invoice));
  if (latestInvoice && latestInvoice.status === 'open' && latestInvoice.amountDueCents > 0) {
    warnings.push('The invoice for this change is still open (not paid yet).');
  }

  return {
    subscriptionId: sub.id,
    created,
    status: sub.status,
    latestInvoice,
    before,
    after: { planId: plan.id, seats: input.seats, cycle: input.cycle },
    warnings,
  };
}

// ============================================================================
// Subscription: cancel / reactivate / trial
// ============================================================================

export async function cancelSubscription(
  ctx: AdminContext,
  workspaceId: string,
  mode: 'period_end' | 'immediately',
): Promise<{ subscriptionId: string; mode: string; endsAt: string | null; outcome?: SubscriptionEndedOutcome | 'kept_comp' }> {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const subscriptionId = requireSubscriptionId(workspace);
  const key = stripeKey(ctx.env);

  if (mode === 'period_end') {
    const sub = await setCancelAtPeriodEnd(key, subscriptionId, true);
    await ctx.masterDb
      .update(workspaces)
      .set({ subscriptionCancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    return { subscriptionId, mode, endsAt: isoFromUnix(subscriptionPeriod(sub).end) };
  }

  // Unlink first so the deleted-subscription webhook is a no-op (module docs).
  await ctx.masterDb
    .update(workspaces)
    .set({ stripeSubscriptionId: null, updatedAt: new Date() })
    .where(and(eq(workspaces.id, workspace.id), eq(workspaces.stripeSubscriptionId, subscriptionId)));
  try {
    await cancelSubscriptionNow(key, subscriptionId);
  } catch (err) {
    await ctx.masterDb
      .update(workspaces)
      .set({ stripeSubscriptionId: subscriptionId, updatedAt: new Date() })
      .where(and(eq(workspaces.id, workspace.id), isNull(workspaces.stripeSubscriptionId)));
    throw err;
  }

  if (isCompActive(workspace)) {
    await detachEndedSubscriptionFromComp(ctx.masterDb, workspace.id);
    return { subscriptionId, mode, endsAt: new Date().toISOString(), outcome: 'kept_comp' };
  }
  const outcome = await applySubscriptionEnded(ctx.env, ctx.masterDb, { ...workspace, stripeSubscriptionId: null });
  return { subscriptionId, mode, endsAt: new Date().toISOString(), outcome };
}

export async function reactivateSubscription(ctx: AdminContext, workspaceId: string): Promise<{ subscriptionId: string }> {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const subscriptionId = requireSubscriptionId(workspace);
  await setCancelAtPeriodEnd(stripeKey(ctx.env), subscriptionId, false);
  await ctx.masterDb
    .update(workspaces)
    .set({ subscriptionCancelAtPeriodEnd: false, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));
  return { subscriptionId };
}

export async function setTrialEnd(
  ctx: AdminContext,
  workspaceId: string,
  trialEnd: Date,
): Promise<{ subscriptionId: string; trialEnd: string; status: string }> {
  const now = Date.now();
  if (trialEnd.getTime() < now + HOUR_MS) {
    throw new AdminBillingError('BAD_REQUEST', 'The trial must end at least an hour from now.');
  }
  if (trialEnd.getTime() > now + MAX_TRIAL_DAYS * DAY_MS) {
    throw new AdminBillingError('BAD_REQUEST', 'Stripe allows a trial of at most two years.');
  }
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const subscriptionId = requireSubscriptionId(workspace);
  const sub = await setSubscriptionTrialEnd(
    stripeKey(ctx.env),
    subscriptionId,
    Math.floor(trialEnd.getTime() / 1000),
    idempotencyKey(ctx, 'subscription.trial'),
  );
  await ctx.masterDb
    .update(workspaces)
    .set({ ...subscriptionColumns(sub), ...liftedPaywall(workspace), updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));
  return { subscriptionId, trialEnd: trialEnd.toISOString(), status: sub.status };
}

// ============================================================================
// Subscription: discounts
// ============================================================================

export interface DiscountInput {
  percentOff?: number;
  amountOffCents?: number;
  duration: 'once' | 'repeating' | 'forever';
  durationInMonths?: number;
}

function discountName(input: DiscountInput, currency: string): string {
  const amount =
    input.percentOff !== undefined
      ? `${input.percentOff}% off`
      : `${((input.amountOffCents ?? 0) / 100).toFixed(2)} ${currency.toUpperCase()} off`;
  const span =
    input.duration === 'forever'
      ? 'forever'
      : input.duration === 'once'
        ? 'once'
        : `for ${input.durationInMonths ?? 1} months`;
  return `${amount} ${span}`;
}

export async function applyDiscount(
  ctx: AdminContext,
  workspaceId: string,
  input: DiscountInput,
): Promise<{ subscriptionId: string; couponId: string; name: string }> {
  if ((input.percentOff === undefined) === (input.amountOffCents === undefined)) {
    throw new AdminBillingError('BAD_REQUEST', 'Give either a percentage or a fixed amount off.');
  }
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const subscriptionId = requireSubscriptionId(workspace);
  const key = stripeKey(ctx.env);
  const sub = await retrieveSubscriptionForAdmin(key, subscriptionId);
  const currency = sub.items?.data?.[0]?.price.currency ?? 'eur';
  const name = discountName(input, currency);

  const coupon = await createCoupon(
    key,
    {
      percentOff: input.percentOff,
      amountOffCents: input.amountOffCents,
      currency,
      duration: input.duration,
      durationInMonths: input.durationInMonths,
      name,
      metadata: { workspaceId: workspace.id, createdBy: ctx.actor.email, source: 'admin-console' },
    },
    idempotencyKey(ctx, 'discount.coupon'),
  );
  await applySubscriptionCoupon(key, subscriptionId, coupon.id, idempotencyKey(ctx, 'discount.apply'));
  return { subscriptionId, couponId: coupon.id, name };
}

export async function removeDiscount(ctx: AdminContext, workspaceId: string): Promise<{ subscriptionId: string }> {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const subscriptionId = requireSubscriptionId(workspace);
  await clearSubscriptionDiscounts(stripeKey(ctx.env), subscriptionId);
  return { subscriptionId };
}

// ============================================================================
// Comp plans
// ============================================================================

export interface CompInput {
  planId: string;
  seats: number;
  endsAt: Date | null;
  cancelStripeSubscription: boolean;
}

export async function grantComp(
  ctx: AdminContext,
  workspaceId: string,
  input: CompInput,
): Promise<{
  planId: string;
  seats: number;
  endsAt: string | null;
  canceledSubscriptionId: string | null;
  before: { planId: string | null; seats: number };
  warnings: string[];
}> {
  if (input.endsAt && input.endsAt.getTime() < Date.now() + HOUR_MS) {
    throw new AdminBillingError('BAD_REQUEST', 'The comp must end at least an hour from now.');
  }
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const plan = await loadPlan(ctx.masterDb, input.planId);
  assertSeatsWithinPlan(plan, input.seats);

  const warnings: string[] = [];
  const subscriptionId = workspace.stripeSubscriptionId;
  const keepsSubscription = Boolean(subscriptionId) && !input.cancelStripeSubscription;

  // Comp first: from here on the webhooks leave plan and seats alone, so the
  // cancellation below cannot downgrade the workspace.
  await ctx.masterDb
    .update(workspaces)
    .set({
      planId: plan.id,
      purchasedSeats: input.seats,
      compGrantedAt: new Date(),
      compEndsAt: input.endsAt,
      compGrantedBy: ctx.actor.email,
      compReason: ctx.reason,
      ...liftedPaywall(workspace),
      // Without a subscription the platform should read "active", not "canceled".
      ...(keepsSubscription ? {} : { subscriptionStatus: null }),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspace.id));

  let canceledSubscriptionId: string | null = null;
  if (subscriptionId && input.cancelStripeSubscription) {
    try {
      await cancelSubscriptionNow(stripeKey(ctx.env), subscriptionId);
      await detachEndedSubscriptionFromComp(ctx.masterDb, workspace.id);
      canceledSubscriptionId = subscriptionId;
    } catch (err) {
      warnings.push(`The comp is active, but cancelling the Stripe subscription failed: ${errorText(err)}`);
    }
  }

  if (workspace.planId !== plan.id) {
    await syncSubscriptionCredits(ctx.env, ctx.masterDb, workspace.id, workspace.clerkOrgId ?? '', plan.id);
  }
  await trySyncClerkSeatLimit(ctx.env, ctx.masterDb, workspace.clerkOrgId, workspace.id, plan, input.seats, 'comp grant');

  return {
    planId: plan.id,
    seats: input.seats,
    endsAt: input.endsAt?.toISOString() ?? null,
    canceledSubscriptionId,
    before: { planId: workspace.planId, seats: workspace.purchasedSeats },
    warnings,
  };
}

export type CompEndedOutcome = SubscriptionEndedOutcome | 'resumed_subscription';

/**
 * End a comp (from the console, or the sweep when `compEndsAt` passes). A
 * still-billing Stripe subscription takes over plan and seats again;
 * otherwise the workspace is treated like one whose subscription ended.
 */
export async function endCompForWorkspace(
  env: Env,
  masterDb: MasterDb,
  workspace: WorkspaceRow,
): Promise<{ outcome: CompEndedOutcome; planId: string | null }> {
  if (!workspace.compGrantedAt) throw new AdminBillingError('CONFLICT', 'This workspace has no comp plan');

  await masterDb
    .update(workspaces)
    .set({ compGrantedAt: null, compEndsAt: null, compGrantedBy: null, compReason: null, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));
  const cleared: WorkspaceRow = { ...workspace, compGrantedAt: null, compEndsAt: null, compGrantedBy: null, compReason: null };

  const sub = env.STRIPE_SECRET_KEY ? await liveSubscription(env.STRIPE_SECRET_KEY, cleared) : null;
  if (sub && RESUMABLE_SUBSCRIPTION_STATUSES.has(sub.status)) {
    const item = await planItemOf(masterDb, sub);
    const product = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
    const plan = await findPlanForStripePrice(masterDb, item.price.id, product);
    const seats = item.quantity ?? 0;
    await masterDb
      .update(workspaces)
      .set({
        ...(plan ? { planId: plan.id } : {}),
        purchasedSeats: seats,
        ...subscriptionColumns(sub),
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspace.id));
    if (plan && plan.id !== workspace.planId) {
      await syncSubscriptionCredits(env, masterDb, workspace.id, workspace.clerkOrgId ?? '', plan.id);
    }
    await trySyncClerkSeatLimit(env, masterDb, workspace.clerkOrgId, workspace.id, plan, seats, 'comp end');
    return { outcome: 'resumed_subscription', planId: plan?.id ?? workspace.planId };
  }

  const outcome = await applySubscriptionEnded(env, masterDb, cleared);
  const [after] = await masterDb
    .select({ planId: workspaces.planId })
    .from(workspaces)
    .where(eq(workspaces.id, workspace.id));
  return { outcome, planId: after?.planId ?? null };
}

export async function endComp(ctx: AdminContext, workspaceId: string) {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const result = await endCompForWorkspace(ctx.env, ctx.masterDb, workspace);
  return { ...result, before: { planId: workspace.planId, compEndsAt: workspace.compEndsAt?.toISOString() ?? null } };
}

// ============================================================================
// Credits
// ============================================================================

export async function adjustCredits(
  ctx: AdminContext,
  workspaceId: string,
  amount: number,
): Promise<{ transactionId: string; newBalance: number; duplicate: boolean }> {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const result = await grantCredits(ctx.masterDb, {
    workspaceId: workspace.id,
    amount,
    type: 'adjustment',
    idempotencyKey: idempotencyKey(ctx, 'credits.adjust'),
    description: `${amount > 0 ? 'Granted' : 'Deducted'} by WeldSuite: ${ctx.reason}`,
    metadata: {
      reason: 'admin_adjustment',
      adminEmail: ctx.actor.email,
      adminUserId: ctx.actor.userId ?? undefined,
      adminNote: ctx.reason,
    },
  });
  return { transactionId: result.transactionId, newBalance: result.newBalance, duplicate: result.duplicate };
}

// ============================================================================
// Payments and invoices
// ============================================================================

export async function refundPayment(
  ctx: AdminContext,
  workspaceId: string,
  paymentId: string,
  amountCents: number | undefined,
): Promise<{ refundId: string; amountCents: number; currency: string; status: string | null }> {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const [payment] = await ctx.masterDb
    .select()
    .from(billingPayments)
    .where(and(eq(billingPayments.id, paymentId), eq(billingPayments.workspaceId, workspace.id)))
    .limit(1);
  if (!payment) throw new AdminBillingError('NOT_FOUND', 'Payment not found');
  if (payment.status !== 'succeeded') {
    throw new AdminBillingError('CONFLICT', 'Only succeeded payments can be refunded');
  }
  const refundable = payment.amount - payment.refundedAmount;
  if (refundable <= 0) throw new AdminBillingError('CONFLICT', 'This payment has already been refunded in full');
  const amount = amountCents ?? refundable;
  if (amount < 1 || amount > refundable) {
    throw new AdminBillingError(
      'BAD_REQUEST',
      `The refund must be between 0.01 and ${(refundable / 100).toFixed(2)} ${payment.currency.toUpperCase()}.`,
    );
  }

  const refund = await createRefund(
    stripeKey(ctx.env),
    {
      paymentIntentId: payment.stripePaymentIntentId,
      chargeId: payment.stripeChargeId,
      amountCents: amount,
      metadata: { workspaceId: workspace.id, paymentId: payment.id, refundedBy: ctx.actor.email },
    },
    idempotencyKey(ctx, 'payment.refund'),
  );

  if (refund.status !== 'failed' && refund.status !== 'canceled') {
    await ctx.masterDb
      .update(billingPayments)
      .set({ refundedAmount: payment.refundedAmount + refund.amount, updatedAt: new Date() })
      .where(eq(billingPayments.id, payment.id));
  }
  return { refundId: refund.id, amountCents: refund.amount, currency: refund.currency, status: refund.status };
}

export async function voidInvoice(
  ctx: AdminContext,
  workspaceId: string,
  invoiceId: string,
): Promise<{ stripeInvoiceId: string; status: string | null }> {
  const workspace = await loadWorkspace(ctx.masterDb, workspaceId);
  const [invoice] = await ctx.masterDb
    .select()
    .from(billingInvoices)
    .where(and(eq(billingInvoices.id, invoiceId), eq(billingInvoices.workspaceId, workspace.id)))
    .limit(1);
  if (!invoice) throw new AdminBillingError('NOT_FOUND', 'Invoice not found');
  if (invoice.status !== 'open') throw new AdminBillingError('CONFLICT', 'Only open invoices can be voided');

  const voided = await voidStripeInvoice(
    stripeKey(ctx.env),
    invoice.stripeInvoiceId,
    idempotencyKey(ctx, 'invoice.void'),
  );
  await ctx.masterDb
    .update(billingInvoices)
    .set({ status: voided.status ?? 'void', updatedAt: new Date() })
    .where(eq(billingInvoices.id, invoice.id));
  return { stripeInvoiceId: invoice.stripeInvoiceId, status: voided.status };
}
