/**
 * Connector webhook helpers — HMAC verification, topic → sync mapping, and
 * delivery URL construction. Stores push changes here; we do not poll.
 */

import type { ConnectorSyncSettingKey } from './catalog';

export type ConnectorWebhookKind = 'create' | 'update' | 'delete';

export interface ConnectorWebhookTopic {
  provider: string;
  topic: string;
  settingKey: ConnectorSyncSettingKey;
  kind: ConnectorWebhookKind;
  /** When two syncs share a setting key, pin the webhook to one of them. */
  syncName?: string;
}

export const WOOCOMMERCE_WEBHOOK_TOPICS: ConnectorWebhookTopic[] = [
  { provider: 'woocommerce', topic: 'product.created', settingKey: 'products', kind: 'create' },
  { provider: 'woocommerce', topic: 'product.updated', settingKey: 'products', kind: 'update' },
  { provider: 'woocommerce', topic: 'product.deleted', settingKey: 'products', kind: 'delete' },
  { provider: 'woocommerce', topic: 'order.created', settingKey: 'orders', kind: 'create' },
  { provider: 'woocommerce', topic: 'order.updated', settingKey: 'orders', kind: 'update' },
  { provider: 'woocommerce', topic: 'order.deleted', settingKey: 'orders', kind: 'delete' },
  { provider: 'woocommerce', topic: 'customer.created', settingKey: 'customers', kind: 'create' },
  { provider: 'woocommerce', topic: 'customer.updated', settingKey: 'customers', kind: 'update' },
  { provider: 'woocommerce', topic: 'customer.deleted', settingKey: 'customers', kind: 'delete' },
];

export const SHOPIFY_WEBHOOK_TOPICS: ConnectorWebhookTopic[] = [
  { provider: 'shopify', topic: 'products/create', settingKey: 'products', kind: 'create' },
  { provider: 'shopify', topic: 'products/update', settingKey: 'products', kind: 'update' },
  { provider: 'shopify', topic: 'products/delete', settingKey: 'products', kind: 'delete' },
  { provider: 'shopify', topic: 'orders/create', settingKey: 'orders', kind: 'create' },
  { provider: 'shopify', topic: 'orders/updated', settingKey: 'orders', kind: 'update' },
  { provider: 'shopify', topic: 'orders/delete', settingKey: 'orders', kind: 'delete' },
  { provider: 'shopify', topic: 'customers/create', settingKey: 'customers', kind: 'create' },
  { provider: 'shopify', topic: 'customers/update', settingKey: 'customers', kind: 'update' },
  { provider: 'shopify', topic: 'customers/delete', settingKey: 'customers', kind: 'delete' },
];

/** Moneybird events whose entity is not the record to import (see `MONEYBIRD_WEBHOOK_TOPICS`). */
export function isRoutedMoneybirdTopic(topic: string): boolean {
  return topic.startsWith('document_') || topic.startsWith('payment_') || topic.startsWith('financial_statement_');
}

// A payment changes what is paid on a sales invoice or a document, and links a bank line.
const MONEYBIRD_PAYMENT_EVENTS = 'update: payment_registered payment_destroyed payment_linked_to_financial_mutation';

/**
 * Moneybird's own event names (developer.moneybird.com/webhooks/events), per
 * setting key and sync, as `kind: event event …` (see `moneybirdTopics`).
 * Purchase invoices and receipts are `document_*` events, a bank line only
 * comes with its `financial_statement_*`, and payments are `payment_*` for
 * any kind of invoice: those three are routed by `moneybird-webhooks.ts`
 * (connect-domain), which reads the actual document, invoice or statement
 * lines; the sync here only places them for registering.
 */
