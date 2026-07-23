/**
 * OAuth token freshness for the webhook worker.
 *
 * Webhooks arrive at any time — including after a connection's access token
 * has expired. Before calling a provider's API we must refresh an expired
 * token (and persist it), otherwise every fetch 401s silently and inbound
 * sync quietly stops working until the next full sync happens to refresh it.
 *
 * Mirrors the refresh logic in api-worker's CrmSyncWorkflow, but standalone
 * because this worker has its own provider layer and does not import the
 * api-worker adapters.
 */

import { eq } from 'drizzle-orm';
import type { OAuthTokens } from '@weldsuite/db/schema';
import { tenantSchema, type TenantDatabase } from '../db';
import type { Env } from '../index';

/** Refresh slightly before the real expiry so an in-flight request can't race it. */
const EXPIRY_BUFFER_MS = 60_000;

interface RefreshConfig {
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Resolve the OAuth token endpoint + client credentials for a provider.
 * Credentials are read generically from `${PROVIDER}_CLIENT_ID` /
 * `${PROVIDER}_CLIENT_SECRET` so new providers need only add env vars.
 */
function getRefreshConfig(provider: string, env: Env): RefreshConfig | null {
  const upper = provider.toUpperCase();
  const creds = env as unknown as Record<string, string | undefined>;
  const clientId = creds[`${upper}_CLIENT_ID`];
  const clientSecret = creds[`${upper}_CLIENT_SECRET`];

  switch (provider) {
    case 'attio':
      return { tokenUrl: 'https://app.attio.com/oauth/token', clientId, clientSecret };
    case 'hubspot':
      return { tokenUrl: 'https://api.hubapi.com/oauth/v1/token', clientId, clientSecret };
    default:
      return null;
  }
}

/**
 * Return a valid access token for the connection, refreshing + persisting it
 * first if it is expired (or within the safety buffer of expiring).
 *
 * Best-effort: if no refresh token / credentials / a failed refresh, the
 * existing (possibly stale) token is returned so the caller can still try —
 * a real 401 then surfaces in the caller's logs rather than here.
 */
export async function getValidAccessToken(
  db: TenantDatabase,
  connection: { id: string; provider: string; oauthTokens: OAuthTokens | null },
  env: Env,
): Promise<string> {
  const tokens = connection.oauthTokens;
  if (!tokens?.accessToken) {
    throw new Error(`No access token for connection ${connection.id}`);
  }

  const expiresAtMs = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : null;
  const needsRefresh = expiresAtMs !== null && expiresAtMs - EXPIRY_BUFFER_MS < Date.now();
  if (!needsRefresh) return tokens.accessToken;

  if (!tokens.refreshToken) {
    console.warn(`[Token] ${connection.id} token expired but no refresh token — using stale token`);
    return tokens.accessToken;
  }

  const cfg = getRefreshConfig(connection.provider, env);
  if (!cfg || !cfg.clientId || !cfg.clientSecret) {
    console.warn(`[Token] No refresh config/credentials for provider ${connection.provider} — using stale token`);
    return tokens.accessToken;
  }

  let response: Response;
  try {
    response = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (err) {
    console.error(`[Token] Refresh request failed for ${connection.id}:`, err);
    return tokens.accessToken;
  }

  if (!response.ok) {
    console.error(`[Token] Refresh failed for ${connection.id} (${response.status}): ${await response.text()}`);
    return tokens.accessToken;
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const newTokens: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined,
    tokenType: data.token_type || tokens.tokenType || 'Bearer',
  };

  await db
    .update(tenantSchema.integrationConnections)
    .set({ oauthTokens: newTokens, updatedAt: new Date() })
    .where(eq(tenantSchema.integrationConnections.id, connection.id));

  console.info(`[Token] Refreshed access token for connection ${connection.id}`);
  return newTokens.accessToken;
}
