/**
 * Stripe Helpers (No SDK)
 *
 * Webhook signature verification using Web Crypto API (HMAC-SHA256)
 * and raw fetch() helpers for Stripe API calls.
 */

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify Stripe webhook signature using Web Crypto API.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300
): Promise<void> {
  const parts = signatureHeader.split(',');
  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    throw new Error('Invalid stripe-signature header format');
  }

  const timestampNum = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNum) > toleranceSeconds) {
    throw new Error('Webhook timestamp outside tolerance');
  }

  const payload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  const expectedHex = bufferToHex(signatureBuffer);

  let matched = false;
  for (const sig of signatures) {
    if (timingSafeEqual(expectedHex, sig)) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    throw new Error('Webhook signature verification failed');
  }
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const hex: string[] = [];
  for (const b of bytes) {
    hex.push(b.toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ============================================================================
// Sync Loop Prevention
// ============================================================================

/**
 * Check if a webhook event was triggered by our own product/price sync.
 */
export function isOurOwnSync(metadata: Record<string, string> | null | undefined): boolean {
  if (!metadata) return false;
  const lastSyncedAt = metadata.lastSyncedAt;
  if (!lastSyncedAt) return false;
  const syncTime = new Date(lastSyncedAt).getTime();
  const now = Date.now();
  return (now - syncTime) < 10000; // 10 seconds
}

// ============================================================================
// Stripe API Helpers
// ============================================================================

/**
 * Make an authenticated request to the Stripe API using raw fetch().
 */
export async function stripeApiRequest(
  key: string,
  method: string,
  path: string,
  body?: Record<string, string>
): Promise<any> {
  const auth = `Basic ${btoa(`${key}:`)}`;

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };

  if (body) {
    options.body = new URLSearchParams(body).toString();
  }

  const response = await fetch(`https://api.stripe.com${path}`, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Stripe API ${method} ${path} failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Retrieve a Stripe subscription by ID.
 */
export async function retrieveSubscription(key: string, subscriptionId: string): Promise<any> {
  return stripeApiRequest(key, 'GET', `/v1/subscriptions/${subscriptionId}`);
}

/**
 * Create a Stripe subscription.
 */
export async function createStripeSubscription(
  key: string,
  params: {
    customerId: string;
    priceId: string;
    quantity?: number;
    metadata?: Record<string, string>;
    automaticTax?: boolean;
  }
): Promise<any> {
  const body: Record<string, string> = {
    customer: params.customerId,
    'items[0][price]': params.priceId,
  };

  if (params.quantity) {
    body['items[0][quantity]'] = params.quantity.toString();
  }

  if (params.automaticTax) {
    body['automatic_tax[enabled]'] = 'true';
  }

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  return stripeApiRequest(key, 'POST', '/v1/subscriptions', body);
}

/**
 * Create a Stripe customer.
 */
export async function createStripeCustomer(
  key: string,
  params: {
    email?: string;
    name?: string;
    metadata?: Record<string, string>;
  }
): Promise<any> {
  const body: Record<string, string> = {};

  if (params.email) body.email = params.email;
  if (params.name) body.name = params.name;

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  return stripeApiRequest(key, 'POST', '/v1/customers', body);
}

/**
 * Create a Stripe Checkout session.
 */
export async function createCheckoutSession(
  key: string,
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
    /** Checkout mode — defaults to 'subscription'; use 'payment' for one-time purchases (credit topups). */
    mode?: 'subscription' | 'payment';
    /**
     * Subscription-mode extras — used by marketplace (WeldApps) checkout to
     * tag the resulting subscription and, when the developer's Connect
     * account is payout-ready, split the charge via a destination charge
     * (application_fee_percent + transfer_data.destination).
     */
    subscriptionData?: {
      metadata?: Record<string, string>;
      applicationFeePercent?: number;
      transferDataDestination?: string;
    };
  }
): Promise<any> {
  const body: Record<string, string> = {
    customer: params.customerId,
    mode: params.mode ?? 'subscription',
    'line_items[0][price]': params.priceId,
    'line_items[0][quantity]': params.quantity.toString(),
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  };

  if (params.automaticTax) {
    body['automatic_tax[enabled]'] = 'true';
  }

  if (params.taxIdCollection) {
    body['tax_id_collection[enabled]'] = 'true';
  }

  if (params.billingAddressCollection) {
    body['billing_address_collection'] = params.billingAddressCollection;
  }

  if (params.automaticTax) {
    body['customer_update[address]'] = 'auto';
    body['customer_update[name]'] = 'auto';
  }

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  if (params.subscriptionData) {
    const { metadata, applicationFeePercent, transferDataDestination } = params.subscriptionData;
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        body[`subscription_data[metadata][${k}]`] = v;
      }
    }
    if (applicationFeePercent != null) {
      body['subscription_data[application_fee_percent]'] = applicationFeePercent.toString();
    }
    if (transferDataDestination) {
      body['subscription_data[transfer_data][destination]'] = transferDataDestination;
    }
  }

  return stripeApiRequest(key, 'POST', '/v1/checkout/sessions', body);
}