const MONEYBIRD_EVENTS: Array<[ConnectorSyncSettingKey, string, string]> = [
  ['contacts', 'moneybird-contacts', `
    create: contact_created contact_created_from_checkout_order
    update: contact_changed contact_activated contact_archived contact_merged contact_tax_number_validated
    delete: contact_destroyed`],
  ['invoices', 'moneybird-sales-invoices', `
    create: sales_invoice_created sales_invoice_created_based_on_estimate sales_invoice_created_based_on_recurring
      sales_invoice_created_based_on_subscription sales_invoice_created_from_checkout_order
      sales_invoice_created_from_payment_request sales_invoice_created_from_original
    update: sales_invoice_updated sales_invoice_merged sales_invoice_marked_as_uncollectible
      sales_invoice_revert_uncollectible sales_invoice_state_changed_to_draft sales_invoice_state_changed_to_scheduled
      sales_invoice_state_changed_to_open sales_invoice_state_changed_to_pending_payment
      sales_invoice_state_changed_to_reminded sales_invoice_state_changed_to_late sales_invoice_state_changed_to_paid
      sales_invoice_state_changed_to_uncollectible
    delete: sales_invoice_destroyed`],
  ['products', 'moneybird-products', `
    create: product_created
    update: product_updated product_activated product_deactivated
    delete: product_destroyed`],
  ['bills', 'moneybird-purchase-invoices', `
    create: document_saved document_saved_from_email document_saved_from_si document_created_from_original
      document_recurred
    update: document_updated
    delete: document_destroyed`],
  ['bankAccounts', 'moneybird-financial-accounts', `
    create: financial_account_created
    update: financial_account_renamed financial_account_activated financial_account_deactivated
    delete: financial_account_destroyed`],
  ['bankTransactions', 'moneybird-financial-mutations', `
    create: financial_statement_created
    update: financial_statement_updated
    delete: financial_statement_destroyed`],
  ['invoices', 'moneybird-sales-invoices', MONEYBIRD_PAYMENT_EVENTS],
  ['bills', 'moneybird-purchase-invoices', MONEYBIRD_PAYMENT_EVENTS],
  ['bankTransactions', 'moneybird-financial-mutations', MONEYBIRD_PAYMENT_EVENTS],
];

/** `kind: event event …` as topics; a word ending in `:` sets the kind of the events after it. */
function moneybirdTopics(settingKey: ConnectorSyncSettingKey, syncName: string, spec: string): ConnectorWebhookTopic[] {
  let kind: ConnectorWebhookKind = 'update';
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      if (word.endsWith(':')) {
        kind = word.slice(0, -1) as ConnectorWebhookKind;
        return [];
      }
      return [{ provider: 'moneybird', topic: word, settingKey, kind, syncName }];
    });
}

export const MONEYBIRD_WEBHOOK_TOPICS: ConnectorWebhookTopic[] = MONEYBIRD_EVENTS.flatMap(([settingKey, syncName, spec]) =>
  moneybirdTopics(settingKey, syncName, spec),
);

