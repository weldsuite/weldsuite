/**
 * WooCommerce Application Authentication Endpoint.
 *
 * The merchant enters a store URL. We send them to
 * `{store}/wc-auth/v1/authorize`. After they grant access, WooCommerce POSTs
 * the generated REST API keys to our HTTPS callback, then redirects the
 * browser back to `return_url`. This is not OAuth 2.0 — keys never appear in
 * the redirect query string.
 *
 * @see https://developer.woocommerce.com/docs/apis/rest-api/authentication/#auto-generating-api-keys-using-our-application-authentication-endpoint
 */

import { normalizeStoreUrl } from './client';

export const WOOCOMMERCE_APP_NAME = 'WeldSuite';
export const WOOCOMMERCE_AUTH_SCOPE = 'read_write' as const;
export const WOOCOMMERCE_AUTH_CALLBACK_PATH = '/webhooks/woocommerce/auth';

export function woocommerceAuthKvKey(userId: string): string {
  return `wooauth:${userId}`;
}

export function woocommerceAuthCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${WOOCOMMERCE_AUTH_CALLBACK_PATH}`;
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

export interface WooCommerceAuthKvEntry {
  workspaceId: string;
  clerkOrgId: string;
  connectionId: string;
  storeUrl: string;
  enabledSyncs: string[];
  userId: string;
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
    path === '/settings/integrations/woocommerce' ||
    path === '/settings/integrations/woocommerce/' ||
    path === '/weldconnect/connectors' ||
    path === '/weldconnect/connectors/' ||
    path.startsWith('/settings/integrations/woocommerce/') ||
    path.startsWith('/weldconnect/connectors/')
  );
}
