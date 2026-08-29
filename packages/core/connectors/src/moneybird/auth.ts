/**
 * Moneybird OAuth 2.0 helpers.
 *
 * @see https://developer.moneybird.com/authentication/
 */

export const MONEYBIRD_AUTHORIZE_URL = 'https://moneybird.com/oauth/authorize';
export const MONEYBIRD_TOKEN_URL = 'https://moneybird.com/oauth/token';
export const MONEYBIRD_REVOKE_URL = 'https://moneybird.com/oauth/revoke';
export const MONEYBIRD_API_BASE = 'https://moneybird.com/api/v2';
export const MONEYBIRD_SCOPES = ['sales_invoices', 'documents', 'settings', 'bank'] as const;
export const MONEYBIRD_AUTH_STATE_TTL_SECONDS = 15 * 60;
export const MONEYBIRD_CALLBACK_PATH = '/weldconnect/connectors/callback';

export interface MoneybirdOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
}

export interface MoneybirdAdministration {
  id: string;
  name: string;
  language?: string | null;
  currency?: string | null;
}

export function moneybirdRedirectUri(publicAppUrl: string): string {
  return `${publicAppUrl.replace(/\/+$/, '')}${MONEYBIRD_CALLBACK_PATH}`;
}

export function buildMoneybirdAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(MONEYBIRD_AUTHORIZE_URL);
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', args.state);
  url.searchParams.set('scope', (args.scopes ?? MONEYBIRD_SCOPES).join(' '));
  return url.toString();
}

async function tokenRequest(
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<MoneybirdOAuthTokens> {
  const response = await fetchImpl(MONEYBIRD_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Moneybird token request failed (${response.status})`);
  }
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new Error('Moneybird token response did not include an access token');
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    scope: typeof json.scope === 'string' ? json.scope : null,
  };
}

export async function exchangeMoneybirdCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<MoneybirdOAuthTokens> {
  return tokenRequest(
    {
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
      grant_type: 'authorization_code',
    },
    args.fetchImpl ?? globalThis.fetch.bind(globalThis),
  );
}

export async function refreshMoneybirdToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<MoneybirdOAuthTokens> {
  return tokenRequest(
    {
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
      grant_type: 'refresh_token',
    },
    args.fetchImpl ?? globalThis.fetch.bind(globalThis),
  );
}

export async function revokeMoneybirdToken(args: {
  clientId: string;
  clientSecret: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  await fetchImpl(MONEYBIRD_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      token: args.token,
    }).toString(),
  });
}