export const PICQER_WEBHOOK_TOPICS: ConnectorWebhookTopic[] = [
  { provider: 'picqer', topic: 'products.created', settingKey: 'products', kind: 'create', syncName: 'picqer-products' },
  { provider: 'picqer', topic: 'products.changed', settingKey: 'products', kind: 'update', syncName: 'picqer-products' },
  { provider: 'picqer', topic: 'products.free_stock_changed', settingKey: 'inventory', kind: 'update', syncName: 'picqer-inventory' },
  { provider: 'picqer', topic: 'products.stock_changed', settingKey: 'inventory', kind: 'update', syncName: 'picqer-inventory' },
  { provider: 'picqer', topic: 'products.stock_on_location_changed', settingKey: 'inventory', kind: 'update', syncName: 'picqer-inventory' },
  { provider: 'picqer', topic: 'orders.created', settingKey: 'orders', kind: 'create', syncName: 'picqer-orders' },
  { provider: 'picqer', topic: 'orders.status_changed', settingKey: 'orders', kind: 'update', syncName: 'picqer-orders' },
  { provider: 'picqer', topic: 'orders.completed', settingKey: 'orders', kind: 'update', syncName: 'picqer-orders' },
  { provider: 'picqer', topic: 'orders.closed', settingKey: 'orders', kind: 'update', syncName: 'picqer-orders' },
  { provider: 'picqer', topic: 'orders.allocated', settingKey: 'orders', kind: 'update', syncName: 'picqer-orders' },
  { provider: 'picqer', topic: 'orders.paused', settingKey: 'orders', kind: 'update', syncName: 'picqer-orders' },
  { provider: 'picqer', topic: 'orders.resumed', settingKey: 'orders', kind: 'update', syncName: 'picqer-orders' },
  { provider: 'picqer', topic: 'picklists.created', settingKey: 'picklists', kind: 'create', syncName: 'picqer-picklists' },
  { provider: 'picqer', topic: 'picklists.changed', settingKey: 'picklists', kind: 'update', syncName: 'picqer-picklists' },
  { provider: 'picqer', topic: 'picklists.closed', settingKey: 'picklists', kind: 'update', syncName: 'picqer-picklists' },
  { provider: 'picqer', topic: 'picklists.cancelled', settingKey: 'picklists', kind: 'update', syncName: 'picqer-picklists' },
  { provider: 'picqer', topic: 'picklists.paused', settingKey: 'picklists', kind: 'update', syncName: 'picqer-picklists' },
  { provider: 'picqer', topic: 'picklists.resumed', settingKey: 'picklists', kind: 'update', syncName: 'picqer-picklists' },
  { provider: 'picqer', topic: 'picklists.shipments.created', settingKey: 'shipments', kind: 'create', syncName: 'picqer-shipments' },
  { provider: 'picqer', topic: 'picklists.shipments.cancelled', settingKey: 'shipments', kind: 'update', syncName: 'picqer-shipments' },
  { provider: 'picqer', topic: 'purchase_orders.created', settingKey: 'purchaseOrders', kind: 'create', syncName: 'picqer-purchase-orders' },
  { provider: 'picqer', topic: 'purchase_orders.changed', settingKey: 'purchaseOrders', kind: 'update', syncName: 'picqer-purchase-orders' },
  { provider: 'picqer', topic: 'purchase_orders.purchased', settingKey: 'purchaseOrders', kind: 'update', syncName: 'picqer-purchase-orders' },
  { provider: 'picqer', topic: 'receipts.completed', settingKey: 'purchaseOrders', kind: 'update', syncName: 'picqer-purchase-orders' },
  { provider: 'picqer', topic: 'returns.created', settingKey: 'returns', kind: 'create', syncName: 'picqer-returns' },
  { provider: 'picqer', topic: 'returns.changed', settingKey: 'returns', kind: 'update', syncName: 'picqer-returns' },
  { provider: 'picqer', topic: 'returns.status_changed', settingKey: 'returns', kind: 'update', syncName: 'picqer-returns' },
  { provider: 'picqer', topic: 'returns.products_received', settingKey: 'returns', kind: 'update', syncName: 'picqer-returns' },
  { provider: 'picqer', topic: 'movements.moved', settingKey: 'movements', kind: 'update', syncName: 'picqer-movements' },
  { provider: 'picqer', topic: 'location_stock_counts.completed', settingKey: 'stockCounts', kind: 'update', syncName: 'picqer-stock-counts' },
];

/**
 * Stripe event types. Invoice events carry the invoice (re-read in full during
 * ingest); `payout.paid` carries the payout, whose balance transactions are
 * then fetched. `account.application.deauthorized` is handled before topic
 * matching (it revokes the connection).
 */
export const STRIPE_WEBHOOK_TOPICS: ConnectorWebhookTopic[] = [
  { provider: 'stripe', topic: 'invoice.finalized', settingKey: 'invoices', kind: 'create', syncName: 'stripe-invoices' },
  { provider: 'stripe', topic: 'invoice.updated', settingKey: 'invoices', kind: 'update', syncName: 'stripe-invoices' },
  { provider: 'stripe', topic: 'invoice.paid', settingKey: 'invoices', kind: 'update', syncName: 'stripe-invoices' },
  { provider: 'stripe', topic: 'invoice.payment_succeeded', settingKey: 'invoices', kind: 'update', syncName: 'stripe-invoices' },
  { provider: 'stripe', topic: 'invoice.voided', settingKey: 'invoices', kind: 'update', syncName: 'stripe-invoices' },
  { provider: 'stripe', topic: 'invoice.marked_uncollectible', settingKey: 'invoices', kind: 'update', syncName: 'stripe-invoices' },
  { provider: 'stripe', topic: 'payout.paid', settingKey: 'bankTransactions', kind: 'update', syncName: 'stripe-balance-transactions' },
];

/** Stripe event that revokes our access to a connected account. */
export const STRIPE_DEAUTHORIZED_EVENT = 'account.application.deauthorized';

/**
 * Set by integration-webhook-worker on a Stripe Connect event it already
 * verified with the platform's signing secret. Only trusted on the internal
 * `connector-event` route, which outside callers cannot reach.
 */