/**
 * Update subscription quantity (seat count).
 */
export async function updateSubscriptionQuantity(
  key: string,
  subscriptionId: string,
  itemId: string,
  quantity: number
): Promise<any> {
  return stripeApiRequest(key, 'POST', `/v1/subscriptions/${subscriptionId}`, {
    'items[0][id]': itemId,
    'items[0][quantity]': quantity.toString(),
    proration_behavior: 'create_prorations',
  });
}

/**
 * Cancel a subscription at period end.
 */
export async function cancelSubscription(key: string, subscriptionId: string): Promise<any> {
  return stripeApiRequest(key, 'POST', `/v1/subscriptions/${subscriptionId}`, {
    cancel_at_period_end: 'true',
  });
}

/**
 * Reactivate a canceled subscription (undo cancel_at_period_end).
 */
export async function reactivateSubscription(key: string, subscriptionId: string): Promise<any> {
  return stripeApiRequest(key, 'POST', `/v1/subscriptions/${subscriptionId}`, {
    cancel_at_period_end: 'false',
  });
}

/**
 * Add a new item to an existing subscription.
 */
export async function addSubscriptionItem(
  key: string,
  subscriptionId: string,
  priceId: string,
  quantity: number
): Promise<any> {
  return stripeApiRequest(key, 'POST', '/v1/subscription_items', {
    subscription: subscriptionId,
    price: priceId,
    quantity: quantity.toString(),
    proration_behavior: 'create_prorations',
  });
}

/**
 * Update the quantity of a subscription item.
 */
export async function updateSubscriptionItemQuantity(
  key: string,
  itemId: string,
  quantity: number
): Promise<any> {
  return stripeApiRequest(key, 'POST', `/v1/subscription_items/${itemId}`, {
    quantity: quantity.toString(),
    proration_behavior: 'create_prorations',
  });
}

/**
 * Delete a subscription item.
 */
export async function deleteSubscriptionItem(
  key: string,
  itemId: string
): Promise<any> {
  return stripeApiRequest(key, 'DELETE', `/v1/subscription_items/${itemId}?proration_behavior=create_prorations`);
}

/**
 * Delete a subscription item without generating a proration credit. Used by
 * the agent-purchase "cancel at period end" sweeper: the user has already
 * paid for the current period, so we just want the item gone before the
 * next invoice — no refund, no credit.
 */
export async function deleteSubscriptionItemNoProration(
  key: string,
  itemId: string
): Promise<any> {
  return stripeApiRequest(
    key,
    'DELETE',
    `/v1/subscription_items/${itemId}?proration_behavior=none`
  );
}

/**
 * Cancel a subscription immediately (not at period end).
 */
export async function cancelSubscriptionImmediately(
  key: string,
  subscriptionId: string
): Promise<any> {
  return stripeApiRequest(key, 'DELETE', `/v1/subscriptions/${subscriptionId}?prorate=true`);
}

/**
 * List payment methods for a customer.
 */
export async function listPaymentMethods(
  key: string,
  customerId: string
): Promise<any> {
  return stripeApiRequest(key, 'GET', `/v1/payment_methods?customer=${customerId}&type=card`);
}

