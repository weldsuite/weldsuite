/**
 * Stripe connect flows: Connect OAuth (the "Connect with Stripe" button) and
 * the shared finish for both OAuth and API-key connections.
 *
 * OAuth stores only the connected account id: API calls use the platform key
 * with `Stripe-Account`, and events arrive on the platform's Connect webhook,
 * routed by the `stripeacct:` KV entry written here.
 */

import {
  buildStripeAuthorizeUrl,
  exchangeStripeCode,
  isAllowedConnectorReturnUrl,
  newStripeOAuthState,
  STRIPE_AUTH_STATE_TTL_SECONDS,
  StripeClient,
  stripeRedirectUri,
} from '@weldsuite/connectors';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace, getWorkspaceForOrg, type Database } from '@weldsuite/worker-kit/db';
import type { ConnectorAuthEnv } from './auth';
import {
  encryptCredentials,
  getConnectionById,
  keyringFromEnv,
  sanitizeConnection,
  updateConnectionSettings,
  upsertConnection,
  type ConnectorConnectionRow,
} from './connections';
import { syncConnection } from './sync';
import { putConnectorWebhookMapping, putStripeAccountMapping } from './webhooks';
import { upsertConnectorIndexFromRow } from '../connector-sync-index';

const STRIPE_STATE_KV_PREFIX = 'stripe_oauth_state:';

interface StripeOAuthState {
  clerkOrgId: string;
  userId: string;
  enabledSyncs: string[];
  displayName?: string;
  returnUrl: string;
  entityId?: string | null;
  importStartDate?: string | null;
}

function stripePlatform(env: ConnectorAuthEnv): { clientId: string; secretKey: string } | { error: string } {
  const clientId = env.STRIPE_CONNECT_CLIENT_ID?.trim();
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!clientId || !secretKey) {
    return { error: 'Stripe connect is not configured (missing STRIPE_CONNECT_CLIENT_ID / STRIPE_SECRET_KEY)' };
  }
  return { clientId, secretKey };
}

function publicAppUrl(env: ConnectorAuthEnv): string {
  return env.PUBLIC_APP_URL || 'https://app.weldsuite.org';
}

export async function startStripeOAuth(args: {
  env: ConnectorAuthEnv;
  clerkOrgId: string;
  userId: string;
  enabledSyncs: string[];
  displayName?: string;
  returnUrl: string;
  entityId?: string | null;
  importStartDate?: string | null;
}): Promise<{ authorizeUrl: string } | { error: string; status: 400 }> {
  if (!isAllowedConnectorReturnUrl(args.returnUrl)) {
    return { error: 'Return URL is not a WeldSuite page', status: 400 };
  }
  const platform = stripePlatform(args.env);
  if ('error' in platform) return { error: platform.error, status: 400 };

  const state = newStripeOAuthState();
  const payload: StripeOAuthState = {
    clerkOrgId: args.clerkOrgId,
    userId: args.userId,
    enabledSyncs: args.enabledSyncs,
    displayName: args.displayName,
    returnUrl: args.returnUrl,
    entityId: args.entityId ?? null,
    importStartDate: args.importStartDate ?? null,
  };
  await args.env.WORKSPACE_CACHE.put(`${STRIPE_STATE_KV_PREFIX}${state}`, JSON.stringify(payload), {
    expirationTtl: STRIPE_AUTH_STATE_TTL_SECONDS,
  });

  return {
    authorizeUrl: buildStripeAuthorizeUrl({
      clientId: platform.clientId,
      redirectUri: stripeRedirectUri(publicAppUrl(args.env)),
      state,
    }),
  };
}

/**
 * After a Stripe connection row exists (OAuth or API key): route its events,
 * index it for catch-up, announce it, and run the first import.
 */
export async function finishStripeConnection(args: {
  db: Database;
  env: ConnectorAuthEnv;
  connection: ConnectorConnectionRow;
  clerkOrgId: string;
  userId: string;
  oauthAccountId: string | null;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<void> {
  const row = args.connection;
  try {
    const { id: workspaceId } = await getWorkspaceForOrg(args.env, args.clerkOrgId);
    if (args.oauthAccountId) {
      await putStripeAccountMapping({
        env: args.env,
        accountId: args.oauthAccountId,
        workspaceId,
        connectionId: row.id,
      });
    } else {
      await putConnectorWebhookMapping({ env: args.env, connectionId: row.id, workspaceId, provider: 'stripe' });
    }
    await upsertConnectorIndexFromRow(args.env, {
      connection: row,
      workspaceId,
      clerkOrgId: args.clerkOrgId,
      enabled: true,
    });
  } catch (err) {
    console.warn('[connectors/stripe-auth] KV/D1 index failed', err);
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
        console.error('[connectors/stripe-auth] entity event failed', err);
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
        console.error('[connectors/stripe-auth] initial sync failed:', err);
      }
    })(),
  );
}

async function readState(env: ConnectorAuthEnv, state: string): Promise<StripeOAuthState | null> {
  const key = `${STRIPE_STATE_KV_PREFIX}${state}`;
  const raw = await env.WORKSPACE_CACHE.get(key);
  if (!raw) return null;
  await env.WORKSPACE_CACHE.delete(key);
  try {
    return JSON.parse(raw) as StripeOAuthState;
  } catch {
    return null;
  }
}

export async function completeStripeOAuth(args: {
  env: ConnectorAuthEnv;
  code: string;
  state: string;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<
  | {
      connection: ReturnType<typeof sanitizeConnection>;
      administrations: never[];
      needsPicker: false;
      returnUrl: string;
    }
  | { error: string; status: number }
> {
  const oauthState = await readState(args.env, args.state);
  if (!oauthState) return { error: 'Unknown or expired Stripe authorisation', status: 400 };
  const platform = stripePlatform(args.env);
  if ('error' in platform) return { error: platform.error, status: 400 };

  let accountId: string;
  try {
    const tokens = await exchangeStripeCode({ secretKey: platform.secretKey, code: args.code });
    accountId = tokens.stripeUserId;
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Stripe token exchange failed', status: 400 };
  }

  const tested = await new StripeClient({ accountId, platformSecretKey: platform.secretKey }).test();
  if (!tested.ok) return { error: tested.message, status: 400 };

  const db = await getTenantDbForWorkspace(args.env, oauthState.clerkOrgId);
  const credentials: Record<string, string> = {
    stripeUserId: accountId,
    ...(oauthState.entityId ? { entityId: oauthState.entityId } : {}),
  };
  const label = oauthState.displayName?.trim() || `Stripe (${tested.accountName ?? accountId})`;
  const row = await upsertConnection({
    db,
    provider: 'stripe',
    displayName: label,
    userId: oauthState.userId,
    credentials: await encryptCredentials(credentials, keyringFromEnv(args.env)),
    enabledSyncs: oauthState.enabledSyncs,
    externalAccountId: accountId,
  });
  if (oauthState.importStartDate) {
    await updateConnectionSettings({
      db,
      connectionId: row.id,
      settings: { ...(row.settings ?? {}), importStartDate: oauthState.importStartDate },
    });
  }
  const fresh = (await getConnectionById(db, row.id)) ?? row;
  await finishStripeConnection({
    db,
    env: args.env,
    connection: fresh,
    clerkOrgId: oauthState.clerkOrgId,
    userId: oauthState.userId,
    oauthAccountId: accountId,
    waitUntil: args.waitUntil,
  });

  return {
    connection: sanitizeConnection(fresh, { entityId: credentials.entityId ?? null }),
    administrations: [],
    needsPicker: false,
    returnUrl: oauthState.returnUrl,
  };
}
