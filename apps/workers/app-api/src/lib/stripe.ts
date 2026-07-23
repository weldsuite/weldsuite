/**
 * Stripe Checkout helpers (raw fetch, no SDK).
 *
 * Ported from `apps/core-api/src/lib/stripe.ts`. Uses form-encoded POSTs
 * directly against the Stripe REST API.
 */

const STRIPE_API_BASE = 'https://api.stripe.com';

async function stripeRequest(
  secretKey: string,
  method: string,
  path: string,
  body?: Record<string, string>,
): Promise<unknown> {
  const auth = `Basic ${btoa(`${secretKey}:`)}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (body) options.body = new URLSearchParams(body).toString();

  const res = await fetch(`${STRIPE_API_BASE}${path}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Cancel a subscription immediately (not at period end). Used when a workspace
 * is deleted — the owner should stop being billed right away. Prorated so any
 * unused time is credited. Mirrors billing-worker's `cancelSubscriptionImmediately`.
 */
export async function cancelSubscriptionImmediately(
  secretKey: string,
  subscriptionId: string,
): Promise<void> {
  await stripeRequest(secretKey, 'DELETE', `/v1/subscriptions/${subscriptionId}?prorate=true`);
}

export interface DomainLineItem {
  name: string;
  unitAmountCents: number;
  currency: string;
}

export interface CreateDomainCheckoutParams {
  customerId: string;
  lineItems: DomainLineItem[];
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export async function createDomainCheckoutSession(
  secretKey: string,
  params: CreateDomainCheckoutParams,
): Promise<{ id: string; url: string }> {
  const body: Record<string, string> = {
    customer: params.customerId,
    mode: 'payment',
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  };

  params.lineItems.forEach((item, idx) => {
    body[`line_items[${idx}][price_data][currency]`] = item.currency;
    body[`line_items[${idx}][price_data][unit_amount]`] = String(item.unitAmountCents);
    body[`line_items[${idx}][price_data][product_data][name]`] = item.name;
    body[`line_items[${idx}][quantity]`] = '1';
  });

  for (const [k, v] of Object.entries(params.metadata)) {
    body[`metadata[${k}]`] = v;
  }

  const session = (await stripeRequest(secretKey, 'POST', '/v1/checkout/sessions', body)) as {
    id: string;
    url: string;
  };
  return { id: session.id, url: session.url };
}

// ============================================================================
// Subscription billing helpers — ported from api-worker `src/lib/stripe.ts`
// for the /api/billing surface. Same raw-fetch style, minimally typed to the
// fields the billing routes actually read.
// ============================================================================

/** Minimal Stripe subscription shape used by the billing routes. */
export interface StripeSubscription {
  id: string;
  status?: string;
  items?: { data?: Array<{ id: string; quantity?: number }> };
  latest_invoice?: string | { id: string } | null;
}

/** Minimal Stripe invoice shape used by the billing routes. */
export interface StripeInvoice {
  id: string;
  status?: string;
  hosted_invoice_url?: string | null;
}

/** Minimal Stripe customer shape used by the billing routes. */
export interface StripeCustomer {
  id: string;
}

/** Minimal Stripe Checkout Session shape used by the billing routes. */
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

/** Minimal Stripe tax id shape. */
export interface StripeTaxId {
  id: string;
  type: string;
  value: string;
}

/** Retrieve a Stripe subscription by ID. */
export async function retrieveSubscription(
  secretKey: string,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return (await stripeRequest(
    secretKey,
    'GET',
    `/v1/subscriptions/${subscriptionId}`,
  )) as StripeSubscription;
}

/** Create a Stripe customer. */
export async function createStripeCustomer(
  secretKey: string,
  params: {
    email?: string;
    name?: string;
    metadata?: Record<string, string>;
  },
): Promise<StripeCustomer> {
  const body: Record<string, string> = {};

  if (params.email) body.email = params.email;
  if (params.name) body.name = params.name;

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  return (await stripeRequest(secretKey, 'POST', '/v1/customers', body)) as StripeCustomer;
}

/** Update a Stripe customer (address, name, email). */
export async function updateStripeCustomer(
  secretKey: string,
  customerId: string,
  params: {
    name?: string;
    email?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
    };
  },
): Promise<StripeCustomer> {
  const body: Record<string, string> = {};

  if (params.name) body.name = params.name;
  if (params.email) body.email = params.email;

  if (params.address) {
    if (params.address.line1) body['address[line1]'] = params.address.line1;
    if (params.address.line2) body['address[line2]'] = params.address.line2;
    if (params.address.city) body['address[city]'] = params.address.city;
    if (params.address.state) body['address[state]'] = params.address.state;
    if (params.address.postal_code) body['address[postal_code]'] = params.address.postal_code;
    if (params.address.country) body['address[country]'] = params.address.country;
  }

  return (await stripeRequest(
    secretKey,
    'POST',
    `/v1/customers/${customerId}`,
    body,
  )) as StripeCustomer;
}

/**
 * Create a Stripe Checkout session in `subscription` mode (plan checkout).
 * Distinct from `createDomainCheckoutSession` above, which is one-off
 * `payment` mode.
 */
export async function createSubscriptionCheckoutSession(
  secretKey: string,
  params: {
    customerId: string;
    priceId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    automaticTax?: boolean;
    taxIdCollection?: boolean;
    billingAddressCollection?: 'auto' | 'required';
    /** When set, the created subscription starts with a free trial of this many days. */
    trialPeriodDays?: number;
  },
): Promise<StripeCheckoutSession> {
  const body: Record<string, string> = {
    customer: params.customerId,
    mode: 'subscription',
    'line_items[0][price]': params.priceId,
    'line_items[0][quantity]': params.quantity.toString(),
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  };

  if (params.trialPeriodDays && params.trialPeriodDays > 0) {
    body['subscription_data[trial_period_days]'] = params.trialPeriodDays.toString();
  }

  if (params.automaticTax) {
    body['automatic_tax[enabled]'] = 'true';
  }

  if (params.taxIdCollection) {
    body['tax_id_collection[enabled]'] = 'true';
  }

  if (params.billingAddressCollection) {
    body['billing_address_collection'] = params.billingAddressCollection;
  }

  // When automatic_tax is enabled, sync customer address/name from checkout
  if (params.automaticTax) {
    body['customer_update[address]'] = 'auto';
    body['customer_update[name]'] = 'auto';
  }

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  return (await stripeRequest(
    secretKey,
    'POST',
    '/v1/checkout/sessions',
    body,
  )) as StripeCheckoutSession;
}

/**
 * Update subscription quantity (seat count).
 * Uses payment_behavior=default_incomplete so the invoice is created and
 * payment is attempted. If payment fails, the invoice stays open and the
 * local purchasedSeats are NOT updated until the invoice is paid (via webhook).
 */
export async function updateSubscriptionQuantity(
  secretKey: string,
  subscriptionId: string,
  itemId: string,
  quantity: number,
): Promise<StripeSubscription> {
  return (await stripeRequest(secretKey, 'POST', `/v1/subscriptions/${subscriptionId}`, {
    'items[0][id]': itemId,
    'items[0][quantity]': quantity.toString(),
    proration_behavior: 'always_invoice',
    payment_behavior: 'default_incomplete',
  })) as StripeSubscription;
}

/** Retrieve a Stripe invoice by ID. */
export async function retrieveInvoice(
  secretKey: string,
  invoiceId: string,
): Promise<StripeInvoice> {
  return (await stripeRequest(secretKey, 'GET', `/v1/invoices/${invoiceId}`)) as StripeInvoice;
}

/**
 * Cancel a subscription at period end (soft cancel — the user keeps access
 * until the paid period runs out). See `cancelSubscriptionImmediately` above
 * for the hard-delete variant used on workspace deletion.
 */
export async function cancelSubscriptionAtPeriodEnd(
  secretKey: string,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return (await stripeRequest(secretKey, 'POST', `/v1/subscriptions/${subscriptionId}`, {
    cancel_at_period_end: 'true',
  })) as StripeSubscription;
}

/** Reactivate a canceled subscription (undo cancel_at_period_end). */
export async function reactivateSubscription(
  secretKey: string,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return (await stripeRequest(secretKey, 'POST', `/v1/subscriptions/${subscriptionId}`, {
    cancel_at_period_end: 'false',
  })) as StripeSubscription;
}

/** Create a tax ID on a Stripe customer (e.g., eu_vat, gb_vat). */
export async function createCustomerTaxId(
  secretKey: string,
  customerId: string,
  type: string,
  value: string,
): Promise<StripeTaxId> {
  return (await stripeRequest(secretKey, 'POST', `/v1/customers/${customerId}/tax_ids`, {
    type,
    value,
  })) as StripeTaxId;
}

/** List tax IDs for a Stripe customer. */
export async function listCustomerTaxIds(
  secretKey: string,
  customerId: string,
): Promise<{ data: StripeTaxId[] }> {
  return (await stripeRequest(secretKey, 'GET', `/v1/customers/${customerId}/tax_ids`)) as {
    data: StripeTaxId[];
  };
}

/** Delete a tax ID from a Stripe customer. */
export async function deleteCustomerTaxId(
  secretKey: string,
  customerId: string,
  taxIdId: string,
): Promise<{ id: string; deleted: boolean }> {
  return (await stripeRequest(
    secretKey,
    'DELETE',
    `/v1/customers/${customerId}/tax_ids/${taxIdId}`,
  )) as { id: string; deleted: boolean };
}
