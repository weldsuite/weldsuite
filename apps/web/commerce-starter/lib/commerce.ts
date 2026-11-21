import 'server-only';

import { createStorefrontClient, type RequestOptions, type StorefrontClient } from '@weldsuite/commerce-sdk';
import { headers } from 'next/headers';

/** The shop's settings, read from the environment (see .env.example). */
export const shopLocale = process.env.SHOP_LOCALE || 'en-IE';
export const shopTimeZone = process.env.SHOP_TIME_ZONE || 'Europe/Amsterdam';

export class ShopNotConfiguredError extends Error {
  constructor() {
    super('Set WELDCOMMERCE_API_URL and WELDCOMMERCE_KEY (see .env.example).');
    this.name = 'ShopNotConfiguredError';
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.WELDCOMMERCE_API_URL && process.env.WELDCOMMERCE_KEY);
}

let client: StorefrontClient | undefined;

/**
 * The storefront client, with the private key (wcs_…). Server-side only:
 * this module can't be imported into a client component.
 */
export function storefront(): StorefrontClient {
  if (client) return client;
  const baseUrl = process.env.WELDCOMMERCE_API_URL;
  const key = process.env.WELDCOMMERCE_KEY;
  if (!baseUrl || !key) throw new ShopNotConfiguredError();
  client = createStorefrontClient({
    baseUrl,
    key,
    // Wait a few seconds and retry once when the API says "too many requests".
    rateLimitRetries: 1,
    maxRetryAfter: 3,
  });
  return client;
}

const ADDRESS = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The shopper's IP address, so the storefront API's rate limits count per
 * shopper rather than for this whole server. Behind your own proxy, read the
 * header it sets (hosting platforms set x-real-ip / x-forwarded-for).
 */
export async function requestOptions(): Promise<RequestOptions> {
  const list = await headers();
  const candidate = list.get('x-real-ip') ?? list.get('x-forwarded-for')?.split(',')[0];
  const shopperIp = candidate?.trim();
  return shopperIp && ADDRESS.test(shopperIp) ? { shopperIp } : {};
}

/**
 * The shop's public address, for Mollie's return URL and the order links in
 * emails: SHOP_URL, or the address this request came in on.
 */
export async function shopUrl(): Promise<string> {
  let configured = process.env.SHOP_URL ?? '';
  while (configured.endsWith('/')) configured = configured.slice(0, -1);
  if (configured) return configured;
  const list = await headers();
  const host = list.get('x-forwarded-host') ?? list.get('host') ?? 'localhost:3030';
  const proto = list.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}
