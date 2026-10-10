/**
 * Stripe calls behind the admin console's billing API (routes/admin.ts).
 *
 * Same raw-fetch style as ./stripe.ts. Every write takes an idempotency key
 * (derived from the console's per-submit request id), so a double-submitted
 * form cannot charge, refund or discount a customer twice.
 *
 * The shapes below are deliberately loose about API versions: the account's
 * default version decides whether period dates live on the subscription or on
 * its items, and whether a discount carries `coupon` or `source.coupon`.
 */

import { stripeApiRequest } from './stripe';

type Expandable<T extends { id: string }> = string | T | null | undefined;

export type ProrationBehavior = 'always_invoice' | 'create_prorations' | 'none';
export type CollectionMethod = 'charge_automatically' | 'send_invoice';

export interface AdminStripePrice {
  id: string;
  product: string | { id: string };
  unit_amount: number | null;
  currency: string;
  active: boolean;
  recurring: { interval: string } | null;
}

export interface AdminStripeSubscriptionItem {
  id: string;
  quantity?: number;
  price: AdminStripePrice;
  current_period_start?: number | null;
  current_period_end?: number | null;
}

export interface AdminStripeCoupon {
  id: string;
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever';
  duration_in_months: number | null;
}

export interface AdminStripeDiscount {
  id?: string;
  coupon?: AdminStripeCoupon | null;
  source?: { coupon?: Expandable<AdminStripeCoupon> } | null;
  end?: number | null;
}

export interface AdminStripePaymentMethod {
  id: string;
  type: string;
  card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } | null;
  sepa_debit?: { last4?: string } | null;
}

export interface AdminStripeInvoice {
  id: string;
  status: string | null;
  amount_due: number;
  total?: number;
  currency: string;
  hosted_invoice_url?: string | null;
  next_payment_attempt?: number | null;
  lines?: { data?: Array<{ description: string | null; amount: number }> };
}

export interface AdminStripeSubscription {
  id: string;
  status: string;
  customer: string | { id: string };
  cancel_at_period_end: boolean;
  cancel_at?: number | null;
  trial_end?: number | null;
  collection_method?: CollectionMethod;
  days_until_due?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  items: { data: AdminStripeSubscriptionItem[] };
  discount?: AdminStripeDiscount | null;
  discounts?: Array<string | AdminStripeDiscount>;
  default_payment_method?: Expandable<AdminStripePaymentMethod>;
  latest_invoice?: Expandable<AdminStripeInvoice>;
  automatic_tax?: { enabled?: boolean } | null;
  metadata: Record<string, string> | null;
}

export interface AdminStripeCustomer {
  id: string;
  deleted?: boolean;
  email?: string | null;
  name?: string | null;
  balance?: number;
  currency?: string | null;
  address?: { country?: string | null } | null;
  invoice_settings?: { default_payment_method?: Expandable<AdminStripePaymentMethod> } | null;
}

export interface AdminStripeRefund {
  id: string;
  amount: number;
  currency: string;
  status: string | null;
}

const enc = encodeURIComponent;

function addMetadata(body: Record<string, string>, metadata: Record<string, string> | undefined): void {
  for (const [k, v] of Object.entries(metadata ?? {})) body[`metadata[${k}]`] = v;
}

/** The expanded object behind an expandable field, or null when it is only an id. */
export function expanded<T extends { id: string }>(value: Expandable<T>): T | null {
  return value && typeof value === 'object' ? value : null;
}

/** Period end from the subscription, or from its first item on newer API versions. */
export function subscriptionPeriod(sub: AdminStripeSubscription): { start: number | null; end: number | null } {
  const item = sub.items?.data?.[0];
  return {
    start: sub.current_period_start ?? item?.current_period_start ?? null,
    end: sub.current_period_end ?? item?.current_period_end ?? null,
  };
}

/** The first coupon on a subscription, whichever discount shape the API version returns. */
export function subscriptionCoupon(sub: AdminStripeSubscription): {
  coupon: AdminStripeCoupon;
  end: number | null;
} | null {
  const candidates: AdminStripeDiscount[] = [];
  if (sub.discount) candidates.push(sub.discount);
  for (const d of sub.discounts ?? []) if (typeof d === 'object') candidates.push(d);
  for (const d of candidates) {
    const coupon = d.coupon ?? expanded(d.source?.coupon);
    if (coupon) return { coupon, end: d.end ?? null };
  }
  return null;
}

// ============================================================================
// Reads
// ============================================================================

export async function retrieveSubscriptionForAdmin(
  key: string,
  subscriptionId: string,
): Promise<AdminStripeSubscription> {
  const base = `/v1/subscriptions/${enc(subscriptionId)}?expand[]=latest_invoice&expand[]=default_payment_method`;
  try {
    return await stripeApiRequest(key, 'GET', `${base}&expand[]=discounts`);
  } catch {
    // Older API versions have no expandable `discounts`; `discount` is inline there.
    return stripeApiRequest(key, 'GET', base);
  }
}

