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

import { eq } from 'drizzle-orm';
import {
  buildMoneybirdAuthorizeUrl,
  buildWooCommerceAuthUrl,
  exchangeMoneybirdCode,
  generateWebhookSecret,
  isAllowedConnectorReturnUrl,
  MONEYBIRD_AUTH_STATE_TTL_SECONDS,
  MoneybirdClient,
  moneybirdRedirectUri,
  normalizeStoreUrl,
  parseWooCommerceAuthCallback,
  resolveWooCommerceAuthCallbackUrl,
  signWooCommerceAuthUserId,
  verifyWooCommerceAuthUserId,
  ConnectorApiError,
  type MoneybirdAdministration,
} from '@weldsuite/connectors';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace, getWorkspaceForOrg, schema, type Database } from '../../db';
import type { Env } from '../../types';
import {
  decryptCredentials,
  encryptCredentials,
  encryptWebhookSecret,
  ensurePendingConnection,
  getConnectionById,
  keyringFromEnv,
  sanitizeConnection,
  updateConnectionSettings,
  upsertConnection,
} from './connections';
import { syncConnection } from './sync';
import { putConnectorWebhookMapping, registerConnectionWebhooks } from './webhooks';
import { upsertConnectorIndexFromRow } from '../../lib/connector-sync-index';

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

  try {
    const { id: workspaceId } = await getWorkspaceForOrg(args.env, state.clerkOrgId);
    await upsertConnectorIndexFromRow(args.env, {
      connection: fresh,
      workspaceId,
      clerkOrgId: state.clerkOrgId,
      enabled: true,
    });
  } catch (err) {
    console.warn('[connectors/auth] D1 index upsert failed', err);
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

const MONEYBIRD_STATE_PREFIX = 'mb_oauth_state:';

interface MoneybirdOAuthState {
  clerkOrgId: string;
  userId: string;
  enabledSyncs: string[];
  displayName?: string;
  returnUrl: string;
  entityId?: string | null;
}

function moneybirdAppCredentials(env: Env): { clientId: string; clientSecret: string } | { error: string } {
  const clientId = env.MONEYBIRD_CLIENT_ID?.trim();
  const clientSecret = env.MONEYBIRD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return { error: 'Moneybird connect is not configured (missing MONEYBIRD_CLIENT_ID / MONEYBIRD_CLIENT_SECRET)' };
  }
  return { clientId, clientSecret };
}

export async function startMoneybirdOAuth(args: {
  env: Env;
  clerkOrgId: string;
  userId: string;
  enabledSyncs: string[];
  displayName?: string;
  returnUrl: string;
  entityId?: string | null;
}): Promise<{ authorizeUrl: string } | { error: string; status: 400 }> {
  if (!isAllowedConnectorReturnUrl(args.returnUrl)) {
    return { error: 'Return URL is not a WeldSuite page', status: 400 };
  }
  const app = moneybirdAppCredentials(args.env);
  if ('error' in app) return { error: app.error, status: 400 };

  const state = crypto.randomUUID();
  const payload: MoneybirdOAuthState = {
    clerkOrgId: args.clerkOrgId,
    userId: args.userId,
    enabledSyncs: args.enabledSyncs,
    displayName: args.displayName,
    returnUrl: args.returnUrl,
    entityId: args.entityId ?? null,
  };
  await args.env.WORKSPACE_CACHE.put(`${MONEYBIRD_STATE_PREFIX}${state}`, JSON.stringify(payload), {
    expirationTtl: MONEYBIRD_AUTH_STATE_TTL_SECONDS,
  });

  const publicAppUrl = args.env.PUBLIC_APP_URL || 'https://app.weldsuite.org';
  return {
    authorizeUrl: buildMoneybirdAuthorizeUrl({
      clientId: app.clientId,
      redirectUri: moneybirdRedirectUri(publicAppUrl),
      state,
    }),
  };
}

