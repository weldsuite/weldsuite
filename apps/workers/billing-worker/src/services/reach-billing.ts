/**
 * WeldReach inbox billing: one Stripe subscription per workspace, one price
 * ($5 per inbox per month, docs/plans/weldreach.md "Billing"), quantity = the
 * number of inboxes. The subscription id and its status live on the master
 * `workspace_app_access` row of the workspace's `weldreach` access.
 *
 * Decisions:
 *  - Cancellation timing: at the last inbox the subscription is cancelled
 *    immediately (like phone billing), never at period end. With no inbox left
 *    nothing can send, so `billingStatus: 'canceled'` pauses nothing. The
 *    canceled subscription id stays on the row so a late webhook for it can be
 *    told apart from the next subscription.
 *  - Quantity changes use Stripe's default proration (`create_prorations`).
 *  - The price is created lazily and found again through a Stripe `lookup_key`,
 *    unless `STRIPE_PRICE_WELDREACH_INBOX` pins one.
 *  - Quantity changes are serialised per workspace with a Postgres advisory
 *    lock (read-modify-write of an absolute quantity would lose updates when
 *    reach-api creates several mailboxes at once).
 *  - Idempotency: a quantity change carries `metadata[lastOp] = "<mailboxId>:<delta>"`
 *    on the subscription item in the same Stripe request. A retry of the same
 *    operation (reach-api timed out after Stripe applied it) sees its own
 *    marker and changes nothing. Subscription creation uses a Stripe
 *    idempotency key built from workspace + mailbox + previous subscription +
 *    payment method.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  WELDREACH_APP_CODE,
  WELDREACH_INBOX_CURRENCY,
  WELDREACH_INBOX_PRICE_CENTS,
} from '@weldsuite/app-api-client/schemas/reach';
import type { AppAccessBillingStatus } from '@weldsuite/db/schema/master';
import type { Env } from '../index';
import { masterSchema, type getMasterDb } from '../lib/db';
import {
  cancelSubscriptionImmediately,
  createStripeCustomer,
  createStripeProduct,
  listPaymentMethods,
  retrieveCustomer,
  retrieveSubscription,
  setCustomerDefaultPaymentMethod,
  stripeApiRequest,
} from '../lib/stripe';

const { workspaces, workspaceAppAccess } = masterSchema;

/** `metadata.type` on the Stripe subscription (and its invoices' line items). */
export const REACH_SUBSCRIPTION_TYPE = 'weldreach';

/** Stripe price `lookup_key` of the lazily created inbox price. Bump the suffix to change the amount. */
export const REACH_INBOX_PRICE_LOOKUP_KEY = 'weldreach_inbox_monthly_v1';

export type MasterDb = ReturnType<typeof getMasterDb>;
/** What the billing logic needs from the DB: the handle itself or a transaction on it. */
export type ReachDb = Pick<MasterDb, 'select' | 'update'>;

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type AppAccessRow = typeof workspaceAppAccess.$inferSelect;

export interface ReachSubscriptionItem {
  id: string;
  quantity?: number | null;
  metadata?: Record<string, string> | null;
  price?: { id: string } | null;
  current_period_end?: number | null;
}

export interface ReachStripeSubscription {
  id: string;
  status: string;
  customer?: string | { id: string } | null;
  current_period_end?: number | null;
  metadata?: Record<string, string> | null;
  items?: { data?: ReachSubscriptionItem[] };
}

// ============================================================================
// Status helpers
// ============================================================================

/** Stripe subscription status -> WeldReach billing status; null = leave the row alone. */
export function mapStripeSubscriptionStatus(status: string): Exclude<AppAccessBillingStatus, 'none'> | null {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}

export function isLiveSubscriptionStatus(status: string | undefined): boolean {
  return status === 'active' || status === 'trialing';
}

export function isDelinquentSubscriptionStatus(status: string | undefined): boolean {
  return status === 'past_due' || status === 'unpaid';
}

function isEndedSubscriptionStatus(status: string | undefined): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

/** Stripe API errors surface as `Stripe API <METHOD> <path> failed (<status>): ...`. */
export function isStripeNotFound(err: unknown): boolean {
  return err instanceof Error && /failed \(404\)/.test(err.message);
}

export function subscriptionItem(subscription: ReachStripeSubscription): ReachSubscriptionItem | null {
  return subscription.items?.data?.[0] ?? null;
}

