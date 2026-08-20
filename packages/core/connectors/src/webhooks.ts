/**
 * Connector webhook helpers — HMAC verification, topic → sync mapping, and
 * delivery URL construction. Stores push changes here; we do not poll.
 */

export type ConnectorWebhookKind = 'create' | 'update' | 'delete';

export interface ConnectorWebhookTopic {
  provider: string;
  topic: string;
  settingKey: 'products' | 'orders' | 'customers';
  kind: ConnectorWebhookKind;
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

const TOPICS_BY_PROVIDER: Record<string, ConnectorWebhookTopic[]> = {
  woocommerce: WOOCOMMERCE_WEBHOOK_TOPICS,
  shopify: SHOPIFY_WEBHOOK_TOPICS,
};

export function webhookTopicsFor(provider: string): ConnectorWebhookTopic[] {
  return TOPICS_BY_PROVIDER[provider] ?? [];
}

export function matchWebhookTopic(provider: string, topic: string): ConnectorWebhookTopic | undefined {
  const normalised = topic.trim().toLowerCase();
  return webhookTopicsFor(provider).find((entry) => entry.topic === normalised);
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

export async function verifyConnectorWebhook(args: {
  provider: string;
  secret: string;
  body: string;
  signature: string | null | undefined;
}): Promise<boolean> {
  if (args.provider === 'shopify') return verifyShopifyWebhook(args);
  if (args.provider === 'woocommerce') return verifyWooCommerceWebhook(args);
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

export function readWebhookSignatureFromHeaders(provider: string, headers: Headers): string | null {
  if (provider === 'woocommerce') {
    return headers.get('x-wc-webhook-signature') ?? headers.get('X-WC-Webhook-Signature');
  }
  if (provider === 'shopify') {
    return headers.get('x-shopify-hmac-sha256') ?? headers.get('X-Shopify-Hmac-Sha256');
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