export const STRIPE_CONNECT_VERIFIED_HEADER = 'x-weldsuite-stripe-connect';

/** KV key: connected Stripe account → the WeldSuite connections that use it. */
export function stripeAccountKvKey(accountId: string): string {
  return `stripeacct:${accountId}`;
}

/** One connected Stripe account can be connected in several workspaces. */
export type StripeAccountKvEntry = Array<{ workspaceId: string; connectionId: string }>;

const TOPICS_BY_PROVIDER: Record<string, ConnectorWebhookTopic[]> = {
  woocommerce: WOOCOMMERCE_WEBHOOK_TOPICS,
  shopify: SHOPIFY_WEBHOOK_TOPICS,
  moneybird: MONEYBIRD_WEBHOOK_TOPICS,
  stripe: STRIPE_WEBHOOK_TOPICS,
  picqer: PICQER_WEBHOOK_TOPICS,
};

export function webhookTopicsFor(provider: string): ConnectorWebhookTopic[] {
  return TOPICS_BY_PROVIDER[provider] ?? [];
}

/** Moneybird topic prefixes (checked in order) for events not in the static topic list. */
const MONEYBIRD_TOPIC_PREFIXES: ReadonlyArray<{
  prefix: string;
  settingKey: ConnectorWebhookTopic['settingKey'];
  syncName: string;
}> = [
  { prefix: 'contact_', settingKey: 'contacts', syncName: 'moneybird-contacts' },
  { prefix: 'sales_invoice_', settingKey: 'invoices', syncName: 'moneybird-sales-invoices' },
  { prefix: 'product_', settingKey: 'products', syncName: 'moneybird-products' },
  { prefix: 'document_', settingKey: 'bills', syncName: 'moneybird-purchase-invoices' },
  { prefix: 'financial_account_', settingKey: 'bankAccounts', syncName: 'moneybird-financial-accounts' },
  { prefix: 'financial_statement_', settingKey: 'bankTransactions', syncName: 'moneybird-financial-mutations' },
  { prefix: 'payment_', settingKey: 'invoices', syncName: 'moneybird-sales-invoices' },
];

export function matchWebhookTopic(provider: string, topic: string): ConnectorWebhookTopic | undefined {
  const normalised = topic.trim().toLowerCase();
  const exact = webhookTopicsFor(provider).find((entry) => entry.topic === normalised);
  if (exact) return exact;
  if (provider !== 'moneybird') return undefined;
  const kind = normalised.includes('destroy') ? 'delete' : 'update';
  const prefix = webhookTopicsFor(provider).find((entry) => normalised.startsWith(`${entry.topic.split('_').slice(0, -1).join('_')}_`));
  if (prefix) return { ...prefix, topic: normalised, kind };
  const fallback = MONEYBIRD_TOPIC_PREFIXES.find((entry) => normalised.startsWith(entry.prefix));
  if (!fallback) return undefined;
  return { provider, topic: normalised, settingKey: fallback.settingKey, kind, syncName: fallback.syncName };
}

export function connectorWebhookDeliveryUrl(baseUrl: string, connectionId: string): string {
  const trimmed = baseUrl.replace(/(?<!\/)\/+$/, '');
  return `${trimmed}/webhooks/connectors/${connectionId}`;
}

export function connectorWebhookKvKey(connectionId: string): string {
  return `connconn:${connectionId}`;
}

export interface ConnectorWebhookKvEntry {
  workspaceId: string;
  provider: string;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function hmacSha256Base64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return bytesToBase64(signature);
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.codePointAt(i)! ^ right.codePointAt(i)!;
  return mismatch === 0;
}

/** Providers that sign the raw body with HMAC-SHA256 and send it Base64-encoded. */
async function verifyBase64BodyHmac(args: {
  secret: string;
  body: string;
  signature: string | null | undefined;
}): Promise<boolean> {
  if (!args.signature) return false;
  const expected = await hmacSha256Base64(args.secret, args.body);
  return timingSafeEqual(expected, args.signature.trim());
}

/** WooCommerce: `X-WC-Webhook-Signature` is HMAC-SHA256 of the raw body, Base64. */
export const verifyWooCommerceWebhook = verifyBase64BodyHmac;

/** Shopify: `X-Shopify-Hmac-Sha256` is HMAC-SHA256 of the raw body, Base64. */
export const verifyShopifyWebhook = verifyBase64BodyHmac;