export async function retrieveCustomerForAdmin(
  key: string,
  customerId: string,
): Promise<AdminStripeCustomer> {
  return stripeApiRequest(
    key,
    'GET',
    `/v1/customers/${enc(customerId)}?expand[]=invoice_settings.default_payment_method`,
  );
}

export async function retrievePrice(key: string, priceId: string): Promise<AdminStripePrice> {
  return stripeApiRequest(key, 'GET', `/v1/prices/${enc(priceId)}`);
}

/**
 * Preview the invoice a plan/seat change would produce. Uses
 * `create_preview`, which replaced the upcoming-invoice endpoint.
 */
export async function previewSubscriptionInvoice(
  key: string,
  params: {
    customerId: string;
    subscriptionId?: string;
    itemId?: string;
    priceId: string;
    quantity: number;
    prorationBehavior: ProrationBehavior;
  },
): Promise<AdminStripeInvoice> {
  const body: Record<string, string> = {
    customer: params.customerId,
    'subscription_details[items][0][price]': params.priceId,
    'subscription_details[items][0][quantity]': String(params.quantity),
  };
  if (params.subscriptionId) {
    body.subscription = params.subscriptionId;
    body['subscription_details[proration_behavior]'] = params.prorationBehavior;
    if (params.itemId) body['subscription_details[items][0][id]'] = params.itemId;
  }
  return stripeApiRequest(key, 'POST', '/v1/invoices/create_preview', body);
}

// ============================================================================
// Subscription writes
// ============================================================================

/** Swap the plan item's price and/or quantity on an existing subscription. */
export async function updateSubscriptionPlanItem(
  key: string,
  subscriptionId: string,
  params: {
    itemId: string;
    priceId: string;
    quantity: number;
    prorationBehavior: ProrationBehavior;
    collectionMethod?: CollectionMethod;
    daysUntilDue?: number;
    automaticTax?: boolean;
    metadata?: Record<string, string>;
  },
  idempotencyKey: string,
): Promise<AdminStripeSubscription> {
  const body: Record<string, string> = {
    'items[0][id]': params.itemId,
    'items[0][price]': params.priceId,
    'items[0][quantity]': String(params.quantity),
    proration_behavior: params.prorationBehavior,
    // Apply the change even if the proration charge fails; the open invoice
    // then shows up in the console and Stripe's dunning takes over.
    payment_behavior: 'allow_incomplete',
    'expand[]': 'latest_invoice',
  };
  if (params.collectionMethod) body.collection_method = params.collectionMethod;
  if (params.collectionMethod === 'send_invoice') {
    body.days_until_due = String(params.daysUntilDue ?? 14);
  }
  if (params.automaticTax) body['automatic_tax[enabled]'] = 'true';
  addMetadata(body, params.metadata);
  return stripeApiRequest(key, 'POST', `/v1/subscriptions/${enc(subscriptionId)}`, body, {
    idempotencyKey,
  });
}

/** Start a new subscription for a customer without going through Checkout. */
export async function createAdminSubscription(
  key: string,
  params: {
    customerId: string;
    priceId: string;
    quantity: number;
    collectionMethod: CollectionMethod;
    daysUntilDue?: number;
    automaticTax: boolean;
    metadata: Record<string, string>;
  },
  idempotencyKey: string,
): Promise<AdminStripeSubscription> {
  const body: Record<string, string> = {
    customer: params.customerId,
    'items[0][price]': params.priceId,
    'items[0][quantity]': String(params.quantity),
    collection_method: params.collectionMethod,
    payment_behavior: 'allow_incomplete',
    'expand[]': 'latest_invoice',
  };
  if (params.collectionMethod === 'send_invoice') {
    body.days_until_due = String(params.daysUntilDue ?? 14);
  }
  if (params.automaticTax) body['automatic_tax[enabled]'] = 'true';
  addMetadata(body, params.metadata);
  return stripeApiRequest(key, 'POST', '/v1/subscriptions', body, { idempotencyKey });
}

export async function setCancelAtPeriodEnd(
  key: string,
  subscriptionId: string,
  cancel: boolean,
): Promise<AdminStripeSubscription> {
  return stripeApiRequest(key, 'POST', `/v1/subscriptions/${enc(subscriptionId)}`, {
    cancel_at_period_end: String(cancel),
  });
}

/** Cancel now with a prorated credit for the unused time. */
export async function cancelSubscriptionNow(
  key: string,
  subscriptionId: string,
): Promise<AdminStripeSubscription> {
  return stripeApiRequest(key, 'DELETE', `/v1/subscriptions/${enc(subscriptionId)}?prorate=true`);
}

