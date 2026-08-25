/**
 * WooCommerce Application Authentication Endpoint.
 *
 * The merchant enters a store URL. We send them to
 * `{store}/wc-auth/v1/authorize`. After they grant access, WooCommerce POSTs
 * the generated REST API keys to our HTTPS callback, then redirects the
 * browser back to `return_url`. This is not OAuth 2.0 — keys never appear in
 * the redirect query string.
 *
 * WooCommerce requires the callback to return HTTP 200. Anything else shows
 * "An error occurred in the request and at the time were unable to send the
 * consumer data" and deletes the keys it just created. Do not call the shop
 * (REST test, webhook registration) until after that 200.
 *
 * @see https://developer.woocommerce.com/docs/apis/rest-api/authentication/#auto-generating-api-keys-using-our-application-authentication-endpoint
 */

import { normalizeStoreUrl } from './client';

export const WOOCOMMERCE_APP_NAME = 'WeldSuite';
export const WOOCOMMERCE_AUTH_SCOPE = 'read_write' as const;
export const WOOCOMMERCE_AUTH_CALLBACK_PATH = '/webhooks/woocommerce/auth';
export const WOOCOMMERCE_AUTH_STATE_TTL_SECONDS = 15 * 60;

export function woocommerceAuthCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${WOOCOMMERCE_AUTH_CALLBACK_PATH}`;
}

/**
 * Callback must be HTTPS on this worker (app-api), not the webhook worker.
 * Prefer the authorize request's own origin so a preview/workers.dev host
 * receives the keys without waiting for a separate deploy.
 */
export function resolveWooCommerceAuthCallbackUrl(args: {
  requestOrigin?: string;
  appApiPublicUrl?: string;
  environment?: string;
}): string | null {
  const httpsOrigin = (value: string | undefined): string | null => {
    if (!value) return null;
    try {
      const parsed = new URL(value.includes('://') ? value : `https://${value}`);
      if (parsed.protocol !== 'https:') return null;
      return parsed.origin;
    } catch {
      return null;
    }
  };

  const fromEnv =
    args.environment === 'production'
      ? 'https://app-api.weldsuite.org'
      : args.environment === 'test'
        ? 'https://app-api-test.weldsuite.org'
        : null;

  const origin =
    httpsOrigin(args.requestOrigin) ?? httpsOrigin(args.appApiPublicUrl) ?? httpsOrigin(fromEnv ?? undefined);
  return origin ? woocommerceAuthCallbackUrl(origin) : null;
}

export interface WooCommerceAuthUrlArgs {
  storeUrl: string;
  appName?: string;
  scope?: typeof WOOCOMMERCE_AUTH_SCOPE | 'read' | 'write';
  userId: string;
  returnUrl: string;
  callbackUrl: string;
}

export function buildWooCommerceAuthUrl(args: WooCommerceAuthUrlArgs): string {
  const store = normalizeStoreUrl(args.storeUrl);
  const params = new URLSearchParams({
    app_name: args.appName ?? WOOCOMMERCE_APP_NAME,
    scope: args.scope ?? WOOCOMMERCE_AUTH_SCOPE,
    user_id: args.userId,
    return_url: args.returnUrl,
    callback_url: args.callbackUrl,
  });
  return `${store}/wc-auth/v1/authorize?${params.toString()}`;
}

export interface WooCommerceAuthCallbackPayload {
  keyId: number | null;
  userId: string;
  consumerKey: string;
  consumerSecret: string;
  keyPermissions: string | null;
}

export function parseWooCommerceAuthCallback(body: string): WooCommerceAuthCallbackPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const userId = typeof record.user_id === 'string' ? record.user_id.trim() : String(record.user_id ?? '').trim();
  const consumerKey = typeof record.consumer_key === 'string' ? record.consumer_key.trim() : '';
  const consumerSecret = typeof record.consumer_secret === 'string' ? record.consumer_secret.trim() : '';
  if (!userId || !consumerKey || !consumerSecret) return null;
  const keyId = typeof record.key_id === 'number' ? record.key_id : Number(record.key_id);
  return {
    keyId: Number.isFinite(keyId) ? keyId : null,
    userId,
    consumerKey,
    consumerSecret,
    keyPermissions: typeof record.key_permissions === 'string' ? record.key_permissions : null,
  };
}

export interface WooCommerceAuthState {
  clerkOrgId: string;
  connectionId: string;
  connectedBy: string;
  exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function signWooCommerceAuthUserId(
  state: Omit<WooCommerceAuthState, 'exp'>,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = WOOCOMMERCE_AUTH_STATE_TTL_SECONDS,
): Promise<string> {
  const payload: WooCommerceAuthState = { ...state, exp: nowSeconds + ttlSeconds };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = toBase64Url(await hmacSha256(secret, body));
  return `wooa.${body}.${mac}`;
}

export async function verifyWooCommerceAuthUserId(
  userId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<WooCommerceAuthState | null> {
  if (!secret) return null;
  const parts = userId.split('.');
  if (parts.length !== 3 || parts[0] !== 'wooa') return null;
  const [, body, mac] = parts;
  if (!body || !mac) return null;
  try {
    const expected = await hmacSha256(secret, body);
    if (!bytesEqual(fromBase64Url(mac), expected)) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as WooCommerceAuthState;
    if (!parsed.clerkOrgId || !parsed.connectionId || !parsed.connectedBy || typeof parsed.exp !== 'number') {
      return null;
    }
    if (parsed.exp < nowSeconds) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Browser return_url after the merchant grants or denies access. */
export function isAllowedConnectorReturnUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname;
  const allowedHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === 'app.weldsuite.org' ||
    host === 'app-test.weldsuite.org' ||
    host.endsWith('.weldsuite.pages.dev');
  if (!allowedHost) return false;
  const path = parsed.pathname;
  return (
    path === '/weldconnect/connectors' ||
    path === '/weldconnect/connectors/' ||
    path.startsWith('/weldconnect/connectors/') ||
    path.startsWith('/settings/integrations/woocommerce') ||
    path.startsWith('/settings/integrations/shopify') ||
    path.startsWith('/settings/integrations/moneybird')
  );
}