export function subscriptionQuantity(subscription: ReachStripeSubscription): number {
  return subscriptionItem(subscription)?.quantity ?? 0;
}

export function subscriptionPeriodEnd(subscription: ReachStripeSubscription): string | null {
  const seconds = subscription.current_period_end ?? subscriptionItem(subscription)?.current_period_end ?? null;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

// ============================================================================
// Master DB
// ============================================================================

export async function findWorkspaceByOrg(db: ReachDb, clerkOrgId: string): Promise<WorkspaceRow | null> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.clerkOrgId, clerkOrgId)).limit(1);
  return workspace ?? null;
}

export async function findReachAccess(db: ReachDb, workspaceId: string): Promise<AppAccessRow | null> {
  const [row] = await db
    .select()
    .from(workspaceAppAccess)
    .where(and(eq(workspaceAppAccess.workspaceId, workspaceId), eq(workspaceAppAccess.appCode, WELDREACH_APP_CODE)))
    .limit(1);
  return row ?? null;
}

/**
 * Run `fn` holding a per-workspace advisory lock for the length of a
 * transaction, so two quantity changes of one workspace never interleave.
 */
export async function withReachBillingLock<T>(
  db: MasterDb,
  workspaceId: string,
  fn: (tx: ReachDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '20s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`weldreach-billing:${workspaceId}`}))`);
    return fn(tx);
  });
}

