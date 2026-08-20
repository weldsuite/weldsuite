/**
 * WooCommerce application authentication (store URL → grant on the shop →
 * keys POST to our HTTPS callback). Not OAuth 2.0: the redirect never carries
 * secrets; WooCommerce posts `{ consumer_key, consumer_secret }` separately.
 */

import {
  buildWooCommerceAuthUrl,
  generateWebhookSecret,
  isAllowedConnectorReturnUrl,
  normalizeStoreUrl,
  parseWooCommerceAuthCallback,
  woocommerceAuthCallbackUrl,
  woocommerceAuthKvKey,
  ConnectorApiError,
  type WooCommerceAuthKvEntry,
} from '@weldsuite/connectors';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { Database } from '../../db';
import { getWorkspaceForOrg } from '../../db';
import type { Env } from '../../types';
import {
  encryptCredentials,
  encryptWebhookSecret,
  ensurePendingConnection,
  getConnectionById,
  keyringFromEnv,
  sanitizeConnection,
  updateConnectionSettings,
} from './connections';
import { testConnectorCredentials } from './clients';
import { syncConnection } from './sync';
import {
  connectorWebhookBaseUrl,
  putConnectorWebhookMapping,
  registerConnectionWebhooks,
} from './webhooks';

const AUTH_STATE_TTL_SECONDS = 15 * 60;

export async function startWooCommerceAppAuth(args: {
  db: Database;
  env: Env;
  clerkOrgId: string;
  userId: string;
  storeUrl: string;
  enabledSyncs: string[];
  displayName?: string;
  returnUrl: string;
}): Promise<{ authorizeUrl: string; connectionId: string } | { error: string; status: 400 }> {
  if (!isAllowedConnectorReturnUrl(args.returnUrl)) {
    return { error: 'Return URL is not a WeldSuite page', status: 400 };
  }

  const callbackUrl = woocommerceAuthCallbackUrl(connectorWebhookBaseUrl(args.env));
  if (!callbackUrl.startsWith('https://')) {
    return {
      error:
        'WooCommerce needs a public HTTPS callback to send API keys. Set CONNECTOR_WEBHOOK_BASE_URL to the integration-webhooks host.',
      status: 400,
    };
  }

  let storeUrl: string;
  try {
    storeUrl = normalizeStoreUrl(args.storeUrl);
  } catch (err) {
    const message =
      err instanceof ConnectorApiError ? err.message : err instanceof Error ? err.message : 'Store URL is not valid';
    return { error: message, status: 400 };
  }

  let hostname = storeUrl;
  try {
    hostname = new URL(storeUrl).host;
  } catch {
    /* keep storeUrl */
  }
  const label = args.displayName?.trim() || `WooCommerce (${hostname})`;

  const row = await ensurePendingConnection({
    db: args.db,
    provider: 'woocommerce',
    displayName: label,
    userId: args.userId,
    enabledSyncs: args.enabledSyncs,
    externalAccountId: storeUrl,
  });

  const { id: workspaceId } = await getWorkspaceForOrg(args.env, args.clerkOrgId);
  const nonce = `wooa_${crypto.randomUUID()}`;
  const entry: WooCommerceAuthKvEntry = {
    workspaceId,
    clerkOrgId: args.clerkOrgId,
    connectionId: row.id,
    storeUrl,
    enabledSyncs: args.enabledSyncs,
    userId: args.userId,
  };
  await args.env.WORKSPACE_CACHE.put(woocommerceAuthKvKey(nonce), JSON.stringify(entry), {
    expirationTtl: AUTH_STATE_TTL_SECONDS,
  });

  return {
    connectionId: row.id,
    authorizeUrl: buildWooCommerceAuthUrl({
      storeUrl,
      userId: nonce,
      returnUrl: args.returnUrl,
      callbackUrl,
    }),
  };
}

export async function completeWooCommerceAppAuth(args: {
  db: Database;
  env: Env;
  clerkOrgId: string;
  rawBody: string;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<{ ok: boolean; status: number; message: string }> {
  const payload = parseWooCommerceAuthCallback(args.rawBody);
  if (!payload) {
    return { ok: false, status: 400, message: 'invalid WooCommerce auth payload' };
  }

  const kvKey = woocommerceAuthKvKey(payload.userId);
  const stored = (await args.env.WORKSPACE_CACHE.get(kvKey, 'json')) as WooCommerceAuthKvEntry | null;
  if (!stored || stored.clerkOrgId !== args.clerkOrgId) {
    return { ok: false, status: 404, message: 'unknown or expired WooCommerce auth' };
  }

  const row = await getConnectionById(args.db, stored.connectionId);
  if (!row) {
    return { ok: false, status: 404, message: 'connection not found' };
  }

  const credentials = {
    storeUrl: stored.storeUrl,
    consumerKey: payload.consumerKey,
    consumerSecret: payload.consumerSecret,
  };
  const tested = await testConnectorCredentials('woocommerce', credentials);
  if (!tested.ok) {
    return { ok: false, status: 400, message: tested.message };
  }

  const keyring = keyringFromEnv(args.env);
  const encrypted = await encryptCredentials(credentials, keyring);
  const rawWebhookSecret = generateWebhookSecret();
  const encryptedWebhookSecret = await encryptWebhookSecret(rawWebhookSecret, keyring);

  await updateConnectionSettings({
    db: args.db,
    connectionId: row.id,
    credentials: encrypted,
    externalAccountId: tested.storeUrl,
    webhookSecret: encryptedWebhookSecret,
    enabledSyncs: stored.enabledSyncs,
  });

  const fresh = await getConnectionById(args.db, row.id);
  if (!fresh) {
    return { ok: false, status: 500, message: 'connection vanished after save' };
  }

  try {
    await registerConnectionWebhooks({
      db: args.db,
      env: args.env,
      connection: { ...fresh, enabledSyncs: stored.enabledSyncs },
      credentials,
      webhookSecret: rawWebhookSecret,
    });
  } catch (err) {
    console.error('[connectors/auth] webhook registration failed', err);
  }

  try {
    await putConnectorWebhookMapping({
      env: args.env,
      connectionId: fresh.id,
      workspaceId: stored.workspaceId,
      provider: 'woocommerce',
    });
  } catch (err) {
    console.error('[connectors/auth] webhook KV mapping failed', err);
  }

  await args.env.WORKSPACE_CACHE.delete(kvKey);

  await publishEntityEventRaw({
    env: args.env as never,
    db: args.db as never,
    workspaceId: stored.clerkOrgId,
    userId: stored.userId,
    entityType: 'connector_connection',
    action: 'connected',
    entityId: fresh.id,
    data: sanitizeConnection(fresh) as unknown as Record<string, unknown>,
  });

  args.waitUntil(
    syncConnection({
      db: args.db,
      env: args.env,
      connection: fresh,
      ownerId: stored.userId,
      workspaceId: stored.clerkOrgId,
      trigger: 'initial',
    }).catch((err) => {
      console.error('[connectors/auth] initial sync failed:', err);
    }),
  );

  return { ok: true, status: 200, message: 'connected' };
}
