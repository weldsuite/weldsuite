/**
 * Provider client factory — decrypt credentials and return the matching client.
 * Sync, probe, and webhook registration call this instead of `instanceof`.
 */

import { ConnectorApiError } from './types';
import type { ConnectorProviderClient } from './provider-client';
import { MoneybirdClient } from './moneybird/client';
import { PicqerClient } from './picqer/client';
import { ShopifyClient } from './shopify/client';
import { WooCommerceClient } from './woocommerce/client';

export function createConnectorProviderClient(
  provider: string,
  credentials: Record<string, string>,
  fallbackAccountId?: string | null,
): ConnectorProviderClient {
  if (provider === 'woocommerce') {
    return new WooCommerceClient({
      storeUrl: credentials.storeUrl || fallbackAccountId || '',
      consumerKey: credentials.consumerKey || '',
      consumerSecret: credentials.consumerSecret || '',
    });
  }
  if (provider === 'shopify') {
    return new ShopifyClient({
      shopDomain: credentials.shopDomain || fallbackAccountId || '',
      accessToken: credentials.accessToken || '',
      apiSecret: credentials.apiSecret || '',
    });
  }
  if (provider === 'moneybird') {
    return new MoneybirdClient({
      accessToken: credentials.accessToken || '',
      refreshToken: credentials.refreshToken || null,
      administrationId: credentials.administrationId || fallbackAccountId || null,
    });
  }
  if (provider === 'picqer') {
    const fromCreds = credentials.subdomain?.trim();
    const fromAccount = (fallbackAccountId || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\.picqer\.com.*$/i, '')
      .replace(/\/+$/, '');
    return new PicqerClient({
      subdomain: fromCreds || fromAccount || '',
      apiKey: credentials.apiKey || '',
    });
  }
  throw new ConnectorApiError({
    message: `No sync client for provider '${provider}'`,
    status: 400,
    kind: 'permanent',
  });
}
