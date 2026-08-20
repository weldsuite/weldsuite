/**
 * WooCommerce application authentication (store URL → grant on the shop →
 * keys POST to our HTTPS callback). Not OAuth 2.0: the redirect never carries
 * secrets; WooCommerce posts `{ consumer_key, consumer_secret }` separately.
 *
 * The callback MUST return HTTP 200 before we call the shop. WooCommerce's
 * PHP request waits on that POST (60s). A non-200 (or a REST call back into
 * the same store) surfaces as: "An error occurred in the request and at the
 * time were unable to send the consumer data" and Woo deletes the keys.
 */

import {
  buildWooCommerceAuthUrl,
  generateWebhookSecret,
  isAllowedConnectorReturnUrl,
  normalizeStoreUrl,
  parseWooCommerceAuthCallback,
  resolveWooCommerceAuthCallbackUrl,
  signWooCommerceAuthUserId,
  verifyWooCommerceAuthUserId,
  ConnectorApiError,
} from '@weldsuite/connectors';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace, getWorkspaceForOrg, type Database } from '../../db';
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
import { syncConnection } from './sync';
import { putConnectorWebhookMapping, registerConnectionWebhooks } from './webhooks';

function signingSecret(env: Env): string | null {
  const secret = env.INTERNAL_API_SECRET?.trim();
  return secret || null;
}

export async function startWooCommerceAppAuth(args: {
  db: Database;
  env: Env;
  clerkOrgId: string;
  userId: string;
  storeUrl: string;
  enabledSyncs: string[];
  displayName?: string;
  returnUrl: string;
  requestOrigin?: string;
}): Promise<{ authorizeUrl: string; connectionId: string } | { error: string; status: 400 }> {
  if (!isAllowedConnectorReturnUrl(args.returnUrl)) {
    return { error: 'Return URL is not a WeldSuite page', status: 400 };
  }

  const callbackUrl = resolveWooCommerceAuthCallbackUrl({
    requestOrigin: args.requestOrigin,
    appApiPublicUrl: args.env.APP_API_PUBLIC_URL,
    environment: args.env.ENVIRONMENT,
  });
  if (!callbackUrl) {
    return {
      error:
        'WooCommerce needs a public HTTPS callback to send API keys. Set APP_API_PUBLIC_URL to this worker’s HTTPS origin.',
      status: 400,
    };
  }

  const secret = signingSecret(args.env);
  if (!secret) {
    return { error: 'WooCommerce connect is not configured (missing internal signing secret)', status: 400 };
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

  const userId = await signWooCommerceAuthUserId(
    {
      clerkOrgId: args.clerkOrgId,
      connectionId: row.id,
      connectedBy: args.userId,
    },
    secret,
  );

  return {
    connectionId: row.id,
    authorizeUrl: buildWooCommerceAuthUrl({
      storeUrl,
      userId,
      returnUrl: args.returnUrl,
      callbackUrl,
    }),
  };
}

export async function completeWooCommerceAppAuth(args: {
  env: Env;
  rawBody: string;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<{ ok: boolean; status: number; message: string }> {
  const payload = parseWooCommerceAuthCallback(args.rawBody);
  if (!payload) {
    return { ok: false, status: 400, message: 'invalid WooCommerce auth payload' };
  }

  const secret = signingSecret(args.env);
  const state = secret ? await verifyWooCommerceAuthUserId(payload.userId, secret) : null;
  if (!state) {
    return { ok: false, status: 400, message: 'unknown or expired WooCommerce auth' };
  }

  const db = await getTenantDbForWorkspace(args.env, state.clerkOrgId);
  const row = await getConnectionById(db, state.connectionId);
  if (!row) {
    return { ok: false, status: 400, message: 'connection not found' };
  }

  const storeUrl = row.externalAccountId || '';
  if (!storeUrl) {
    return { ok: false, status: 400, message: 'connection is missing a store URL' };
  }

  const credentials = {
    storeUrl,
    consumerKey: payload.consumerKey,
    consumerSecret: payload.consumerSecret,
  };

  const keyring = keyringFromEnv(args.env);
  const encrypted = await encryptCredentials(credentials, keyring);
  const rawWebhookSecret = generateWebhookSecret();
  const encryptedWebhookSecret = await encryptWebhookSecret(rawWebhookSecret, keyring);

  await updateConnectionSettings({
    db,
    connectionId: row.id,
    credentials: encrypted,
    externalAccountId: storeUrl,
    webhookSecret: encryptedWebhookSecret,
    enabledSyncs: row.enabledSyncs ?? undefined,
  });

  const fresh = await getConnectionById(db, row.id);
  if (!fresh) {
    return { ok: false, status: 500, message: 'connection vanished after save' };
  }

  args.waitUntil(
    (async () => {
      try {
        await registerConnectionWebhooks({
          db,
          env: args.env,
          connection: fresh,
          credentials,
          webhookSecret: rawWebhookSecret,
        });
      } catch (err) {
        console.error('[connectors/auth] webhook registration failed', err);
      }

      try {
        const { id: workspaceId } = await getWorkspaceForOrg(args.env, state.clerkOrgId);
        await putConnectorWebhookMapping({
          env: args.env,
          connectionId: fresh.id,
          workspaceId,
          provider: 'woocommerce',
        });
      } catch (err) {
        console.error('[connectors/auth] webhook KV mapping failed', err);
      }

      try {
        await publishEntityEventRaw({
          env: args.env as never,
          db: db as never,
          workspaceId: state.clerkOrgId,
          userId: state.connectedBy,
          entityType: 'connector_connection',
          action: 'connected',
          entityId: fresh.id,
          data: sanitizeConnection(fresh) as unknown as Record<string, unknown>,
        });
      } catch (err) {
        console.error('[connectors/auth] entity event failed', err);
      }

      try {
        await syncConnection({
          db,
          env: args.env,
          connection: fresh,
          ownerId: state.connectedBy,
          workspaceId: state.clerkOrgId,
          trigger: 'initial',
        });
      } catch (err) {
        console.error('[connectors/auth] initial sync failed:', err);
      }
    })(),
  );

  return { ok: true, status: 200, message: 'connected' };
}