/**
 * `t=<unix>,v1=<hex hmac of "t.body">` with a 5-minute tolerance. Moneybird's
 * `Moneybird-Signature` and Stripe's `Stripe-Signature` share this scheme.
 */
async function verifyTimestampedHexHmac(args: {
  secret: string;
  body: string;
  signature: string | null | undefined;
  nowSeconds?: number;
}): Promise<boolean> {
  if (!args.signature) return false;
  const parts = args.signature.split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2);
  const digests = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3).toLowerCase());
  if (!timestamp || digests.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false;
  const expected = (await hmacSha256Hex(args.secret, `${timestamp}.${args.body}`)).toLowerCase();
  return digests.some((digest) => timingSafeEqual(expected, digest));
}

/** Moneybird: `Moneybird-Signature` is `t=<unix>,v1=<hex hmac of t.body>`. */
export const verifyMoneybirdWebhook = verifyTimestampedHexHmac;

/** Stripe: `Stripe-Signature` is `t=<unix>,v1=<hex hmac of t.body>` (plus legacy `v0`, ignored). */
export const verifyStripeWebhook = verifyTimestampedHexHmac;

/** Picqer: `X-Picqer-Signature` is HMAC-SHA256 of the raw body, Base64. */
export const verifyPicqerWebhook = verifyBase64BodyHmac;

export async function verifyConnectorWebhook(args: {
  provider: string;
  secret: string;
  body: string;
  signature: string | null | undefined;
}): Promise<boolean> {
  if (args.provider === 'shopify') return verifyShopifyWebhook(args);
  if (args.provider === 'woocommerce') return verifyWooCommerceWebhook(args);
  if (args.provider === 'moneybird') return verifyMoneybirdWebhook(args);
  if (args.provider === 'stripe') return verifyStripeWebhook(args);
  if (args.provider === 'picqer') return verifyPicqerWebhook(args);
  return false;
}

export function readWebhookTopicFromHeaders(provider: string, headers: Headers): string | null {
  if (provider === 'woocommerce') {
    return headers.get('x-wc-webhook-topic') ?? headers.get('X-WC-Webhook-Topic');
  }
  if (provider === 'shopify') {
    return headers.get('x-shopify-topic') ?? headers.get('X-Shopify-Topic');
  }
  return null;
}

export function readWebhookTopicFromPayload(provider: string, payload: Record<string, unknown>): string | null {
  if (provider === 'moneybird') {
    const action = payload.action;
    return typeof action === 'string' && action.trim() ? action.trim().toLowerCase() : null;
  }
  if (provider === 'picqer') {
    const event = payload.event;
    return typeof event === 'string' && event.trim() ? event.trim().toLowerCase() : null;
  }
  if (provider === 'stripe') {
    const type = payload.type;
    return typeof type === 'string' && type.trim() ? type.trim().toLowerCase() : null;
  }
  return null;
}

export function unwrapWebhookPayload(provider: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (provider === 'moneybird') {
    const entity = payload.entity;
    if (entity && typeof entity === 'object' && !Array.isArray(entity)) {
      return entity as Record<string, unknown>;
    }
    return payload;
  }
  if (provider === 'picqer') {
    const data = payload.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return payload;
  }
  if (provider === 'stripe') {
    const object = (payload.data as { object?: unknown } | undefined)?.object;
    if (object && typeof object === 'object' && !Array.isArray(object)) {
      return object as Record<string, unknown>;
    }
    return payload;
  }
  return payload;
}

export function readWebhookSignatureFromHeaders(provider: string, headers: Headers): string | null {
  if (provider === 'woocommerce') {
    return headers.get('x-wc-webhook-signature') ?? headers.get('X-WC-Webhook-Signature');
  }
  if (provider === 'shopify') {
    return headers.get('x-shopify-hmac-sha256') ?? headers.get('X-Shopify-Hmac-Sha256');
  }
  if (provider === 'moneybird') {
    return headers.get('moneybird-signature') ?? headers.get('Moneybird-Signature');
  }
  if (provider === 'picqer') {
    return headers.get('x-picqer-signature') ?? headers.get('X-Picqer-Signature');
  }
  if (provider === 'stripe') {
    return headers.get('stripe-signature') ?? headers.get('Stripe-Signature');
  }
  return null;
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}
