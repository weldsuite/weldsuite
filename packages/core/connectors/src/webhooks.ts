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

export const MONEYBIRD_WEBHOOK_TOPICS: ConnectorWebhookTopic[] = [
  { provider: 'moneybird', topic: 'contact_created', settingKey: 'contacts', kind: 'create', syncName: 'moneybird-contacts' },
  { provider: 'moneybird', topic: 'contact_updated', settingKey: 'contacts', kind: 'update', syncName: 'moneybird-contacts' },
  { provider: 'moneybird', topic: 'contact_destroyed', settingKey: 'contacts', kind: 'delete', syncName: 'moneybird-contacts' },
  { provider: 'moneybird', topic: 'sales_invoice_created', settingKey: 'invoices', kind: 'create', syncName: 'moneybird-sales-invoices' },
  { provider: 'moneybird', topic: 'sales_invoice_updated', settingKey: 'invoices', kind: 'update', syncName: 'moneybird-sales-invoices' },
  { provider: 'moneybird', topic: 'sales_invoice_destroyed', settingKey: 'invoices', kind: 'delete', syncName: 'moneybird-sales-invoices' },
  { provider: 'moneybird', topic: 'sales_invoice_state_changed_to_open', settingKey: 'invoices', kind: 'update', syncName: 'moneybird-sales-invoices' },
  { provider: 'moneybird', topic: 'sales_invoice_state_changed_to_late', settingKey: 'invoices', kind: 'update', syncName: 'moneybird-sales-invoices' },
  { provider: 'moneybird', topic: 'sales_invoice_state_changed_to_paid', settingKey: 'invoices', kind: 'update', syncName: 'moneybird-sales-invoices' },
  { provider: 'moneybird', topic: 'sales_invoice_state_changed_to_uncollectible', settingKey: 'invoices', kind: 'update', syncName: 'moneybird-sales-invoices' },
  { provider: 'moneybird', topic: 'product_created', settingKey: 'products', kind: 'create', syncName: 'moneybird-products' },
  { provider: 'moneybird', topic: 'product_updated', settingKey: 'products', kind: 'update', syncName: 'moneybird-products' },
  { provider: 'moneybird', topic: 'product_destroyed', settingKey: 'products', kind: 'delete', syncName: 'moneybird-products' },
  { provider: 'moneybird', topic: 'purchase_invoice_created', settingKey: 'bills', kind: 'create', syncName: 'moneybird-purchase-invoices' },
  { provider: 'moneybird', topic: 'purchase_invoice_updated', settingKey: 'bills', kind: 'update', syncName: 'moneybird-purchase-invoices' },
  { provider: 'moneybird', topic: 'purchase_invoice_destroyed', settingKey: 'bills', kind: 'delete', syncName: 'moneybird-purchase-invoices' },
  { provider: 'moneybird', topic: 'receipt_created', settingKey: 'bills', kind: 'create', syncName: 'moneybird-receipts' },
  { provider: 'moneybird', topic: 'receipt_updated', settingKey: 'bills', kind: 'update', syncName: 'moneybird-receipts' },
  { provider: 'moneybird', topic: 'receipt_destroyed', settingKey: 'bills', kind: 'delete', syncName: 'moneybird-receipts' },
  { provider: 'moneybird', topic: 'financial_account_created', settingKey: 'bankAccounts', kind: 'create', syncName: 'moneybird-financial-accounts' },
  { provider: 'moneybird', topic: 'financial_account_renamed', settingKey: 'bankAccounts', kind: 'update', syncName: 'moneybird-financial-accounts' },
  { provider: 'moneybird', topic: 'financial_account_activated', settingKey: 'bankAccounts', kind: 'update', syncName: 'moneybird-financial-accounts' },
  { provider: 'moneybird', topic: 'financial_account_deactivated', settingKey: 'bankAccounts', kind: 'update', syncName: 'moneybird-financial-accounts' },
  { provider: 'moneybird', topic: 'financial_account_destroyed', settingKey: 'bankAccounts', kind: 'delete', syncName: 'moneybird-financial-accounts' },
];

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

const TOPICS_BY_PROVIDER: Record<string, ConnectorWebhookTopic[]> = {
  woocommerce: WOOCOMMERCE_WEBHOOK_TOPICS,
  shopify: SHOPIFY_WEBHOOK_TOPICS,
  moneybird: MONEYBIRD_WEBHOOK_TOPICS,
  picqer: PICQER_WEBHOOK_TOPICS,
};

