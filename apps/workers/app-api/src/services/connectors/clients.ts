/**
 * Provider client factory — decrypt credentials and return the matching client.
 */

import {
  ConnectorApiError,
  ShopifyClient,
  WooCommerceClient,
} from '@weldsuite/connectors';
import type { ConnectorConnectionRow } from './connections';

export type ConnectorClient = WooCommerceClient | ShopifyClient;

export function createConnectorClient(
  provider: string,
  credentials: Record<string, string>,
  fallbackAccountId?: string | null,
): ConnectorClient {
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
  throw new ConnectorApiError({
    message: `No sync client for provider '${provider}'`,
    status: 400,
    kind: 'permanent',
  });
}

export function storeUrlOf(client: ConnectorClient): string {
  return client.storeUrl;
}

export async function testConnectorCredentials(
  provider: string,
  credentials: Record<string, string>,
): Promise<{ ok: true; storeUrl: string } | { ok: false; message: string }> {
  try {
    const client = createConnectorClient(provider, credentials);
    return client.test();
  } catch (err) {
    return {
      ok: false,
      message: err instanceof ConnectorApiError ? err.message : `Unknown connector '${provider}'`,
    };
  }
}

export function connectionDisplayAccount(row: ConnectorConnectionRow): string | null {
  return row.externalAccountId;
}
