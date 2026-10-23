/**
 * The SSO add-on: one Stripe subscription per workspace, one item, at the list
 * price (€100 / $100 a month, `@weldsuite/app-api-client/schemas/sso`) or at a
 * price staff set for the workspace. Its state is mirrored onto the master
 * `workspace_sso` row; entitlement and the Clerk SAML connection follow from
 * that row (`@weldsuite/core-domain/sso`).
 *
 * Decisions:
 *  - Who can buy: a directly billed workspace on a paid plan whose plan does
 *    not include SSO and that staff did not make free. Free workspaces upgrade
 *    first; partner-managed ones are billed by their partner (staff can still
 *    grant SSO for free).
 *  - The customer's default payment method pays and a card that cannot be
 *    charged fails the request (`error_if_incomplete`), like the other add-ons.
 *  - Cancelling from Settings ends the add-on at period end; staff can also
 *    end it at once (prorated credit).
 *  - A staff price is charged as inline `price_data` on the SSO product. On a
 *    running subscription it applies from the next invoice (no proration).
 *    Price 0 means free: the override is written first, then the subscription
 *    is cancelled, so its cancellation webhook cannot switch SSO off (the same
 *    order as comps, BILL-011).
 *  - The list price is created lazily (EUR, with a USD currency option) and
 *    found again by `lookup_key`, unless `STRIPE_PRICE_SSO` pins one.
 *  - Billing changes of one workspace are serialised with an advisory lock.
 *  - The subscription carries `metadata.type = weldsuite_sso`; its events
 *    never reach the plan, seat or credit handling in routes/webhooks.ts.
 */

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { createClerkClient } from '@clerk/backend';
import {
  SSO_ADDON_CURRENCY,
  SSO_ADDON_PRICE_CENTS,
  SSO_ADDON_USD_PRICE_CENTS,
  SSO_ERRORS,
  ssoAddonListPrice,
  type SsoAddonUnavailableReason,
  type SsoAdminView,
  type SsoBillingView,
  type SsoPriceCurrency,
} from '@weldsuite/app-api-client/schemas/sso';
import {
  deleteSsoConnection,
  ensureSsoRow,
  loadSsoContext,
  reconcileSsoConnection,
  ssoEntitlement,
  updateSsoRow,
  type SsoClerkClient,
  type SsoContext,
  type SsoDb,
} from '@weldsuite/core-domain/sso';
import type { SsoSubscriptionStatus, WorkspaceSso } from '@weldsuite/db/schema/master';
import type { Env } from '../index';
import { masterSchema } from '../lib/db';
import { cancelSubscriptionImmediately, createStripeProduct, retrieveCustomer, retrieveSubscription, stripeApiRequest } from '../lib/stripe';
import type { StripeInvoice } from '../types/stripe';
import {
  ensureStripeCustomer,
  findOffSessionPaymentMethod,
  isStripeNotFound,
  type MasterDb,
  type ReachDb,
  type ReachStripeSubscription,
  type WorkspaceRow,
} from './reach-billing';

const { workspaces, workspaceSso, plans } = masterSchema;

/** `metadata.type` on the Stripe subscription (and its invoices' line items). */
export const SSO_SUBSCRIPTION_TYPE = 'weldsuite_sso';

/** Stripe price `lookup_key` of the lazily created list price. Bump the suffix to change the amount. */
export const SSO_PRICE_LOOKUP_KEY = 'weldsuite_sso_monthly_v1';

type BillingEnv = Pick<Env, 'STRIPE_SECRET_KEY' | 'STRIPE_PRICE_SSO'>;

/** The master DB handle or a transaction on it: what core-domain/sso and the reach-billing helpers both take. */
export type SsoBillingDb = SsoDb & ReachDb;

/** A refusal the caller can act on; routes map it to `{ error: { code, message } }` with `status`. */
export class SsoBillingError extends Error {
  constructor(
    readonly status: 400 | 402 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SsoBillingError';
  }
}

export interface SsoStripeSubscription extends ReachStripeSubscription {
  cancel_at_period_end?: boolean;
  currency?: string | null;
  items?: {
    data?: Array<{
      id: string;
      quantity?: number | null;
      current_period_end?: number | null;
      metadata?: Record<string, string> | null;
      price?: { id: string; unit_amount?: number | null; currency?: string | null; product?: string | null } | null;
    }>;
  };
}

// ============================================================================
// Clerk
// ============================================================================

/** The Clerk client for SAML connections, or null when Clerk is not configured here. */
export function ssoClerkClient(env: Pick<Env, 'CLERK_SECRET_KEY'>): SsoClerkClient | null {
  if (!env.CLERK_SECRET_KEY) return null;
  return createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
}

/**
 * Bring the Clerk connection in line after a billing change. Never throws: the
 * billing change is already saved, and the hourly sweep retries a failure.
 */