export function webhookTopicsFor(provider: string): ConnectorWebhookTopic[] {
  return TOPICS_BY_PROVIDER[provider] ?? [];
}

export function matchWebhookTopic(provider: string, topic: string): ConnectorWebhookTopic | undefined {
  const normalised = topic.trim().toLowerCase();
  const exact = webhookTopicsFor(provider).find((entry) => entry.topic === normalised);
  if (exact) return exact;
  if (provider !== 'moneybird') return undefined;
  const prefix = webhookTopicsFor(provider).find((entry) => normalised.startsWith(`${entry.topic.split('_').slice(0, -1).join('_')}_`));
  if (prefix) return { ...prefix, topic: normalised, kind: normalised.includes('destroy') ? 'delete' : 'update' };
  if (normalised.startsWith('contact_')) {
    return { provider, topic: normalised, settingKey: 'contacts', kind: normalised.includes('destroy') ? 'delete' : 'update', syncName: 'moneybird-contacts' };
  }
  if (normalised.startsWith('sales_invoice_')) {
    return { provider, topic: normalised, settingKey: 'invoices', kind: normalised.includes('destroy') ? 'delete' : 'update', syncName: 'moneybird-sales-invoices' };
  }
  if (normalised.startsWith('product_')) {
    return { provider, topic: normalised, settingKey: 'products', kind: normalised.includes('destroy') ? 'delete' : 'update', syncName: 'moneybird-products' };
  }
  if (normalised.startsWith('purchase_invoice_')) {
    return { provider, topic: normalised, settingKey: 'bills', kind: normalised.includes('destroy') ? 'delete' : 'update', syncName: 'moneybird-purchase-invoices' };
  }
  if (normalised.startsWith('receipt_')) {
    return { provider, topic: normalised, settingKey: 'bills', kind: normalised.includes('destroy') ? 'delete' : 'update', syncName: 'moneybird-receipts' };
  }
  if (normalised.startsWith('financial_account_')) {
    return {
      provider,
      topic: normalised,
      settingKey: 'bankAccounts',
      kind: normalised.includes('destroy') ? 'delete' : 'update',
      syncName: 'moneybird-financial-accounts',
    };
  }
  return undefined;
}

export function connectorWebhookDeliveryUrl(baseUrl: string, connectionId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
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
  for (const byte of view) binary += String.fromCharCode(byte);
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
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

/** WooCommerce: `X-WC-Webhook-Signature` is HMAC-SHA256 of the raw body, Base64. */
export async function verifyWooCommerceWebhook(args: {
  secret: string;
  body: string;
  signature: string | null | undefined;
}): Promise<boolean> {
  if (!args.signature) return false;
  const expected = await hmacSha256Base64(args.secret, args.body);
  return timingSafeEqual(expected, args.signature.trim());
}

/** Shopify: `X-Shopify-Hmac-Sha256` is HMAC-SHA256 of the raw body, Base64. */
export async function verifyShopifyWebhook(args: {
  secret: string;
  body: string;
  signature: string | null | undefined;
}): Promise<boolean> {
  if (!args.signature) return false;
  const expected = await hmacSha256Base64(args.secret, args.body);
  return timingSafeEqual(expected, args.signature.trim());
}

/** Moneybird: `Moneybird-Signature` is `t=<unix>,v1=<hex hmac of t.body>`. */
export async function verifyMoneybirdWebhook(args: {
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

/** Picqer: `X-Picqer-Signature` is HMAC-SHA256 of the raw body, Base64. */
export async function verifyPicqerWebhook(args: {
  secret: string;
  body: string;
  signature: string | null | undefined;
}): Promise<boolean> {
  if (!args.signature) return false;
  const expected = await hmacSha256Base64(args.secret, args.body);
  return timingSafeEqual(expected, args.signature.trim());
}

export async function verifyConnectorWebhook(args: {
  provider: string;
  secret: string;
  body: string;
  signature: string | null | undefined;
}): Promise<boolean> {
  if (args.provider === 'shopify') return verifyShopifyWebhook(args);
  if (args.provider === 'woocommerce') return verifyWooCommerceWebhook(args);
  if (args.provider === 'moneybird') return verifyMoneybirdWebhook(args);
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
  return null;
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
