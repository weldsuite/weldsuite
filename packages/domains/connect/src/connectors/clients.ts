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
 *
 * Stripe is rebuilt from an allow-list, never copied: the platform key reads
 * *any* connected account, so it is only paired with the account id the OAuth
 * flow wrote (`externalAccountId`, which a PATCH cannot change for OAuth
 * rows). A tampered `stripeUserId`, or a stored `accessToken` /
 * `platformSecretKey`, gets nothing.
 */
export function withRuntimeCredentials(
  connection: Pick<ConnectorConnectionRow, 'provider' | 'settings' | 'externalAccountId'>,
  credentials: Record<string, string>,
  env: ConnectorRuntimeEnv,
): Record<string, string> {
  if (connection.provider !== 'stripe') return credentials;
  const runtime: Record<string, string> = {};
  if (credentials.entityId) runtime.entityId = credentials.entityId;
  const start = connection.settings?.importStartDate?.trim();
  if (start) runtime.importStartDate = start;

  const apiKey = credentials.apiKey?.trim();
  if (apiKey) {
    runtime.apiKey = apiKey;
    return runtime;
  }
  const accountId = credentials.stripeUserId?.trim();
  const platformKey = env.STRIPE_SECRET_KEY?.trim();
  if (accountId && platformKey && accountId === connection.externalAccountId) {
    runtime.stripeUserId = accountId;
    runtime.platformSecretKey = platformKey;
  }
  return runtime;
}

/** The only credential keys a Stripe connection may hold: an OAuth account id, or a pasted key. */
const STRIPE_STORED_KEYS = new Set(['stripeUserId', 'apiKey', 'entityId']);

/**
 * Why a credential change on an existing connection is refused, or null.
 * OAuth Stripe connections can't be re-pointed at another account (reconnect
 * instead); API-key ones may only swap the key.
 */
export function credentialPatchError(
  provider: string,
  existing: Record<string, string>,
  patch: Record<string, string>,
): string | null {
  if (provider !== 'stripe') return null;
  if (!existing.apiKey) return 'Connect Stripe again to change the account of this connection';
  const disallowed = Object.keys(patch).filter((key) => key !== 'apiKey');
  return disallowed.length > 0 ? 'Only the Stripe API key can be changed' : null;
}

/** Credentials a new Stripe connection keeps: only the allow-listed keys, never a platform key or token. */
export function stripeStoredCredentials(credentials: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(credentials).filter(([key]) => STRIPE_STORED_KEYS.has(key)));
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