/**
 * List invoices for a customer.
 */
export async function listInvoices(
  key: string,
  customerId: string,
  limit: number = 10
): Promise<any> {
  return stripeApiRequest(key, 'GET', `/v1/invoices?customer=${customerId}&limit=${limit}`);
}

// ============================================================================
// Stripe Product & Price Management
// ============================================================================

/**
 * Create a Stripe Product.
 */
export async function createStripeProduct(
  key: string,
  params: {
    name: string;
    metadata?: Record<string, string>;
  }
): Promise<any> {
  const body: Record<string, string> = {
    name: params.name,
  };

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  return stripeApiRequest(key, 'POST', '/v1/products', body);
}

/**
 * Update a Stripe Product.
 */
export async function updateStripeProduct(
  key: string,
  productId: string,
  params: {
    name?: string;
    metadata?: Record<string, string>;
  }
): Promise<any> {
  const body: Record<string, string> = {};

  if (params.name) body.name = params.name;

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  return stripeApiRequest(key, 'POST', `/v1/products/${productId}`, body);
}

/**
 * Create a Stripe Price (recurring monthly).
 */
export async function createStripePrice(
  key: string,
  params: {
    productId: string;
    unitAmount: number;
    currency: string;
    interval?: string;
  }
): Promise<any> {
  return stripeApiRequest(key, 'POST', '/v1/prices', {
    product: params.productId,
    unit_amount: params.unitAmount.toString(),
    currency: params.currency.toLowerCase(),
    'recurring[interval]': params.interval || 'month',
  });
}

/**
 * Archive a Stripe Price (set active=false).
 */
export async function archiveStripePrice(
  key: string,
  priceId: string
): Promise<any> {
  return stripeApiRequest(key, 'POST', `/v1/prices/${priceId}`, {
    active: 'false',
  });
}

/**
 * Update a Stripe customer (address, name, email).
 */
export async function updateStripeCustomer(
  key: string,
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
  }
): Promise<any> {
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

  return stripeApiRequest(key, 'POST', `/v1/customers/${customerId}`, body);
}

/**
 * Create a tax ID on a Stripe customer (e.g., eu_vat, gb_vat).
 */
export async function createCustomerTaxId(
  key: string,
  customerId: string,
  type: string,
  value: string
): Promise<any> {
  return stripeApiRequest(key, 'POST', `/v1/customers/${customerId}/tax_ids`, {
    type,
    value,
  });
}

/**
 * List tax IDs for a Stripe customer.
 */
export async function listCustomerTaxIds(
  key: string,
  customerId: string
): Promise<any> {
  return stripeApiRequest(key, 'GET', `/v1/customers/${customerId}/tax_ids`);
}

/**
 * Delete a tax ID from a Stripe customer.
 */
export async function deleteCustomerTaxId(
  key: string,
  customerId: string,
  taxIdId: string
): Promise<any> {
  return stripeApiRequest(key, 'DELETE', `/v1/customers/${customerId}/tax_ids/${taxIdId}`);
}

// ============================================================================
// Stripe Connect (WeldApps marketplace developer payouts)
// ============================================================================

/**
 * Create a Stripe Connect Express account for a developer workspace. Payouts
 * are routed to this account via destination charges (application_fee_percent
 * + transfer_data.destination on the subscription) once onboarding completes.
 */
export async function createConnectExpressAccount(
  key: string,
  params: {
    metadata?: Record<string, string>;
  }
): Promise<any> {
  const body: Record<string, string> = {
    type: 'express',
  };

  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  return stripeApiRequest(key, 'POST', '/v1/accounts', body);
}

/**
 * Create an onboarding Account Link for a Connect Express account. The
 * developer is redirected here to complete KYC; Stripe redirects back to
 * `returnUrl` on completion or `refreshUrl` if the link expired.
 */
export async function createConnectAccountLink(
  key: string,
  params: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }
): Promise<any> {
  return stripeApiRequest(key, 'POST', '/v1/account_links', {
    account: params.accountId,
    return_url: params.returnUrl,
    refresh_url: params.refreshUrl,
    type: 'account_onboarding',
  });
}