async function finishMoneybirdConnection(args: {
  db: Database;
  env: Env;
  connection: Awaited<ReturnType<typeof getConnectionById>>;
  clerkOrgId: string;
  userId: string;
  credentials: Record<string, string>;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<void> {
  const row = args.connection;
  if (!row) return;
  const rawWebhookSecret = generateWebhookSecret();
  try {
    await registerConnectionWebhooks({
      db: args.db,
      env: args.env,
      connection: row,
      credentials: args.credentials,
      webhookSecret: rawWebhookSecret,
    });
  } catch (err) {
    console.error('[connectors/auth] Moneybird webhook registration failed', err);
  }

  try {
    const { id: workspaceId } = await getWorkspaceForOrg(args.env, args.clerkOrgId);
    await putConnectorWebhookMapping({
      env: args.env,
      connectionId: row.id,
      workspaceId,
      provider: 'moneybird',
    });
    const fresh = await getConnectionById(args.db, row.id);
    if (fresh) {
      await upsertConnectorIndexFromRow(args.env, {
        connection: fresh,
        workspaceId,
        clerkOrgId: args.clerkOrgId,
        enabled: true,
      });
    }
  } catch (err) {
    console.warn('[connectors/auth] Moneybird D1/KV index failed', err);
  }

  args.waitUntil(
    (async () => {
      try {
        await publishEntityEventRaw({
          env: args.env as never,
          db: args.db as never,
          workspaceId: args.clerkOrgId,
          userId: args.userId,
          entityType: 'connector_connection',
          action: 'connected',
          entityId: row.id,
          data: sanitizeConnection(row) as unknown as Record<string, unknown>,
        });
      } catch (err) {
        console.error('[connectors/auth] Moneybird entity event failed', err);
      }
      try {
        const fresh = await getConnectionById(args.db, row.id);
        if (!fresh) return;
        await syncConnection({
          db: args.db,
          env: args.env,
          connection: fresh,
          ownerId: args.userId,
          workspaceId: args.clerkOrgId,
          trigger: 'initial',
        });
      } catch (err) {
        console.error('[connectors/auth] Moneybird initial sync failed:', err);
      }
    })(),
  );
}

export async function completeMoneybirdOAuth(args: {
  env: Env;
  code: string;
  state: string;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<
  | {
      connection: ReturnType<typeof sanitizeConnection>;
      administrations: MoneybirdAdministration[];
      needsPicker: boolean;
      returnUrl: string;
    }
  | { error: string; status: number }
> {
  const raw = await args.env.WORKSPACE_CACHE.get(`${MONEYBIRD_STATE_PREFIX}${args.state}`);
  if (!raw) return { error: 'Unknown or expired Moneybird authorisation', status: 400 };
  await args.env.WORKSPACE_CACHE.delete(`${MONEYBIRD_STATE_PREFIX}${args.state}`);

  let oauthState: MoneybirdOAuthState;
  try {
    oauthState = JSON.parse(raw) as MoneybirdOAuthState;
  } catch {
    return { error: 'Corrupt Moneybird authorisation state', status: 400 };
  }

  const app = moneybirdAppCredentials(args.env);
  if ('error' in app) return { error: app.error, status: 400 };

  const publicAppUrl = args.env.PUBLIC_APP_URL || 'https://app.weldsuite.org';
  let tokens;
  try {
    tokens = await exchangeMoneybirdCode({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code: args.code,
      redirectUri: moneybirdRedirectUri(publicAppUrl),
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Moneybird token exchange failed',
      status: 400,
    };
  }

  const client = new MoneybirdClient({ accessToken: tokens.accessToken });
  let administrations: MoneybirdAdministration[];
  try {
    administrations = await client.listAdministrations();
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Could not list Moneybird administrations',
      status: 400,
    };
  }
  if (administrations.length === 0) {
    return { error: 'This Moneybird account has no administrations', status: 400 };
  }

  const db = await getTenantDbForWorkspace(args.env, oauthState.clerkOrgId);
  const keyring = keyringFromEnv(args.env);
  const single = administrations.length === 1 ? administrations[0] : null;
  const credentials: Record<string, string> = {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(single ? { administrationId: single.id } : {}),
    ...(oauthState.entityId ? { entityId: oauthState.entityId } : {}),
  };
  const encrypted = await encryptCredentials(credentials, keyring);
  const label =
    oauthState.displayName?.trim()
    || (single ? `Moneybird (${single.name})` : 'Moneybird');

  if (single) {
    const row = await upsertConnection({
      db,
      provider: 'moneybird',
      displayName: label,
      userId: oauthState.userId,
      credentials: encrypted,
      enabledSyncs: oauthState.enabledSyncs,
      externalAccountId: single.id,
    });
    await finishMoneybirdConnection({
      db,
      env: args.env,
      connection: row,
      clerkOrgId: oauthState.clerkOrgId,
      userId: oauthState.userId,
      credentials,
      waitUntil: args.waitUntil,
    });
    const fresh = await getConnectionById(db, row.id);
    return {
      connection: sanitizeConnection(fresh ?? row, { entityId: credentials.entityId ?? null }),
      administrations,
      needsPicker: false,
      returnUrl: oauthState.returnUrl,
    };
  }

  const pending = await ensurePendingConnection({
    db,
    provider: 'moneybird',
    displayName: label,
    userId: oauthState.userId,
    enabledSyncs: oauthState.enabledSyncs,
    externalAccountId: `pending:oauth:${oauthState.userId}`,
  });
  await updateConnectionSettings({
    db,
    connectionId: pending.id,
    credentials: encrypted,
    displayName: label,
    enabledSyncs: oauthState.enabledSyncs,
    externalAccountId: `pending:${pending.id}`,
  });
  await db
    .update(schema.connectorConnections)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(schema.connectorConnections.id, pending.id));

  const fresh = await getConnectionById(db, pending.id);
  return {
    connection: sanitizeConnection(fresh ?? pending, { entityId: credentials.entityId ?? null }),
    administrations,
    needsPicker: true,
    returnUrl: oauthState.returnUrl,
  };
}

export async function selectMoneybirdAdministration(args: {
  db: Database;
  env: Env;
  connectionId: string;
  administrationId: string;
  clerkOrgId: string;
  userId: string;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<{ connection: ReturnType<typeof sanitizeConnection> } | { error: string; status: number }> {
  const row = await getConnectionById(args.db, args.connectionId);
  if (!row || row.provider !== 'moneybird') {
    return { error: 'Connection not found', status: 404 };
  }

  const keyring = keyringFromEnv(args.env);
  const existing = await decryptCredentials(row.credentials ?? undefined, keyring);
  if (!existing.accessToken) {
    return { error: 'Moneybird authorisation is incomplete — connect again', status: 400 };
  }

  const client = new MoneybirdClient({
    accessToken: existing.accessToken,
    refreshToken: existing.refreshToken,
  });
  let administrations: MoneybirdAdministration[];
  try {
    administrations = await client.listAdministrations();
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Could not list Moneybird administrations',
      status: 400,
    };
  }
  const chosen = administrations.find((admin) => admin.id === args.administrationId);
  if (!chosen) {
    return { error: 'That administration is not available on this Moneybird account', status: 400 };
  }

  const credentials = {
    ...existing,
    administrationId: chosen.id,
  };
  const encrypted = await encryptCredentials(credentials, keyring);
  await updateConnectionSettings({
    db: args.db,
    connectionId: row.id,
    credentials: encrypted,
    externalAccountId: chosen.id,
    displayName: row.displayName?.includes('(') ? row.displayName : `Moneybird (${chosen.name})`,
  });
  const fresh = await getConnectionById(args.db, row.id);
  await finishMoneybirdConnection({
    db: args.db,
    env: args.env,
    connection: fresh ?? row,
    clerkOrgId: args.clerkOrgId,
    userId: args.userId,
    credentials,
    waitUntil: args.waitUntil,
  });
  const latest = await getConnectionById(args.db, row.id);
  return {
    connection: sanitizeConnection(latest ?? fresh ?? row, {
      entityId: credentials.entityId ?? null,
    }),
  };
}