/** The 55P03 lock_timeout error, possibly wrapped by the driver. */
export function isLockTimeout(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current; depth++) {
    if ((current as { code?: unknown }).code === '55P03') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Persist the subscription id and billing status. `billingStatusAt` is "since
 * when" (the payment grace period counts from it), so it only moves when the
 * status does, never on a repeated event for the same status.
 */
export async function saveReachSubscription(
  db: ReachDb,
  row: AppAccessRow,
  update: { subscriptionId?: string; status: Exclude<AppAccessBillingStatus, 'none'> },
): Promise<void> {
  const now = new Date();
  await db
    .update(workspaceAppAccess)
    .set({
      ...(update.subscriptionId ? { stripeSubscriptionId: update.subscriptionId } : {}),
      billingStatus: update.status,
      billingStatusAt: row.billingStatus === update.status ? row.billingStatusAt : now,
      updatedAt: now,
    })
    .where(eq(workspaceAppAccess.id, row.id));
}

// ============================================================================
// Stripe: customer, payment method, price
// ============================================================================

/** The workspace's Stripe customer id, created (and persisted) when missing. */
export async function ensureStripeCustomer(
  stripeKey: string,
  db: ReachDb,
  workspace: WorkspaceRow,
  clerkOrgId: string,
): Promise<string> {
  if (workspace.stripeCustomerId) return workspace.stripeCustomerId;

  const customer = await createStripeCustomer(
    stripeKey,
    { name: workspace.name, metadata: { workspaceId: workspace.id, clerkOrgId } },
    `weldreach-customer:${workspace.id}`,
  );
  const customerId: string = customer.id;

  await db
    .update(workspaces)
    .set({ stripeCustomerId: customerId, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));

  return customerId;
}

/**
 * The customer's invoice default payment method, else its first card.
 * With `adopt` the first card becomes the default (setup-mode Checkout attaches
 * a card without making it the default, and the subscription bills the default).
 */
export async function findOffSessionPaymentMethod(
  stripeKey: string,
  customerId: string,
  options: { adopt: boolean },
): Promise<string | null> {
  const customer = await retrieveCustomer(stripeKey, customerId);
  const existing = customer.invoice_settings?.default_payment_method;
  const existingId = typeof existing === 'string' ? existing : (existing?.id ?? null);
  if (existingId) return existingId;

  const listed = await listPaymentMethods(stripeKey, customerId);
  const firstId = listed.data?.[0]?.id as string | undefined;
  if (!firstId) return null;

  if (options.adopt) await setCustomerDefaultPaymentMethod(stripeKey, customerId, firstId);
  return firstId;
}

async function findPriceByLookupKey(stripeKey: string): Promise<string | null> {
  const query = `lookup_keys%5B%5D=${encodeURIComponent(REACH_INBOX_PRICE_LOOKUP_KEY)}&active=true&limit=1`;
  const result = await stripeApiRequest(stripeKey, 'GET', `/v1/prices?${query}`);
  const id = result?.data?.[0]?.id;
  return typeof id === 'string' ? id : null;
}

/** The inbox price: pinned by env, else found by lookup key, else created (once per Stripe account). */
export async function resolveInboxPriceId(
  env: Pick<Env, 'STRIPE_SECRET_KEY' | 'STRIPE_PRICE_WELDREACH_INBOX'>,
): Promise<string> {
  const pinned = env.STRIPE_PRICE_WELDREACH_INBOX?.trim();
  if (pinned) return pinned;

  const stripeKey = env.STRIPE_SECRET_KEY;
  const existing = await findPriceByLookupKey(stripeKey);
  if (existing) return existing;

  try {
    const product = await createStripeProduct(stripeKey, {
      name: 'WeldReach inbox',
      metadata: { type: REACH_SUBSCRIPTION_TYPE, appCode: WELDREACH_APP_CODE, managedBy: 'weldsuite' },
    });
    const price = await stripeApiRequest(stripeKey, 'POST', '/v1/prices', {
      product: product.id,
      unit_amount: String(WELDREACH_INBOX_PRICE_CENTS),
      currency: WELDREACH_INBOX_CURRENCY,
      'recurring[interval]': 'month',
      lookup_key: REACH_INBOX_PRICE_LOOKUP_KEY,
      nickname: 'WeldReach inbox, per month',
    });
    return price.id as string;
  } catch (err) {
    // A concurrent request created the price first (lookup keys are unique).
    const raced = await findPriceByLookupKey(stripeKey);
    if (raced) return raced;
    throw err;
  }
}

// ============================================================================
// Stripe: subscription
// ============================================================================

/**
 * The workspace's live WeldReach subscription. Looks at the stored id first;
 * without one (or when it ended) it searches the customer's subscriptions, so a
 * subscription whose id never reached the row is found again instead of
 * duplicated.
 */
export async function findReachSubscription(
  stripeKey: string,
  params: { storedId: string | null; customerId: string | null; workspaceId: string },
): Promise<ReachStripeSubscription | null> {
  if (params.storedId) {
    try {
      const stored: ReachStripeSubscription = await retrieveSubscription(stripeKey, params.storedId);
      if (!isEndedSubscriptionStatus(stored.status)) return stored;
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
  const candidates: ReachStripeSubscription[] = listed?.data ?? [];
  return (
    candidates.find(
      (sub) =>
        sub.metadata?.type === REACH_SUBSCRIPTION_TYPE &&
        (!sub.metadata.workspaceId || sub.metadata.workspaceId === params.workspaceId) &&
        !isEndedSubscriptionStatus(sub.status) &&
        sub.status !== 'incomplete',
    ) ?? null
  );
}

export function inboxOperationId(mailboxId: string, delta: 1 | -1): string {
  return `${mailboxId}:${delta}`;
}

/** True when the item already carries this operation's marker (the call is a retry). */
export function operationAlreadyApplied(subscription: ReachStripeSubscription, operationId: string): boolean {
  return subscriptionItem(subscription)?.metadata?.lastOp === operationId;
}

export async function createReachSubscription(
  stripeKey: string,
  params: {
    customerId: string;
    priceId: string;
    workspaceId: string;
    clerkOrgId: string;
    operationId: string;
    idempotencyKey: string;
  },
): Promise<ReachStripeSubscription> {
  return stripeApiRequest(
    stripeKey,
    'POST',
    '/v1/subscriptions',
    {
      customer: params.customerId,
      'items[0][price]': params.priceId,
      'items[0][quantity]': '1',
      'items[0][metadata][lastOp]': params.operationId,
      // The customer's default payment method pays; a card that cannot be charged fails here, not later.
      payment_behavior: 'error_if_incomplete',
      'metadata[type]': REACH_SUBSCRIPTION_TYPE,
      'metadata[workspaceId]': params.workspaceId,
      'metadata[clerkOrgId]': params.clerkOrgId,
      'metadata[appCode]': WELDREACH_APP_CODE,
    },
    { idempotencyKey: params.idempotencyKey },
  );
}

export async function setReachQuantity(
  stripeKey: string,
  itemId: string,
  quantity: number,
  operationId: string,
): Promise<void> {
  await stripeApiRequest(stripeKey, 'POST', `/v1/subscription_items/${encodeURIComponent(itemId)}`, {
    quantity: String(quantity),
    proration_behavior: 'create_prorations',
    'metadata[lastOp]': operationId,
  });
}

export async function cancelReachSubscription(stripeKey: string, subscriptionId: string): Promise<void> {
  await cancelSubscriptionImmediately(stripeKey, subscriptionId);
}
