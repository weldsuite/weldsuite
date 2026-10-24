/**
 * Provider client factory — decrypt credentials and return the matching client.
 */

import {
  ConnectorApiError,
  createConnectorProviderClient,
  PicqerClient,
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
): ShopifyClient | WooCommerceClient | PicqerClient {
  const client = createConnectorClient(provider, credentials, fallbackAccountId);
  if (
    client instanceof ShopifyClient
    || client instanceof WooCommerceClient
    || client instanceof PicqerClient
  ) {
    return client;
  }
  throw new ConnectorApiError({
    message: `Provider '${provider}' does not support pushing catalog products`,
    status: 400,
    kind: 'permanent',
  });
}

export function storeUrlOf(client: ConnectorClient): string {
  return client.storeUrl;
}

/** Worker secrets a provider client may need besides the stored credentials. */
export interface ConnectorRuntimeEnv {
  /** WeldSuite's Stripe platform key: OAuth Stripe connections call the API with it + `Stripe-Account`. */
  STRIPE_SECRET_KEY?: string;
}

/**
 * Stored credentials plus what the client needs at run time but must never be
 * stored with them: the Stripe platform key and the connection's import start
 * date. Never encrypt the result back onto the row.
 */
export function withRuntimeCredentials(
  connection: Pick<ConnectorConnectionRow, 'provider' | 'settings'>,
  credentials: Record<string, string>,
  env: ConnectorRuntimeEnv,
): Record<string, string> {
  if (connection.provider !== 'stripe') return credentials;
  const runtime = { ...credentials };
  const start = connection.settings?.importStartDate?.trim();
  if (start) runtime.importStartDate = start;
  const platformKey = env.STRIPE_SECRET_KEY?.trim();
  if (!runtime.apiKey && platformKey) runtime.platformSecretKey = platformKey;
  return runtime;
}

/** Moneybird financial accounts the inbound sync must not import (the one WeldBooks fills from Stripe). */
export function skippedFinancialAccountIds(connection: Pick<ConnectorConnectionRow, 'provider' | 'settings'>): string[] {
  if (connection.provider !== 'moneybird') return [];
  // Even while sending is paused: what was already posted there is a copy of the Stripe balance.
  const accountId = connection.settings?.moneybirdPush?.financialAccountId;
  return accountId ? [accountId] : [];
}

export function testConnectorCredentials(
  provider: string,
  credentials: Record<string, string>,
): Promise<{ ok: true; storeUrl: string; accountName?: string } | { ok: false; message: string }> {
  try {
    const client = createConnectorClient(provider, credentials);
    return client.test();
  } catch (err) {
    return Promise.resolve({
      ok: false,
      message: err instanceof ConnectorApiError ? err.message : `Unknown connector '${provider}'`,
    });
  }
}

export function connectionDisplayAccount(row: ConnectorConnectionRow): string | null {
  return row.externalAccountId;
}
