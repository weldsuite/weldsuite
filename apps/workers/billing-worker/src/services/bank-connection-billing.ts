/**
 * WeldBooks extra bank connections: the plan includes some
 * (`plans.features.includedBankConnections`, default 1), every connection above
 * that is billed on one Stripe subscription per workspace, quantity = the
 * extra connections (`@weldsuite/app-api-client/schemas/bank-connection-billing`).
 *
 * Decisions:
 *  - The count is ours, never the caller's: billing-worker counts the
 *    workspace's connections in the master `bank_feed_connection_index`
 *    (distinct connections; Stripe FC has a row per account). books-api writes
 *    a row when a bank is linked and removes it when the connection is
 *    disconnected or removed, so a row is exactly a connection that counts.
 *  - A change sets the absolute quantity from that count (a sync, not a +1/-1),
 *    so a retry or a missed call is put right by the next one. Changes are
 *    serialised per workspace with a Postgres advisory lock.
 *  - Raising the quantity commits the workspace to a charge: only a workspace
 *    admin may, and only with a payment method on file. Lowering it is open to
 *    any member, since it only follows connections that are gone.
 *  - At zero extra connections the subscription is cancelled immediately.
 *  - The subscription id is not stored: it is found again on the workspace's
 *    Stripe customer by `metadata.type`. Its webhooks never reach the plan,
 *    seat or credit handling (`isBankConnectionSubscription`).
 *  - The price is created lazily (EUR, with a USD currency option for
 *    customers billed in dollars) and found again through a `lookup_key`,
 *    unless `STRIPE_PRICE_BANK_CONNECTION` pins one.
 */

import { countDistinct, eq, sql } from 'drizzle-orm';
import {
  BANK_CONNECTION_BILLING_ADMIN_REQUIRED,
  BANK_CONNECTION_EXTRA_CURRENCY,
  BANK_CONNECTION_EXTRA_PRICE_CENTS,
  BANK_CONNECTION_EXTRA_USD_PRICE_CENTS,
  BANK_CONNECTION_PAYMENT_METHOD_REQUIRED,
  extraBankConnections,
  resolveIncludedBankConnections,
} from '@weldsuite/app-api-client/schemas/bank-connection-billing';
import type { Env } from '../index';
import { masterSchema } from '../lib/db';
import { cancelSubscriptionImmediately, createStripeProduct, stripeApiRequest } from '../lib/stripe';
import type { StripeInvoice, StripeSubscription } from '../types/stripe';
import {
  ensureStripeCustomer,
  findOffSessionPaymentMethod,
  subscriptionItem,
  subscriptionQuantity,
  type MasterDb,
  type ReachDb,
  type ReachStripeSubscription,
  type WorkspaceRow,
} from './reach-billing';

const { bankFeedConnectionIndex, plans } = masterSchema;

/** `metadata.type` on the Stripe subscription (and its invoices' line items). */
export const BANK_CONNECTION_SUBSCRIPTION_TYPE = 'weldbooks_bank_connections';

/** Stripe price `lookup_key` of the lazily created price. Bump the suffix to change the amount. */
export const BANK_CONNECTION_PRICE_LOOKUP_KEY = 'weldbooks_bank_connection_monthly_v1';

type BillingEnv = Pick<Env, 'STRIPE_SECRET_KEY' | 'STRIPE_PRICE_BANK_CONNECTION'>;

// ============================================================================
// Master DB
// ============================================================================

/** Connections that count for the workspace: one per tenant connection, whatever its index rows. */
export async function countBankConnections(db: ReachDb, clerkOrgId: string): Promise<number> {
  const [row] = await db
    .select({ count: countDistinct(bankFeedConnectionIndex.connectionId) })
    .from(bankFeedConnectionIndex)
    .where(eq(bankFeedConnectionIndex.clerkOrgId, clerkOrgId));
  return Number(row?.count ?? 0);
}

