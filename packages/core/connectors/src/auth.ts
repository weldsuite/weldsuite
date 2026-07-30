/**
 * Connector authentication.
 *
 * Two modes, both first-class:
 *
 *   - `oauth2`    — the authorization-code flow. What a multi-tenant SaaS
 *                   connector wants, and what every provider with a public app
 *                   registration offers.
 *   - `api_token` — a long-lived token the tenant pastes in. Not a fallback:
 *                   several bookkeeping providers offer nothing else, and for a
 *                   single-administration customer it is the only option that
 *                   does not require us to register an OAuth app with that
 *                   provider first. Moneybird supports both.
 *
 * A driver declares which modes it supports; the connect UI offers whatever is
 * declared. Everything downstream of `getValidAccessToken` is mode-agnostic —
 * an `api_token` connection simply never needs refreshing.
 *
 * PKCE is deliberately absent. We are a confidential client (the secret lives
 * in a Worker secret, never in a browser), and no provider in the catalog
 * requires PKCE for confidential clients. Adding it would mean persisting the
 * code verifier server-side across the redirect — real infrastructure for no
 * current gain. Add it when a provider actually demands it.
 */

import type { ConnectorAuthMode, OAuthTokens } from '@weldsuite/db/schema';
import { ConnectorApiError, classifyStatus, parseRetryAfter } from './errors';

export type { ConnectorAuthMode };

/** Everything a standard RFC 6749 authorization-code flow needs. */
export interface OAuth2Config {
  authorizeUrl: string;
  tokenUrl: string;
  /** How scopes are joined in the authorize URL. Space per the RFC; some providers want a comma. */
  scopeSeparator?: string;
  /**
   * Extra query params on the authorize URL. This is where provider quirks go —
   * Google's `access_type=offline`, HubSpot's `optional_scope`, and so on —
   * rather than into a per-provider branch in the shared flow.
   */
  extraAuthorizeParams?: Record<string, string>;
  /** Send client credentials as HTTP Basic instead of in the form body. */
  useBasicAuth?: boolean;
}

/** Client credentials for one connector, resolved from Worker secrets. */
export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve `${CONNECTOR_ID}_CLIENT_ID` / `_CLIENT_SECRET` from an env bag.
 *
 * Keeps the existing convention from the legacy engine, so adding a connector
 * is two Worker secrets and no code change here. Hyphens in a connector id
 * become underscores (`google-calendar` → `GOOGLE_CALENDAR_CLIENT_ID`).
 */
export function resolveClientCredentials(
  connectorId: string,
  env: Record<string, unknown>,
): OAuthClientCredentials | null {
  const prefix = connectorId.toUpperCase().replace(/-/g, '_');
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  if (typeof clientId !== 'string' || !clientId) return null;
  if (typeof clientSecret !== 'string' || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Build the provider's authorize URL for a connect attempt. */
export function buildAuthorizeUrl(args: {
  config: OAuth2Config;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  /** Signed, single-use — see `signState`. */
  state: string;
}): string {
  const url = new URL(args.config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('state', args.state);
  if (args.scopes.length > 0) {
    url.searchParams.set('scope', args.scopes.join(args.config.scopeSeparator ?? ' '));
  }
  for (const [key, value] of Object.entries(args.config.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/** POST to the token endpoint and normalise the response into `OAuthTokens`. */
async function postTokenRequest(
  config: OAuth2Config,
  credentials: OAuthClientCredentials,
  params: Record<string, string>,
  connectorId?: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (config.useBasicAuth) {
    headers.Authorization = `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`;
  } else {
    body.set('client_id', credentials.clientId);
    body.set('client_secret', credentials.clientSecret);
  }

  const response = await fetch(config.tokenUrl, { method: 'POST', headers, body });

  if (!response.ok) {
    const text = await response.text().catch(() => undefined);
    throw new ConnectorApiError({
      message: `Token request to ${config.tokenUrl} failed with ${response.status}`,
      status: response.status,
      // A rejected grant is an auth failure regardless of the status the
      // provider chose — most answer 400 for an expired refresh token, and
      // retrying that forever is exactly the wrong response.
      kind: response.status === 400 ? 'auth' : classifyStatus(response.status),
      body: text,
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      connectorId,
    });
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token) {
    throw new ConnectorApiError({
      message: `Token response from ${config.tokenUrl} contained no access_token`,
      status: response.status,
      kind: 'permanent',
      connectorId,
    });
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    tokenType: data.token_type || 'Bearer',
  };
}

/** Exchange an authorization code for tokens. */
export function exchangeAuthorizationCode(args: {
  config: OAuth2Config;
  credentials: OAuthClientCredentials;
  code: string;
  redirectUri: string;
  connectorId?: string;
}): Promise<OAuthTokens> {
  return postTokenRequest(
    args.config,
    args.credentials,
    { grant_type: 'authorization_code', code: args.code, redirect_uri: args.redirectUri },
    args.connectorId,
  );
}

/**
 * Refresh an access token.
 *
 * The returned `refreshToken` may be absent when the provider does not rotate;
 * callers must fall back to the one they already hold rather than storing
 * `undefined` and losing the ability to refresh again.
 */
export function refreshOAuthToken(args: {
  config: OAuth2Config;
  credentials: OAuthClientCredentials;
  refreshToken: string;
  connectorId?: string;
}): Promise<OAuthTokens> {
  return postTokenRequest(
    args.config,
    args.credentials,
    { grant_type: 'refresh_token', refresh_token: args.refreshToken },
    args.connectorId,
  );
}

// ============================================================================
// OAuth `state`
// ============================================================================

/**
 * The callback is a public endpoint, so `state` has to prove three things:
 * which workspace started the flow, which connector, and that we issued it.
 * An HMAC over the payload plus an expiry does all three without server-side
 * storage — losing that storage mid-flow would otherwise strand the user.
 */
export interface ConnectStatePayload {
  workspaceId: string;
  connectorId: string;
  userId: string;
  /** Local `connector_connections.id` the callback should complete. */
  connectionId: string;
  /** Epoch ms. */
  expiresAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

/** Constant-time compare — a length-independent early return leaks the prefix. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function signState(
  payload: Omit<ConnectStatePayload, 'expiresAt'> & { expiresAt?: number },
  secret: string,
): Promise<string> {
  const full: ConnectStatePayload = { ...payload, expiresAt: payload.expiresAt ?? Date.now() + STATE_TTL_MS };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(full)));
  const signature = base64UrlEncode(await hmac(secret, body));
  return `${body}.${signature}`;
}

/** Verify and decode a `state`. Returns null on any tampering or expiry. */
export async function verifyState(state: string, secret: string): Promise<ConnectStatePayload | null> {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  let expected: Uint8Array;
  let provided: Uint8Array;
  try {
    expected = await hmac(secret, body);
    provided = base64UrlDecode(signature);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as ConnectStatePayload;
    if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) return null;
    if (!payload.workspaceId || !payload.connectorId || !payload.connectionId) return null;
    return payload;
  } catch {
    return null;
  }
}
