/**
 * Provider client factory — decrypt credentials and return the matching client.
 */

import {
  ConnectorApiError,
  createConnectorProviderClient,
  ShopifyClient,
  WooCommerceClient,
  type ConnectorProviderClient,
} from '@weldsuite/connectors';
import type { ConnectorConnectionRow } from './connections';

export type ConnectorClient = ConnectorProviderClient;

export function createConnectorClient(
  provider: string,
  credentials: Record<string, string>,
  fallbackAccountId?: string | null,
): ConnectorClient {
  return createConnectorProviderClient(provider, credentials, fallbackAccountId);
}

export function createProductWriteClient(
  provider: string,
  credentials: Record<string, string>,
  fallbackAccountId?: string | null,
): ShopifyClient | WooCommerceClient {
  const client = createConnectorClient(provider, credentials, fallbackAccountId);
  if (client instanceof ShopifyClient || client instanceof WooCommerceClient) return client;
  throw new ConnectorApiError({
    message: `Provider '${provider}' does not support pushing catalog products`,
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