export async function reconcileAfterBillingChange(
  env: Pick<Env, 'CLERK_SECRET_KEY'>,
  db: SsoBillingDb,
  workspaceId: string,
  actor: string,
): Promise<string | null> {
  try {
    const clerk = ssoClerkClient(env);
    if (!clerk) return 'Clerk is not configured, so the SSO connection was not updated.';
    const ctx = await loadSsoContext(db, { workspaceId });
    if (!ctx) return null;
    const { outcome } = await reconcileSsoConnection(db, clerk, ctx, actor);
    if (outcome === 'activated' || outcome === 'deactivated') {
      console.log(`[SSO Billing] Workspace ${workspaceId} connection ${outcome}`);
    }
    return null;
  } catch (err) {
    console.error(`[SSO Billing] Reconciling the connection of workspace ${workspaceId} failed:`, err);
    return `Updating the SSO connection in Clerk failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ============================================================================
// Master DB
// ============================================================================

/** Run `fn` holding a per-workspace advisory lock for the length of a transaction. */
export async function withSsoBillingLock<T>(db: MasterDb, workspaceId: string, fn: (tx: SsoBillingDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '20s'`);
    const lockKey = `sso-billing:${workspaceId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return fn(tx as unknown as SsoBillingDb);
  });
}

async function loadPlan(db: SsoBillingDb, planId: string | null) {
  if (!planId) return null;
  const [plan] = await db
    .select({ slug: plans.slug, priceMonthly: plans.priceMonthly, pricePerUser: plans.pricePerUser })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  return plan ?? null;
}

/** A plan someone pays for (not Free). */
export function isPaidPlan(plan: { slug: string; priceMonthly: string | null; pricePerUser: string | null } | null): boolean {
  if (!plan || plan.slug === 'free') return false;
  return Number(plan.pricePerUser ?? 0) > 0 || Number(plan.priceMonthly ?? 0) > 0;
}

/** Why the workspace cannot buy the add-on, or null when it can. */
export async function addonUnavailableReason(db: SsoBillingDb, ctx: SsoContext): Promise<SsoAddonUnavailableReason | null> {
  if (ctx.planIncludesSso) return 'INCLUDED_IN_PLAN';
  if (ctx.row?.priceOverrideCents === 0) return 'FREE_GRANT';
  if (ctx.workspace.billingMode === 'partner') return 'PARTNER_MANAGED';
  if (!isPaidPlan(await loadPlan(db, ctx.workspace.planId))) return 'FREE_PLAN';
  return null;
}

// ============================================================================
// Subscription state
// ============================================================================

/** Stripe subscription status -> `workspace_sso.subscription_status`; null = leave the row alone. */
export function mapSsoSubscriptionStatus(status: string): Exclude<SsoSubscriptionStatus, 'none'> | null {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    // Not final: paying the open invoice brings the subscription back to active.
    case 'unpaid':
      return 'unpaid';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}

/** A row status whose subscription still exists in Stripe (whether or not it entitles). */
function isLiveRowStatus(status: SsoSubscriptionStatus): status is 'active' | 'past_due' | 'unpaid' {
  return status === 'active' || status === 'past_due' || status === 'unpaid';
}

function periodEnd(subscription: SsoStripeSubscription): Date | null {
  const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end ?? null;
  return seconds ? new Date(seconds * 1000) : null;
}

/**
 * Mirror a subscription onto the row. Returns the saved row, or null when the
 * event was ignored: `canceled` is final for a subscription id, and an event
 * about another subscription while the row tracks a live one is stale.
 */
export async function applySsoSubscription(
  db: SsoBillingDb,
  row: WorkspaceSso,
  subscription: SsoStripeSubscription,
): Promise<WorkspaceSso | null> {
  const next = mapSsoSubscriptionStatus(subscription.status);
  if (!next) return null;

  const tracksIt = row.stripeSubscriptionId === subscription.id;
  const tracksAnotherLive = !tracksIt && Boolean(row.stripeSubscriptionId) && isLiveRowStatus(row.subscriptionStatus);
  if (tracksAnotherLive) return null;
  if (tracksIt && row.subscriptionStatus === 'canceled' && next !== 'canceled') return null;
  // A cancelled subscription the row never tracked changes nothing.
  if (!tracksIt && next === 'canceled') return null;

  const statusChanged = !tracksIt || row.subscriptionStatus !== next;
  return updateSsoRow(db, row.id, {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: next,
    subscriptionStatusAt: statusChanged ? new Date() : row.subscriptionStatusAt,
    subscriptionCurrentPeriodEnd: periodEnd(subscription),
    subscriptionCancelAtPeriodEnd: next === 'canceled' ? false : Boolean(subscription.cancel_at_period_end),
  });
}

/** Record a subscription this worker just cancelled, whether or not the row tracked it yet. */
async function markSsoSubscriptionCanceled(db: SsoBillingDb, row: WorkspaceSso, subscriptionId: string): Promise<WorkspaceSso> {
  return updateSsoRow(db, row.id, {
    stripeSubscriptionId: subscriptionId,
    subscriptionStatus: 'canceled',
    subscriptionStatusAt: new Date(),
    subscriptionCancelAtPeriodEnd: false,
  });
}

function isLive(status: string): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due' || status === 'unpaid';
}

/**
 * The workspace's live SSO subscription: by the stored id, else by searching
 * the customer's subscriptions, so one whose id never reached the row is found
 * again instead of duplicated.
 */
export async function findSsoSubscription(
  stripeKey: string,
  params: { storedId: string | null; customerId: string | null; workspaceId: string },
): Promise<SsoStripeSubscription | null> {
  if (params.storedId) {
    try {
      const stored: SsoStripeSubscription = await retrieveSubscription(stripeKey, params.storedId);
      if (isLive(stored.status)) return stored;
    } catch (err) {
      if (!isStripeNotFound(err)) throw err;
    }
  }
  if (!params.customerId) return null;

  // Stripe leaves canceled subscriptions out of this list by default.
  const listed = await stripeApiRequest(
    stripeKey,
    'GET',
    `/v1/subscriptions?customer=${encodeURIComponent(params.customerId)}&limit=100`,
  );
  const candidates: SsoStripeSubscription[] = listed?.data ?? [];
  return (
    candidates.find(
      (sub) =>
        sub.metadata?.type === SSO_SUBSCRIPTION_TYPE &&
        (!sub.metadata.workspaceId || sub.metadata.workspaceId === params.workspaceId) &&
        isLive(sub.status),
    ) ?? null
  );
}

// ============================================================================
// Price
// ============================================================================

async function findListPriceByLookupKey(stripeKey: string): Promise<string | null> {
  const query = `lookup_keys%5B%5D=${encodeURIComponent(SSO_PRICE_LOOKUP_KEY)}&active=true&limit=1`;
  const result = await stripeApiRequest(stripeKey, 'GET', `/v1/prices?${query}`);
  const id = result?.data?.[0]?.id;
  return typeof id === 'string' ? id : null;
}

/** The list price: pinned by env, else found by lookup key, else created (once per Stripe account). */
export async function resolveSsoListPriceId(env: BillingEnv): Promise<string> {
  const pinned = env.STRIPE_PRICE_SSO?.trim();
  if (pinned) return pinned;

  const stripeKey = env.STRIPE_SECRET_KEY;
  const existing = await findListPriceByLookupKey(stripeKey);
  if (existing) return existing;

  try {
    const product = await createStripeProduct(stripeKey, {
      name: 'WeldSuite single sign-on (SSO)',
      metadata: { type: SSO_SUBSCRIPTION_TYPE, managedBy: 'weldsuite' },
    });
    const price = await stripeApiRequest(stripeKey, 'POST', '/v1/prices', {
      product: product.id,
      unit_amount: String(SSO_ADDON_PRICE_CENTS),
      currency: SSO_ADDON_CURRENCY,
      'currency_options[usd][unit_amount]': String(SSO_ADDON_USD_PRICE_CENTS),
      'recurring[interval]': 'month',
      lookup_key: SSO_PRICE_LOOKUP_KEY,
      nickname: 'WeldSuite SSO, per month',
    });
    return price.id as string;
  } catch (err) {
    // A concurrent request created the price first (lookup keys are unique).
    const raced = await findListPriceByLookupKey(stripeKey);
    if (raced) return raced;
    throw err;
  }
}

/** The SSO product, for staff prices charged as `price_data`. */
async function resolveSsoProductId(env: BillingEnv, listPriceId: string): Promise<string> {
  const price = await stripeApiRequest(env.STRIPE_SECRET_KEY, 'GET', `/v1/prices/${encodeURIComponent(listPriceId)}`);
  const product = typeof price?.product === 'string' ? price.product : price?.product?.id;
  if (typeof product !== 'string') throw new Error(`SSO price ${listPriceId} has no product`);
  return product;
}

/** What the add-on is charged at: the list price, or a staff price. */
export type SsoCharge = { kind: 'list' } | { kind: 'custom'; unitAmountCents: number; currency: SsoPriceCurrency };

export function chargeFor(row: WorkspaceSso | null): SsoCharge {
  const cents = row?.priceOverrideCents;
  if (cents && cents > 0) {
    return { kind: 'custom', unitAmountCents: cents, currency: (row?.priceOverrideCurrency ?? SSO_ADDON_CURRENCY) as SsoPriceCurrency };
  }
  return { kind: 'list' };
}

/** Form fields that set an item's price, prefixed (`items[0]` on create, none on an item update). */
async function priceFields(env: BillingEnv, charge: SsoCharge, prefix: string): Promise<Record<string, string>> {
  const key = (name: string) => (prefix ? `${prefix}[${name}]` : name);
  const listPriceId = await resolveSsoListPriceId(env);
  if (charge.kind === 'list') return { [key('price')]: listPriceId };
  const productId = await resolveSsoProductId(env, listPriceId);
  return {
    [`${key('price_data')}[product]`]: productId,
    [`${key('price_data')}[currency]`]: charge.currency,
    [`${key('price_data')}[unit_amount]`]: String(charge.unitAmountCents),
    [`${key('price_data')}[recurring][interval]`]: 'month',
  };
}

/** Whether the subscription already charges `charge`. */
async function chargesAlready(env: BillingEnv, subscription: SsoStripeSubscription, charge: SsoCharge): Promise<boolean> {
  const price = subscription.items?.data?.[0]?.price;
  if (!price) return false;
  const listPriceId = await resolveSsoListPriceId(env);
  if (charge.kind === 'list') return price.id === listPriceId;
  return price.id !== listPriceId && price.unit_amount === charge.unitAmountCents && price.currency === charge.currency;
}

/** Stripe bills a customer in one currency; a staff price in another one would be refused. */
async function assertChargeCurrency(stripeKey: string, customerId: string | null, charge: SsoCharge): Promise<void> {
  if (charge.kind !== 'custom' || !customerId) return;
  const customer = await retrieveCustomer(stripeKey, customerId);
  if (customer.currency && customer.currency.toLowerCase() !== charge.currency) {
    throw new SsoBillingError(
      400,
      'CURRENCY_MISMATCH',
      `This customer is billed in ${customer.currency.toUpperCase()}; set the price in ${customer.currency.toUpperCase()}.`,
    );
  }
}

// ============================================================================
// Stripe writes
// ============================================================================

async function createSsoSubscription(
  env: BillingEnv,
  db: SsoBillingDb,
  workspace: WorkspaceRow,
  row: WorkspaceSso,
  charge: SsoCharge,
  idempotencyKey: string,
): Promise<WorkspaceSso> {
  const stripeKey = env.STRIPE_SECRET_KEY;
  const clerkOrgId = workspace.clerkOrgId ?? row.clerkOrgId;
  const customerId = await ensureStripeCustomer(stripeKey, db, workspace, clerkOrgId);
  await assertChargeCurrency(stripeKey, customerId, charge);

  const paymentMethodId = await findOffSessionPaymentMethod(stripeKey, customerId, { adopt: true });
  if (!paymentMethodId) {
    throw new SsoBillingError(402, SSO_ERRORS.PAYMENT_METHOD_REQUIRED, 'Add a payment method before adding single sign-on.');
  }

  const subscription: SsoStripeSubscription = await stripeApiRequest(
    stripeKey,
    'POST',
    '/v1/subscriptions',
    {
      customer: customerId,
      ...(await priceFields(env, charge, 'items[0]')),
      'items[0][quantity]': '1',
      // The customer's default payment method pays; a card that cannot be charged fails here, not later.
      payment_behavior: 'error_if_incomplete',
      'metadata[type]': SSO_SUBSCRIPTION_TYPE,
      'metadata[workspaceId]': workspace.id,
      'metadata[clerkOrgId]': clerkOrgId,
    },
    { idempotencyKey },
  );
  return (await applySsoSubscription(db, row, subscription)) ?? row;
}

async function repriceSsoSubscription(env: BillingEnv, subscription: SsoStripeSubscription, charge: SsoCharge): Promise<void> {
  const item = subscription.items?.data?.[0];
  if (!item) throw new Error(`SSO subscription ${subscription.id} has no item`);
  await stripeApiRequest(env.STRIPE_SECRET_KEY, 'POST', `/v1/subscription_items/${encodeURIComponent(item.id)}`, {
    ...(await priceFields(env, charge, '')),
    // A new price applies from the next invoice.
    proration_behavior: 'none',
  });
}

async function setCancelAtPeriodEnd(stripeKey: string, subscriptionId: string, cancel: boolean): Promise<SsoStripeSubscription> {
  return stripeApiRequest(stripeKey, 'POST', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    cancel_at_period_end: String(cancel),
  });
}

// ============================================================================
// Workspace (Settings, Clerk JWT)
// ============================================================================

function liveRowSubscription(row: WorkspaceSso | null): SsoBillingView['subscription'] {
  if (!row?.stripeSubscriptionId || !isLiveRowStatus(row.subscriptionStatus)) return null;
  return {
    status: row.subscriptionStatus,
    currentPeriodEnd: row.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.subscriptionCancelAtPeriodEnd,
  };
}

/** The add-on as the workspace sees it, priced in the currency Stripe bills it in. */
export async function ssoBillingSummary(
  env: BillingEnv,
  db: SsoBillingDb,
  workspace: WorkspaceRow,
  ctx: SsoContext,
): Promise<SsoBillingView> {
  const entitlement = ssoEntitlement(ctx);
  const unavailableReason = await addonUnavailableReason(db, ctx);
  const subscription = liveRowSubscription(ctx.row);
  const charge = chargeFor(ctx.row);

  // Stripe is only asked when the answer changes what the page offers.
  const needsCustomer = unavailableReason === null && Boolean(workspace.stripeCustomerId);
  const customer = needsCustomer ? await retrieveCustomer(env.STRIPE_SECRET_KEY, workspace.stripeCustomerId!) : null;
  const hasPaymentMethod =
    needsCustomer && !subscription
      ? Boolean(await findOffSessionPaymentMethod(env.STRIPE_SECRET_KEY, workspace.stripeCustomerId!, { adopt: false }))
      : false;

  const price =
    charge.kind === 'custom'
      ? { unitAmountCents: charge.unitAmountCents, currency: charge.currency, custom: true }
      : { ...ssoAddonListPrice(customer?.currency), custom: false };

  return {
    entitlement,
    price,
    purchasable: unavailableReason === null && !subscription,
    unavailableReason,
    subscription,
    hasPaymentMethod,
  };
}

/** Start the add-on for a workspace admin. Call inside `withSsoBillingLock`. */
export async function subscribeToSso(
  env: BillingEnv,
  db: SsoBillingDb,
  workspace: WorkspaceRow,
  options: { canSpend: boolean },
): Promise<void> {
  if (!options.canSpend) {
    throw new SsoBillingError(403, SSO_ERRORS.BILLING_ADMIN_REQUIRED, 'Only workspace admins can add single sign-on.');
  }
  const ctx = await loadSsoContext(db, { workspaceId: workspace.id });
  if (!ctx) throw new SsoBillingError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  const unavailable = await addonUnavailableReason(db, ctx);
  if (unavailable) {
    throw new SsoBillingError(409, SSO_ERRORS.ADDON_UNAVAILABLE, addonUnavailableMessage(unavailable));
  }

  const row = ctx.row ?? (await ensureSsoRow(db, ctx.workspace));
  const live = await findSsoSubscription(env.STRIPE_SECRET_KEY, {
    storedId: row.stripeSubscriptionId,
    customerId: workspace.stripeCustomerId,
    workspaceId: workspace.id,
  });
  if (live?.status === 'unpaid') {
    // Starting another one would leave the overdue invoice behind; paying it brings SSO back.
    throw new SsoBillingError(
      402,
      SSO_ERRORS.SUBSCRIPTION_UNPAID,
      'The single sign-on invoice is overdue. Pay it under Billing to switch single sign-on back on.',
    );
  }
  if (live) {
    // A double click, or one whose id never reached the row: adopt it, nothing to buy.
    await applySsoSubscription(db, row, live);
    return;
  }

  // One key per attempt: the lock and the lookup above prevent a second
  // subscription, and a reused key would replay an earlier, since cancelled one.
  await createSsoSubscription(env, db, workspace, row, chargeFor(row), `sso:${workspace.id}:${crypto.randomUUID()}`);
}

export function addonUnavailableMessage(reason: SsoAddonUnavailableReason): string {
  switch (reason) {
    case 'INCLUDED_IN_PLAN':
      return 'Single sign-on is included in your plan.';
    case 'FREE_GRANT':
      return 'Single sign-on is already included at no charge.';
    case 'PARTNER_MANAGED':
      return 'This workspace is billed by its partner. Ask them to add single sign-on.';
    case 'FREE_PLAN':
      return 'Single sign-on is available on paid plans. Upgrade first.';
  }
}

/** End the add-on at period end (`cancel = true`) or undo that. Call inside `withSsoBillingLock`. */
export async function setSsoCancelAtPeriodEnd(
  env: BillingEnv,
  db: SsoBillingDb,
  workspace: WorkspaceRow,
  cancel: boolean,
  options: { canSpend: boolean },
): Promise<void> {
  if (!options.canSpend) {
    throw new SsoBillingError(403, SSO_ERRORS.BILLING_ADMIN_REQUIRED, 'Only workspace admins can change single sign-on billing.');
  }
  const ctx = await loadSsoContext(db, { workspaceId: workspace.id });
  const row = ctx?.row;
  const live = row
    ? await findSsoSubscription(env.STRIPE_SECRET_KEY, {
        storedId: row.stripeSubscriptionId,
        customerId: workspace.stripeCustomerId,
        workspaceId: workspace.id,
      })
    : null;
  if (!row || !live) {
    throw new SsoBillingError(409, SSO_ERRORS.NOT_SUBSCRIBED, 'This workspace has no single sign-on add-on to change.');
  }
  if (live.status === 'unpaid') {
    // SSO is already off and there is no paid period left to run out: cancelling ends it now.
    if (!cancel) {
      throw new SsoBillingError(
        402,
        SSO_ERRORS.SUBSCRIPTION_UNPAID,
        'The single sign-on invoice is overdue. Pay it under Billing to switch single sign-on back on.',
      );
    }
    await cancelSubscriptionImmediately(env.STRIPE_SECRET_KEY, live.id);
    await markSsoSubscriptionCanceled(db, row, live.id);
    return;
  }
  const updated = await setCancelAtPeriodEnd(env.STRIPE_SECRET_KEY, live.id, cancel);
  await applySsoSubscription(db, row, updated);
}

// ============================================================================
// Webhooks
// ============================================================================

/** Invoice fields that carry the subscription's metadata, depending on the Stripe API version. */
interface InvoiceWithSubscriptionMetadata extends StripeInvoice {
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  lines?: { data?: Array<{ metadata?: Record<string, string> | null }> } | null;
}

export function isSsoSubscription(subscription: { metadata?: Record<string, string> | null }): boolean {
  return subscription.metadata?.type === SSO_SUBSCRIPTION_TYPE;
}

/** The add-on's invoices grant no plan credits. */
export function isSsoInvoice(invoice: StripeInvoice): boolean {
  const withMetadata = invoice as InvoiceWithSubscriptionMetadata;
  if (withMetadata.subscription_details?.metadata?.type === SSO_SUBSCRIPTION_TYPE) return true;
  return Boolean(withMetadata.lines?.data?.some((line) => line.metadata?.type === SSO_SUBSCRIPTION_TYPE));
}

async function findRowForSubscription(
  db: SsoBillingDb,
  subscriptionId: string,
  metadataWorkspaceId: string | undefined,
): Promise<WorkspaceSso | null> {
  const [bySubscription] = await db
    .select()
    .from(workspaceSso)
    .where(eq(workspaceSso.stripeSubscriptionId, subscriptionId))
    .limit(1);
  if (bySubscription) return bySubscription;
  if (!metadataWorkspaceId) return null;

  const [workspace] = await db
    .select({ id: workspaces.id, clerkOrgId: workspaces.clerkOrgId })
    .from(workspaces)
    .where(eq(workspaces.id, metadataWorkspaceId))
    .limit(1);
  if (!workspace?.clerkOrgId) return null;
  return ensureSsoRow(db, workspace);
}

/**
 * `customer.subscription.created|updated|deleted`. Returns true when the
 * subscription is the SSO add-on (so the caller skips the plan handling).
 */
export async function handleSsoSubscriptionEvent(
  env: Pick<Env, 'CLERK_SECRET_KEY'>,
  db: SsoBillingDb,
  subscription: SsoStripeSubscription,
): Promise<boolean> {
  if (!isSsoSubscription(subscription)) return false;

  const row = await findRowForSubscription(db, subscription.id, subscription.metadata?.workspaceId);
  if (!row) {
    console.warn(`[SSO Billing] No workspace for subscription ${subscription.id}, ignoring`);
    return true;
  }

  const saved = await applySsoSubscription(db, row, subscription);
  if (saved) {
    console.log(`[SSO Billing] Workspace ${row.workspaceId} add-on ${saved.subscriptionStatus}`);
    await reconcileAfterBillingChange(env, db, row.workspaceId, 'stripe-webhook');
  }
  return true;
}

// ============================================================================
// Admin console
// ============================================================================

export interface SsoGrantInput {
  /** null = list price, 0 = free. */
  priceCents: number | null;
  currency: SsoPriceCurrency | null;
  /** Start the add-on now when the workspace has none (a paid price). */
  switchOn: boolean;
}

export interface SsoAdminResult {
  action: 'created' | 'repriced' | 'canceled' | 'scheduled_cancel' | 'none';
  subscriptionId: string | null;
  entitled: boolean;
  warnings: string[];
}

function assertGrantAllowed(workspace: WorkspaceRow, input: SsoGrantInput): void {
  const paid = input.priceCents === null || input.priceCents > 0;
  if (workspace.billingMode === 'partner' && paid && (input.switchOn || input.priceCents !== null)) {
    throw new SsoBillingError(
      409,
      'PARTNER_MANAGED',
      'Partner-managed workspaces are billed by their partner. Grant single sign-on for free (price 0) instead.',
    );
  }
  if (input.priceCents !== null && input.priceCents > 0 && !input.currency) {
    throw new SsoBillingError(400, 'BAD_REQUEST', 'Choose the currency of the price.');
  }
}

/** The workspace's running add-on, unless it is billed by a partner (it never has one). */
async function liveSubscriptionOf(
  env: BillingEnv,
  workspace: WorkspaceRow,
  row: WorkspaceSso,
): Promise<SsoStripeSubscription | null> {
  if (!env.STRIPE_SECRET_KEY || workspace.billingMode === 'partner') return null;
  return findSsoSubscription(env.STRIPE_SECRET_KEY, {
    storedId: row.stripeSubscriptionId,
    customerId: workspace.stripeCustomerId,
    workspaceId: workspace.id,
  });
}

/** After a staff change: bring Clerk in line and report the entitlement it left. */
async function finishAdminChange(
  env: Pick<Env, 'CLERK_SECRET_KEY'>,
  db: SsoBillingDb,
  workspaceId: string,
  actor: string,
  result: Omit<SsoAdminResult, 'entitled'>,
): Promise<SsoAdminResult> {
  const reconcileWarning = await reconcileAfterBillingChange(env, db, workspaceId, actor);
  const after = await loadSsoContext(db, { workspaceId });
  return {
    ...result,
    entitled: after ? ssoEntitlement(after).entitled : false,
    warnings: reconcileWarning ? [...result.warnings, reconcileWarning] : result.warnings,
  };
}

/** The Stripe side of a staff price: end, reprice or start the add-on. */
async function applyGrantToStripe(
  env: BillingEnv,
  db: SsoBillingDb,
  ctx: SsoContext,
  workspace: WorkspaceRow,
  row: WorkspaceSso,
  input: SsoGrantInput,
  charge: SsoCharge,
  requestId: string,
): Promise<Omit<SsoAdminResult, 'entitled'>> {
  const live = await liveSubscriptionOf(env, workspace, row);

  if (live && input.priceCents === 0) {
    await cancelSubscriptionImmediately(env.STRIPE_SECRET_KEY, live.id);
    await markSsoSubscriptionCanceled(db, row, live.id);
    return { action: 'canceled', subscriptionId: live.id, warnings: [] };
  }
  if (live) {
    await applySsoSubscription(db, row, live);
    if (await chargesAlready(env, live, charge)) return { action: 'none', subscriptionId: live.id, warnings: [] };
    await repriceSsoSubscription(env, live, charge);
    return { action: 'repriced', subscriptionId: live.id, warnings: [] };
  }
  if (!input.switchOn || input.priceCents === 0) {
    return { action: 'none', subscriptionId: row.stripeSubscriptionId, warnings: [] };
  }
  if (ctx.planIncludesSso) {
    return {
      action: 'none',
      subscriptionId: null,
      warnings: ['The plan already includes single sign-on, so no add-on was started.'],
    };
  }
  if (!env.STRIPE_SECRET_KEY) throw new SsoBillingError(503, 'NOT_CONFIGURED', 'Stripe is not configured.');
  const created = await createSsoSubscription(env, db, workspace, row, charge, `admin:sso.grant:${requestId}`);
  return { action: 'created', subscriptionId: created.stripeSubscriptionId, warnings: [] };
}

/**
 * Set the workspace's SSO price and, with `switchOn`, start the add-on. Call
 * inside `withSsoBillingLock`; `actor` and `reason` go on the row.
 */
export async function grantSsoPrice(
  env: BillingEnv & Pick<Env, 'CLERK_SECRET_KEY'>,
  db: SsoBillingDb,
  workspace: WorkspaceRow,
  input: SsoGrantInput,
  meta: { actor: string; reason: string; requestId: string },
): Promise<SsoAdminResult> {
  assertGrantAllowed(workspace, input);
  const ctx = await loadSsoContext(db, { workspaceId: workspace.id });
  if (!ctx) throw new SsoBillingError(404, 'NOT_FOUND', 'Workspace not found.');

  const custom = input.priceCents !== null && input.priceCents > 0;
  const charge: SsoCharge = custom
    ? { kind: 'custom', unitAmountCents: input.priceCents!, currency: input.currency! }
    : { kind: 'list' };
  if (env.STRIPE_SECRET_KEY) await assertChargeCurrency(env.STRIPE_SECRET_KEY, workspace.stripeCustomerId, charge);

  // The price first: with 0 the cancellation that follows cannot switch SSO off.
  const row = await updateSsoRow(db, (ctx.row ?? (await ensureSsoRow(db, ctx.workspace))).id, {
    priceOverrideCents: input.priceCents,
    priceOverrideCurrency: custom ? input.currency : null,
    priceOverrideSetBy: meta.actor,
    priceOverrideSetAt: new Date(),
    priceOverrideReason: meta.reason,
  });

  const result = await applyGrantToStripe(env, db, ctx, workspace, row, input, charge, meta.requestId);
  return finishAdminChange(env, db, workspace.id, meta.actor, result);
}

/** Take SSO away: clear the price and end the add-on. Call inside `withSsoBillingLock`. */
export async function revokeSsoAddon(
  env: BillingEnv & Pick<Env, 'CLERK_SECRET_KEY'>,
  db: SsoBillingDb,
  workspace: WorkspaceRow,
  mode: 'period_end' | 'immediately',
  meta: { actor: string; reason: string },
): Promise<SsoAdminResult> {
  const ctx = await loadSsoContext(db, { workspaceId: workspace.id });
  const existing = ctx?.row ?? null;
  if (!ctx || !existing) throw new SsoBillingError(409, 'CONFLICT', 'This workspace has no single sign-on price or add-on.');

  const live = await liveSubscriptionOf(env, workspace, existing);
  if (existing.priceOverrideCents === null && !live) {
    const message = ctx.planIncludesSso
      ? 'Single sign-on comes with the plan; change the plan to take it away.'
      : 'This workspace has no single sign-on price or add-on.';
    throw new SsoBillingError(409, 'CONFLICT', message);
  }

  const row = await updateSsoRow(db, existing.id, {
    priceOverrideCents: null,
    priceOverrideCurrency: null,
    priceOverrideSetBy: meta.actor,
    priceOverrideSetAt: new Date(),
    priceOverrideReason: meta.reason,
  });

  let action: SsoAdminResult['action'] = 'none';
  if (live && mode === 'immediately') {
    await cancelSubscriptionImmediately(env.STRIPE_SECRET_KEY, live.id);
    await markSsoSubscriptionCanceled(db, row, live.id);
    action = 'canceled';
  } else if (live) {
    const updated = await setCancelAtPeriodEnd(env.STRIPE_SECRET_KEY, live.id, true);
    await applySsoSubscription(db, row, updated);
    action = 'scheduled_cancel';
  }

  return finishAdminChange(env, db, workspace.id, meta.actor, { action, subscriptionId: live?.id ?? null, warnings: [] });
}

/** Switch the connection off (support: a misconfigured IdP locking people out). The configuration stays. */
export async function disableSsoConnection(
  env: Pick<Env, 'CLERK_SECRET_KEY'>,
  db: SsoBillingDb,
  workspaceId: string,
  actor: string,
): Promise<{ wasEnabled: boolean }> {
  const ctx = await loadSsoContext(db, { workspaceId });
  const row = ctx?.row;
  if (!ctx || !row?.clerkConnectionId) {
    throw new SsoBillingError(409, 'CONFLICT', 'This workspace has no single sign-on connection.');
  }
  const clerk = ssoClerkClient(env);
  if (!clerk) throw new SsoBillingError(503, 'NOT_CONFIGURED', 'Clerk is not configured.');

  const saved = await updateSsoRow(db, row.id, { enabled: false, connectionUpdatedBy: actor, connectionUpdatedAt: new Date() });
  await reconcileSsoConnection(db, clerk, { ...ctx, row: saved }, actor);
  return { wasEnabled: row.enabled };
}

interface ChargedNow {
  customerCurrency: string | null;
  charged: { unitAmountCents: number | null; currency: string | null };
}

/** The customer's currency and what the running add-on charges, from Stripe; unknown when Stripe cannot be asked. */
async function chargedNow(env: BillingEnv, workspace: WorkspaceRow, row: WorkspaceSso | null): Promise<ChargedNow> {
  const unknown: ChargedNow = { customerCurrency: null, charged: { unitAmountCents: null, currency: null } };
  if (!env.STRIPE_SECRET_KEY || !workspace.stripeCustomerId) return unknown;
  try {
    const customerCurrency = (await retrieveCustomer(env.STRIPE_SECRET_KEY, workspace.stripeCustomerId)).currency ?? null;
    if (!liveRowSubscription(row) || !row?.stripeSubscriptionId) return { ...unknown, customerCurrency };

    const sub: SsoStripeSubscription = await retrieveSubscription(env.STRIPE_SECRET_KEY, row.stripeSubscriptionId);
    const price = sub.items?.data?.[0]?.price;
    const charged =
      price?.id === (await resolveSsoListPriceId(env))
        ? ssoAddonListPrice(sub.currency ?? customerCurrency)
        : { unitAmountCents: price?.unit_amount ?? null, currency: price?.currency ?? null };
    return { customerCurrency, charged };
  } catch (err) {
    console.warn(`[SSO Billing] Stripe lookup for the admin view of ${workspace.id} failed:`, err);
    return unknown;
  }
}

/** The admin console's view; Stripe is asked for the price actually charged. */
export async function ssoAdminView(env: BillingEnv, db: SsoBillingDb, workspace: WorkspaceRow): Promise<SsoAdminView> {
  const ctx = await loadSsoContext(db, { workspaceId: workspace.id });
  if (!ctx) throw new SsoBillingError(404, 'NOT_FOUND', 'Workspace not found.');
  const row = ctx.row;
  const { customerCurrency, charged } = await chargedNow(env, workspace, row);

  return {
    entitlement: ssoEntitlement(ctx),
    planIncludesSso: ctx.planIncludesSso,
    billingMode: workspace.billingMode,
    listPrice: ssoAddonListPrice(customerCurrency),
    priceOverride:
      row?.priceOverrideCents != null
        ? {
            unitAmountCents: row.priceOverrideCents,
            currency: row.priceOverrideCurrency,
            setBy: row.priceOverrideSetBy,
            setAt: row.priceOverrideSetAt?.toISOString() ?? null,
            reason: row.priceOverrideReason,
          }
        : null,
    subscription:
      row?.stripeSubscriptionId && row.subscriptionStatus !== 'none'
        ? {
            id: row.stripeSubscriptionId,
            status: row.subscriptionStatus,
            currentPeriodEnd: row.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: row.subscriptionCancelAtPeriodEnd,
            ...charged,
          }
        : null,
    domain: row?.domain ? { name: row.domain, verified: Boolean(row.domainVerifiedAt) } : null,
    connection: row?.clerkConnectionId
      ? {
          provider: row.provider ?? 'saml_custom',
          enabled: row.enabled,
          active: row.clerkActive,
          updatedBy: row.connectionUpdatedBy,
          updatedAt: row.connectionUpdatedAt?.toISOString() ?? null,
        }
      : null,
  };
}

// ============================================================================
// Hourly sweep
// ============================================================================

const SWEEP_BATCH = 200;
const SWEEP_ACTOR = 'sso-sweep';

/**
 * A deleted workspace: remove its connection, end its add-on and give up its
 * domain, so the company can verify it again from a new workspace. Returns the
 * number of changes.
 */
async function sweepDeletedWorkspace(env: Env, db: SsoBillingDb, clerk: SsoClerkClient | null, row: WorkspaceSso): Promise<number> {
  let changed = 0;
  let connectionGone = !row.clerkConnectionId;
  if (row.clerkConnectionId && clerk) {
    await deleteSsoConnection(db, clerk, row, SWEEP_ACTOR);
    connectionGone = true;
    changed++;
  }
  if (row.stripeSubscriptionId && env.STRIPE_SECRET_KEY && row.subscriptionStatus !== 'canceled') {
    try {
      await cancelSubscriptionImmediately(env.STRIPE_SECRET_KEY, row.stripeSubscriptionId);
    } catch (err) {
      if (!isStripeNotFound(err)) throw err;
    }
    await updateSsoRow(db, row.id, { subscriptionStatus: 'canceled', subscriptionStatusAt: new Date() });
    changed++;
  }
  // Not while a Clerk connection may still send the domain's users to the IdP.
  if (row.domain && connectionGone) {
    await updateSsoRow(db, row.id, {
      domain: null,
      domainVerificationToken: null,
      domainVerifiedAt: null,
      connectionUpdatedBy: SWEEP_ACTOR,
      connectionUpdatedAt: new Date(),
    });
    changed++;
  }
  return changed;
}

/**
 * The plan now includes SSO (an upgrade to Enterprise): stop charging the
 * add-on. It runs out at period end, like a cancel from Settings, and the
 * plan carries SSO from then on. Returns the number of changes.
 */
async function endAddonIncludedInPlan(env: Env, db: MasterDb, ctx: SsoContext): Promise<number> {
  const row = ctx.row;
  if (!ctx.planIncludesSso || !env.STRIPE_SECRET_KEY) return 0;
  if (!row?.stripeSubscriptionId || !isLiveRowStatus(row.subscriptionStatus) || row.subscriptionCancelAtPeriodEnd) return 0;

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.workspace.id)).limit(1);
  if (!workspace) return 0;
  await withSsoBillingLock(db, workspace.id, (tx) => setSsoCancelAtPeriodEnd(env, tx, workspace, true, { canSpend: true }));
  console.log(`[SSO Sweep] Workspace ${workspace.id}: add-on ends at period end, the plan includes SSO`);
  return 1;
}

/** One row of the sweep. Returns the number of changes. */
async function sweepRow(env: Env, db: MasterDb, clerk: SsoClerkClient | null, row: WorkspaceSso): Promise<number> {
  const ctx = await loadSsoContext(db, { workspaceId: row.workspaceId });
  if (!ctx || ctx.workspace.deletedAt) return sweepDeletedWorkspace(env, db, clerk, row);

  // Clerk first: a Stripe failure below must not hold back who can sign in.
  let changed = 0;
  if (clerk && row.clerkConnectionId) {
    const { outcome } = await reconcileSsoConnection(db, clerk, ctx, SWEEP_ACTOR);
    if (outcome !== 'unchanged' && outcome !== 'no_connection') {
      console.log(`[SSO Sweep] Workspace ${row.workspaceId}: ${outcome}`);
      changed++;
    }
  }
  return changed + (await endAddonIncludedInPlan(env, db, ctx));
}

/**
 * Keep every Clerk connection's `active` equal to `enabled && entitled`
 * (plan changes, comps ending, a deletion being scheduled or cancelled all
 * change entitlement without an SSO event), end the add-on of a workspace
 * whose plan now includes SSO, and clean up after deleted workspaces: delete
 * their connections, end their add-on (the deletion sweep leaves it running)
 * and release their domain.
 */
export async function runSsoSweep(env: Env, db: MasterDb): Promise<{ checked: number; changed: number; failed: number }> {
  const deletedWorkspaces = db.select({ id: workspaces.id }).from(workspaces).where(isNotNull(workspaces.deletedAt));
  const rows = await db
    .select()
    .from(workspaceSso)
    .where(
      or(
        isNotNull(workspaceSso.clerkConnectionId),
        and(
          isNotNull(workspaceSso.stripeSubscriptionId),
          inArray(workspaceSso.subscriptionStatus, ['active', 'past_due', 'unpaid']),
        ),
        and(isNotNull(workspaceSso.domain), inArray(workspaceSso.workspaceId, deletedWorkspaces)),
      ),
    )
    .orderBy(workspaceSso.updatedAt)
    .limit(SWEEP_BATCH);

  const clerk = ssoClerkClient(env);
  let changed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      changed += await sweepRow(env, db, clerk, row);
    } catch (err) {
      failed++;
      console.error(`[SSO Sweep] Workspace ${row.workspaceId} failed:`, err);
    }
  }
  // Touch every row so the next run starts with the ones not looked at for longest.
  if (rows.length > 0) {
    await db
      .update(workspaceSso)
      .set({ updatedAt: new Date() })
      .where(inArray(workspaceSso.id, rows.map((row) => row.id)));
  }
  return { checked: rows.length, changed, failed };
}
