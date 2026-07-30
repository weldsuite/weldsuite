/**
 * Access-token freshness.
 *
 * The legacy engine's version of this refreshed inline with no concurrency
 * guard, which was survivable while one cron invocation touched each connection
 * once. It is not survivable now: the scheduler fans out one queue message per
 * `(connection, entity)`, so several Workers can hold the same connection at the
 * same moment. Two simultaneous refreshes against a provider that **rotates**
 * refresh tokens — HubSpot, Salesforce, Moneybird — means the second call
 * presents a token the first one just invalidated, and the connection drops to
 * `auth_error` with no bad input anywhere. The tenant is then told to
 * reauthorise for no reason.
 *
 * So refreshing is serialised on a database lease: claim
 * `refresh_lock_until` with a conditional UPDATE, refresh, release. A caller that
 * loses the race waits and re-reads rather than refreshing in parallel. The
 * lease has a TTL so a Worker that dies mid-refresh does not wedge the
 * connection permanently.
 *
 * Persistence sits behind `ConnectionTokenStore` rather than a database handle,
 * for two reasons: this package stays free of Drizzle and the tenant-database
 * type, and the contention path becomes testable without a Postgres.
 */

import type { OAuthTokens } from '@weldsuite/db/schema';
import type { ConnectorAuthMode } from './auth';
import { refreshOAuthToken, type OAuthClientCredentials } from './auth';
import { ConnectorApiError } from './errors';
import type { ConnectorDriver } from './types';

/** Refresh slightly before the real expiry so an in-flight request cannot race it. */
const EXPIRY_BUFFER_MS = 60_000;

/** How long a refresh lease is held before it is considered abandoned. */
export const REFRESH_LOCK_TTL_MS = 30_000;

/** Attempts to pick up the winner's token after losing the race. */
const LOSER_MAX_POLLS = 6;
const LOSER_POLL_INTERVAL_MS = 500;

export interface ConnectionTokenState {
  id: string;
  connectorId: string;
  authMode: ConnectorAuthMode;
  oauthTokens: OAuthTokens | null;
}

export interface ConnectionTokenStore {
  /**
   * Try to take the refresh lease.
   *
   * Must be a single atomic statement — `UPDATE … SET refresh_lock_until = $ttl
   * WHERE id = $id AND (refresh_lock_until IS NULL OR refresh_lock_until < now())
   * RETURNING id` — and return true only when a row came back. A read-then-write
   * implementation reintroduces exactly the race this exists to close.
   */
  claimRefreshLock(connectionId: string, leaseUntil: Date): Promise<boolean>;

  /** Release the lease. Called on both success and failure. */
  releaseRefreshLock(connectionId: string): Promise<void>;

  /** Persist rotated tokens and release the lease in one write. */
  saveTokens(connectionId: string, tokens: OAuthTokens): Promise<void>;

  /** Re-read the current tokens — how the loser of the race picks up the result. */
  reloadTokens(connectionId: string): Promise<OAuthTokens | null>;

  /** Flag the connection so the UI asks the tenant to reauthorise. */
  markAuthError(connectionId: string, message: string): Promise<void>;
}

export interface GetValidAccessTokenArgs {
  connection: ConnectionTokenState;
  driver: ConnectorDriver;
  store: ConnectionTokenStore;
  /** Required for `oauth2` connections; ignored for `api_token`. */
  credentials?: OAuthClientCredentials | null;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpiring(tokens: OAuthTokens, now: number): boolean {
  if (!tokens.expiresAt) return false;
  const expiresAtMs = new Date(tokens.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs - EXPIRY_BUFFER_MS < now;
}

/**
 * Return a usable access token, refreshing first when required.
 *
 * Throws `ConnectorApiError` with `kind: 'auth'` when the connection genuinely
 * cannot produce a token. That is deliberate: the previous implementation
 * returned the stale token on every failure so the caller "could still try",
 * which converted one clear auth error into an opaque 401 from deep inside a
 * driver, on every entity, every sweep.
 */
export async function getValidAccessToken(args: GetValidAccessTokenArgs): Promise<string> {
  const { connection, driver, store } = args;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? defaultSleep;
  const tokens = connection.oauthTokens;

  if (!tokens?.accessToken) {
    throw new ConnectorApiError({
      message: `Connection ${connection.id} has no access token`,
      status: 401,
      kind: 'auth',
      connectorId: connection.connectorId,
    });
  }

  // A pasted API token has no expiry and no refresh path.
  if (connection.authMode === 'api_token') return tokens.accessToken;

  if (!isExpiring(tokens, now())) return tokens.accessToken;

  if (!tokens.refreshToken) {
    throw new ConnectorApiError({
      message: `Connection ${connection.id} token expired and no refresh token is stored`,
      status: 401,
      kind: 'auth',
      connectorId: connection.connectorId,
    });
  }

  const credentials = args.credentials;
  if (!credentials) {
    // Not an auth failure on the tenant's side — our own Worker secrets are
    // missing, so do not tell them to reauthorise.
    throw new ConnectorApiError({
      message: `No OAuth client credentials configured for connector ${connection.connectorId}`,
      status: 500,
      kind: 'permanent',
      connectorId: connection.connectorId,
    });
  }

  const won = await store.claimRefreshLock(connection.id, new Date(now() + REFRESH_LOCK_TTL_MS));

  if (!won) {
    // Someone else is refreshing. Wait for their result rather than racing them.
    for (let attempt = 0; attempt < LOSER_MAX_POLLS; attempt++) {
      await sleep(LOSER_POLL_INTERVAL_MS);
      const latest = await store.reloadTokens(connection.id);
      if (latest?.accessToken && !isExpiring(latest, now())) return latest.accessToken;
    }
    throw new ConnectorApiError({
      message: `Timed out waiting for a concurrent token refresh on connection ${connection.id}`,
      status: 503,
      kind: 'transient',
      connectorId: connection.connectorId,
    });
  }

  try {
    const refreshed = driver.refreshAccessToken
      ? await driver.refreshAccessToken(credentials, tokens.refreshToken)
      : await refreshOAuthToken({
          config: requireOAuthConfig(driver),
          credentials,
          refreshToken: tokens.refreshToken,
          connectorId: driver.connectorId,
        });

    // Providers that do not rotate omit the refresh token. Persisting undefined
    // would strand the connection at the next expiry.
    const merged: OAuthTokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || tokens.refreshToken,
      expiresAt: refreshed.expiresAt,
      tokenType: refreshed.tokenType || tokens.tokenType || 'Bearer',
    };

    await store.saveTokens(connection.id, merged);
    return merged.accessToken;
  } catch (err) {
    await store.releaseRefreshLock(connection.id);
    if (err instanceof ConnectorApiError && err.kind === 'auth') {
      await store.markAuthError(connection.id, 'Token refresh was rejected — reauthorisation required');
    }
    throw err;
  }
}

function requireOAuthConfig(driver: ConnectorDriver) {
  if (!driver.oauth2) {
    throw new ConnectorApiError({
      message: `Driver ${driver.connectorId} declares oauth2 auth but no oauth2 config`,
      status: 500,
      kind: 'permanent',
      connectorId: driver.connectorId,
    });
  }
  return driver.oauth2;
}
