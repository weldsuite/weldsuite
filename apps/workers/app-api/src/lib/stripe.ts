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
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const auth = `Basic ${btoa(`${secretKey}:`)}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...extraHeaders,
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

/** HTTP 4xx from Stripe is a definite rejection; 5xx/network/abort are ambiguous. */
export function isDefiniteStripeFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const match = /Stripe .+ failed \((\d+)\)/.exec(msg);
  if (!match) return false;
  const status = Number(match[1]);
  return status >= 400 && status < 500;
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
  idempotencyKey?: string;
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
    // Save the card (or SEPA mandate) so the daily auto-renew sweep can
    // raise an off-session invoice next year without another Checkout.
    'payment_intent_data[setup_future_usage]': 'off_session',
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

  const session = (await stripeRequest(
    secretKey,
    'POST',
    '/v1/checkout/sessions',
    body,
    params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : undefined,
  )) as {
    id: string;
    url: string;
  };
  return { id: session.id, url: session.url };
}

/**
 * Expire an open Checkout session so a later payment cannot land on a row we
 * already abandoned. Stripe returns 400 if the session is already complete
 * or expired — callers should treat that as best-effort.
 */
export async function expireCheckoutSession(
  secretKey: string,
  sessionId: string,
): Promise<void> {
  await stripeRequest(secretKey, 'POST', `/v1/checkout/sessions/${sessionId}/expire`);
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
  /** Overrides the customer-level default when set — see `setSubscriptionDefaultPaymentMethod`. */
  default_payment_method?: string | { id: string } | null;
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
  /** Customer-level fallback default. Subscription-level defaults win over it. */
  invoice_settings?: {
    default_payment_method?: string | { id: string } | null;
  } | null;
}

/**
 * Minimal Stripe PaymentMethod shape. Only the branches the billing UI renders
 * are modelled — card, SEPA Direct Debit, and the two redirect methods that
 * set up a SEPA mandate (iDEAL, Bancontact).
 */
export interface StripePaymentMethod {
  id: string;
  type: string;
  created?: number;
  billing_details?: { name?: string | null; email?: string | null } | null;
  card?: {
    brand?: string;
    last4?: string;
    exp_month?: number;
    exp_year?: number;
    country?: string | null;
  } | null;
  sepa_debit?: {
    last4?: string;
    bank_code?: string | null;
    country?: string | null;
  } | null;
}

/** Minimal Stripe SetupIntent shape — the client secret drives Stripe Elements. */
export interface StripeSetupIntent {
  id: string;
  client_secret: string | null;
  status?: string;
  payment_method?: string | { id: string } | null;
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

export interface DomainRenewalInvoiceParams {
  customerId: string;
  amountCents: number;
  currency: string;
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

/**
 * Create a draft invoice with one domain-renewal line, then finalize it.
 * Payment is a separate call so the domain row can store the invoice id
 * before we attempt an off-session charge.
 */
export async function createDomainRenewalInvoice(
  secretKey: string,
  params: DomainRenewalInvoiceParams,
): Promise<StripeInvoice> {
  const created = (await stripeRequest(
    secretKey,
    'POST',
    '/v1/invoices',
    {
      customer: params.customerId,
      auto_advance: 'false',
      collection_method: 'charge_automatically',
      description: params.description,
      pending_invoice_items_behavior: 'exclude',
      ...Object.fromEntries(
        Object.entries(params.metadata).map(([k, v]) => [`metadata[${k}]`, v]),
      ),
    },
    { 'Idempotency-Key': params.idempotencyKey },
  )) as StripeInvoice;

  // Idempotent retries replay the original create body; retrieve live status
  // before adding items or finalizing so a previously finalized invoice is not
  // finalized again.
  const invoice = await retrieveInvoice(secretKey, created.id);
  if (invoice.status !== 'draft') return invoice;

  await stripeRequest(
    secretKey,
    'POST',
    '/v1/invoiceitems',
    {
      customer: params.customerId,
      invoice: invoice.id,
      amount: String(params.amountCents),
      currency: params.currency.toLowerCase(),
      description: params.description,
    },
    { 'Idempotency-Key': `${params.idempotencyKey}:item` },
  );

  return (await stripeRequest(
    secretKey,
    'POST',
    `/v1/invoices/${invoice.id}/finalize`,
    undefined,
    { 'Idempotency-Key': `${params.idempotencyKey}:finalize` },
  )) as StripeInvoice;
}

/** Charge a finalized invoice using the customer's default payment method. */
export async function payInvoiceOffSession(
  secretKey: string,
  invoiceId: string,
): Promise<StripeInvoice> {
  return (await stripeRequest(secretKey, 'POST', `/v1/invoices/${invoiceId}/pay`, {
    off_session: 'true',
  })) as StripeInvoice;
}

/** Void an open invoice (used when the customer turns auto-renew off). */
export async function voidInvoice(
  secretKey: string,
  invoiceId: string,
): Promise<StripeInvoice> {
  return (await stripeRequest(
    secretKey,
    'POST',
    `/v1/invoices/${invoiceId}/void`,
  )) as StripeInvoice;
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

// ============================================================================
// Payment methods (settings → billing → "Payment methods")
// ============================================================================

/**
 * Reusable payment methods offered when adding a card. iDEAL and Bancontact
 * are redirect methods: confirming a SetupIntent with either one produces a
 * reusable `sepa_debit` PaymentMethod, so all four end up chargeable
 * off-session for subscription renewals.
 */
export const SETUP_PAYMENT_METHOD_TYPES = ['card', 'sepa_debit', 'ideal', 'bancontact'] as const;

/** Retrieve a Stripe customer (used to read `invoice_settings`). */
export async function retrieveStripeCustomer(
  secretKey: string,
  customerId: string,
): Promise<StripeCustomer> {
  return (await stripeRequest(secretKey, 'GET', `/v1/customers/${customerId}`)) as StripeCustomer;
}

/**
 * List a customer's saved payment methods. `type` is deliberately omitted so
 * Stripe returns every type at once (cards and SEPA mandates alike).
 */
export async function listPaymentMethods(
  secretKey: string,
  customerId: string,
): Promise<{ data: StripePaymentMethod[] }> {
  return (await stripeRequest(
    secretKey,
    'GET',
    `/v1/payment_methods?customer=${encodeURIComponent(customerId)}&limit=100`,
  )) as { data: StripePaymentMethod[] };
}

/** Retrieve a single payment method — used to verify customer ownership. */
export async function retrievePaymentMethod(
  secretKey: string,
  paymentMethodId: string,
): Promise<StripePaymentMethod & { customer?: string | { id: string } | null }> {
  return (await stripeRequest(
    secretKey,
    'GET',
    `/v1/payment_methods/${paymentMethodId}`,
  )) as StripePaymentMethod & { customer?: string | { id: string } | null };
}

/**
 * Create a SetupIntent so the browser can collect and save a payment method
 * with Stripe Elements. `usage: off_session` is required for the method to be
 * chargeable later on subscription renewals without the user present.
 */
export async function createSetupIntent(
  secretKey: string,
  params: { customerId: string; metadata?: Record<string, string> },
): Promise<StripeSetupIntent> {
  const body: Record<string, string> = {
    customer: params.customerId,
    usage: 'off_session',
  };

  SETUP_PAYMENT_METHOD_TYPES.forEach((type, i) => {
    body[`payment_method_types[${i}]`] = type;
  });

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  return (await stripeRequest(secretKey, 'POST', '/v1/setup_intents', body)) as StripeSetupIntent;
}

/** Detach a payment method from its customer (removes it from the account). */
export async function detachPaymentMethod(
  secretKey: string,
  paymentMethodId: string,
): Promise<StripePaymentMethod> {
  return (await stripeRequest(
    secretKey,
    'POST',
    `/v1/payment_methods/${paymentMethodId}/detach`,
  )) as StripePaymentMethod;
}

/** Set the customer-level default payment method for future invoices. */
export async function setCustomerDefaultPaymentMethod(
  secretKey: string,
  customerId: string,
  paymentMethodId: string,
): Promise<StripeCustomer> {
  return (await stripeRequest(secretKey, 'POST', `/v1/customers/${customerId}`, {
    'invoice_settings[default_payment_method]': paymentMethodId,
  })) as StripeCustomer;
}

/**
 * Set a subscription's own default payment method.
 *
 * Subscriptions created through Checkout carry a `default_payment_method` that
 * OVERRIDES the customer-level default, so marking a method as primary has to
 * write both — otherwise the change silently fails to apply on renewal.
 */
export async function setSubscriptionDefaultPaymentMethod(
  secretKey: string,
  subscriptionId: string,
  paymentMethodId: string,
): Promise<StripeSubscription> {
  return (await stripeRequest(secretKey, 'POST', `/v1/subscriptions/${subscriptionId}`, {
    default_payment_method: paymentMethodId,
  })) as StripeSubscription;
}