/** Move the trial end (free period) without prorating. */
export async function setSubscriptionTrialEnd(
  key: string,
  subscriptionId: string,
  trialEndUnix: number,
  idempotencyKey: string,
): Promise<AdminStripeSubscription> {
  return stripeApiRequest(
    key,
    'POST',
    `/v1/subscriptions/${enc(subscriptionId)}`,
    { trial_end: String(trialEndUnix), proration_behavior: 'none' },
    { idempotencyKey },
  );
}

export async function createCoupon(
  key: string,
  params: {
    percentOff?: number;
    amountOffCents?: number;
    currency?: string;
    duration: 'once' | 'repeating' | 'forever';
    durationInMonths?: number;
    name: string;
    metadata: Record<string, string>;
  },
  idempotencyKey: string,
): Promise<AdminStripeCoupon> {
  const body: Record<string, string> = { duration: params.duration, name: params.name };
  if (params.percentOff !== undefined) body.percent_off = String(params.percentOff);
  if (params.amountOffCents !== undefined) {
    body.amount_off = String(params.amountOffCents);
    body.currency = (params.currency ?? 'eur').toLowerCase();
  }
  if (params.duration === 'repeating') body.duration_in_months = String(params.durationInMonths ?? 1);
  addMetadata(body, params.metadata);
  return stripeApiRequest(key, 'POST', '/v1/coupons', body, { idempotencyKey });
}

/** Replace the subscription's discounts with a single coupon. */
export async function applySubscriptionCoupon(
  key: string,
  subscriptionId: string,
  couponId: string,
  idempotencyKey: string,
): Promise<AdminStripeSubscription> {
  return stripeApiRequest(
    key,
    'POST',
    `/v1/subscriptions/${enc(subscriptionId)}`,
    { 'discounts[0][coupon]': couponId },
    { idempotencyKey },
  );
}

export async function clearSubscriptionDiscounts(
  key: string,
  subscriptionId: string,
): Promise<AdminStripeSubscription> {
  return stripeApiRequest(key, 'POST', `/v1/subscriptions/${enc(subscriptionId)}`, { discounts: '' });
}

// ============================================================================
// Payments and invoices
// ============================================================================

export async function createRefund(
  key: string,
  params: {
    paymentIntentId?: string | null;
    chargeId?: string | null;
    amountCents?: number;
    metadata: Record<string, string>;
  },
  idempotencyKey: string,
): Promise<AdminStripeRefund> {
  const body: Record<string, string> = { reason: 'requested_by_customer' };
  if (params.paymentIntentId) body.payment_intent = params.paymentIntentId;
  else if (params.chargeId) body.charge = params.chargeId;
  else throw new Error('A refund needs a payment intent or a charge');
  if (params.amountCents !== undefined) body.amount = String(params.amountCents);
  addMetadata(body, params.metadata);
  return stripeApiRequest(key, 'POST', '/v1/refunds', body, { idempotencyKey });
}

export async function voidStripeInvoice(
  key: string,
  invoiceId: string,
  idempotencyKey: string,
): Promise<AdminStripeInvoice> {
  return stripeApiRequest(key, 'POST', `/v1/invoices/${enc(invoiceId)}/void`, undefined, {
    idempotencyKey,
  });
}

// ============================================================================
// Plan catalog
// ============================================================================

export async function createPlanProduct(
  key: string,
  params: { name: string; description: string | null; metadata: Record<string, string> },
): Promise<{ id: string }> {
  const body: Record<string, string> = { name: params.name };
  if (params.description) body.description = params.description;
  addMetadata(body, params.metadata);
  return stripeApiRequest(key, 'POST', '/v1/products', body);
}

export async function createPlanPrice(
  key: string,
  params: {
    productId: string;
    unitAmountCents: number;
    currency: string;
    interval: 'month' | 'year';
    metadata: Record<string, string>;
  },
): Promise<AdminStripePrice> {
  const body: Record<string, string> = {
    product: params.productId,
    unit_amount: String(params.unitAmountCents),
    currency: params.currency.toLowerCase(),
    'recurring[interval]': params.interval,
  };
  addMetadata(body, params.metadata);
  return stripeApiRequest(key, 'POST', '/v1/prices', body);
}

/** Archive a price. Subscriptions already on it keep it; new ones cannot use it. */
export async function archivePlanPrice(
  key: string,
  priceId: string,
  metadata: Record<string, string>,
): Promise<AdminStripePrice> {
  const body: Record<string, string> = { active: 'false' };
  addMetadata(body, metadata);
  return stripeApiRequest(key, 'POST', `/v1/prices/${enc(priceId)}`, body);
}