/** Connections the workspace's plan includes. */
export async function includedBankConnections(db: ReachDb, workspace: WorkspaceRow): Promise<number> {
  if (!workspace.planId) return resolveIncludedBankConnections(null);
  const [plan] = await db.select({ features: plans.features }).from(plans).where(eq(plans.id, workspace.planId)).limit(1);
  return resolveIncludedBankConnections(plan?.features as Record<string, unknown> | null | undefined);
}

/** Run `fn` holding a per-workspace advisory lock for the length of a transaction. */
export async function withBankConnectionBillingLock<T>(
  db: MasterDb,
  workspaceId: string,
  fn: (tx: ReachDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '20s'`);
    const lockKey = `bank-connection-billing:${workspaceId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return fn(tx);
  });
}

// ============================================================================
// Stripe
// ============================================================================

async function findPriceByLookupKey(stripeKey: string): Promise<string | null> {
  const query = `lookup_keys%5B%5D=${encodeURIComponent(BANK_CONNECTION_PRICE_LOOKUP_KEY)}&active=true&limit=1`;
  const result = await stripeApiRequest(stripeKey, 'GET', `/v1/prices?${query}`);
  const id = result?.data?.[0]?.id;
  return typeof id === 'string' ? id : null;
}

/** The extra-connection price: pinned by env, else found by lookup key, else created (once per Stripe account). */
export async function resolveBankConnectionPriceId(env: BillingEnv): Promise<string> {
  const pinned = env.STRIPE_PRICE_BANK_CONNECTION?.trim();
  if (pinned) return pinned;

  const stripeKey = env.STRIPE_SECRET_KEY;
  const existing = await findPriceByLookupKey(stripeKey);
  if (existing) return existing;

  try {
    const product = await createStripeProduct(stripeKey, {
      name: 'WeldBooks extra bank connection',
      metadata: { type: BANK_CONNECTION_SUBSCRIPTION_TYPE, managedBy: 'weldsuite' },
    });
    const price = await stripeApiRequest(stripeKey, 'POST', '/v1/prices', {
      product: product.id,
      unit_amount: String(BANK_CONNECTION_EXTRA_PRICE_CENTS),
      currency: BANK_CONNECTION_EXTRA_CURRENCY,
      'currency_options[usd][unit_amount]': String(BANK_CONNECTION_EXTRA_USD_PRICE_CENTS),
      'recurring[interval]': 'month',
      lookup_key: BANK_CONNECTION_PRICE_LOOKUP_KEY,
      nickname: 'WeldBooks extra bank connection, per month',
    });
    return price.id as string;
  } catch (err) {
    // A concurrent request created the price first (lookup keys are unique).
    const raced = await findPriceByLookupKey(stripeKey);
    if (raced) return raced;
    throw err;
  }
}

function isLiveOrPending(status: string): boolean {
  return status !== 'canceled' && status !== 'incomplete_expired' && status !== 'incomplete';
}

/** The workspace's extra-connection subscription on its Stripe customer, if any. */
export async function findBankConnectionSubscription(
  stripeKey: string,
  customerId: string | null,
  workspaceId: string,
): Promise<ReachStripeSubscription | null> {
  if (!customerId) return null;
  // Stripe leaves canceled subscriptions out of this list by default.
  const listed = await stripeApiRequest(
    stripeKey,
    'GET',
    `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&limit=100`,
  );
  const candidates: ReachStripeSubscription[] = listed?.data ?? [];
  return (
    candidates.find(
      (sub) =>
        sub.metadata?.type === BANK_CONNECTION_SUBSCRIPTION_TYPE &&
        (!sub.metadata.workspaceId || sub.metadata.workspaceId === workspaceId) &&
        isLiveOrPending(sub.status),
    ) ?? null
  );
}

// ============================================================================
// Sync
// ============================================================================

export type BankConnectionSyncOutcome =
  | { ok: true; connections: number; included: number; quantity: number }
  | { ok: false; status: 402 | 403; code: string; message: string };

/**
 * Set the Stripe quantity to the workspace's extra connections. Call it inside
 * `withBankConnectionBillingLock`. `canIncrease` is whether the caller may
 * commit the workspace to a higher charge (a workspace admin).
 */
export async function syncBankConnectionQuantity(
  env: BillingEnv,
  db: ReachDb,
  workspace: WorkspaceRow,
  clerkOrgId: string,
  options: { canIncrease: boolean },
): Promise<BankConnectionSyncOutcome> {
  const stripeKey = env.STRIPE_SECRET_KEY;
  const connections = await countBankConnections(db, clerkOrgId);
  const included = await includedBankConnections(db, workspace);
  const target = extraBankConnections(connections, included);

  const subscription = await findBankConnectionSubscription(stripeKey, workspace.stripeCustomerId, workspace.id);
  const current = subscription ? subscriptionQuantity(subscription) : 0;
  const done = { ok: true as const, connections, included, quantity: target };
  if (target === current) return done;

  if (target < current) {
    if (!subscription) return done;
    if (target === 0) {
      await cancelSubscriptionImmediately(stripeKey, subscription.id);
    } else {
      await setQuantity(stripeKey, subscription, target);
    }
    return done;
  }

  if (!options.canIncrease) {
    return {
      ok: false,
      status: 403,
      code: BANK_CONNECTION_BILLING_ADMIN_REQUIRED,
      message: 'Only workspace admins can add a bank connection that is billed on top of the plan.',
    };
  }

  const customerId = await ensureStripeCustomer(stripeKey, db, workspace, clerkOrgId);
  const paymentMethodId = await findOffSessionPaymentMethod(stripeKey, customerId, { adopt: true });
  if (!paymentMethodId) {
    return {
      ok: false,
      status: 402,
      code: BANK_CONNECTION_PAYMENT_METHOD_REQUIRED,
      message: 'Add a payment method before adding a bank connection that is billed on top of the plan.',
    };
  }

  if (subscription) {
    await setQuantity(stripeKey, subscription, target);
    return done;
  }

  const priceId = await resolveBankConnectionPriceId(env);
  await stripeApiRequest(
    stripeKey,
    'POST',
    '/v1/subscriptions',
    {
      customer: customerId,
      'items[0][price]': priceId,
      'items[0][quantity]': String(target),
      // The customer's default payment method pays; a card that cannot be charged fails here, not later.
      payment_behavior: 'error_if_incomplete',
      'metadata[type]': BANK_CONNECTION_SUBSCRIPTION_TYPE,
      'metadata[workspaceId]': workspace.id,
      'metadata[clerkOrgId]': clerkOrgId,
    },
    { idempotencyKey: `bank-connections:${workspace.id}:${target}:${paymentMethodId}` },
  );
  return done;
}

async function setQuantity(stripeKey: string, subscription: ReachStripeSubscription, quantity: number): Promise<void> {
  const item = subscriptionItem(subscription);
  if (!item) throw new Error(`Bank connection subscription ${subscription.id} has no item`);
  await stripeApiRequest(stripeKey, 'POST', `/v1/subscription_items/${encodeURIComponent(item.id)}`, {
    quantity: String(quantity),
    proration_behavior: 'create_prorations',
  });
}

// ============================================================================
// Webhooks
// ============================================================================

/** Invoice fields that carry the subscription's metadata, depending on the Stripe API version. */
interface InvoiceWithSubscriptionMetadata extends StripeInvoice {
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  lines?: { data?: Array<{ metadata?: Record<string, string> | null }> } | null;
}

/** The extra-connection subscription carries no plan, seat or credit state. */
export function isBankConnectionSubscription(subscription: Pick<StripeSubscription, 'metadata'>): boolean {
  return subscription.metadata?.type === BANK_CONNECTION_SUBSCRIPTION_TYPE;
}

export function isBankConnectionInvoice(invoice: StripeInvoice): boolean {
  const withMetadata = invoice as InvoiceWithSubscriptionMetadata;
  if (withMetadata.subscription_details?.metadata?.type === BANK_CONNECTION_SUBSCRIPTION_TYPE) return true;
  return Boolean(withMetadata.lines?.data?.some((line) => line.metadata?.type === BANK_CONNECTION_SUBSCRIPTION_TYPE));
}
