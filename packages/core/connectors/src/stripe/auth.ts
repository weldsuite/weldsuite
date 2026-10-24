/**
 * Stripe Connect OAuth (Standard accounts) helpers.
 *
 * WeldSuite's Stripe account is a Connect *platform* (it also runs WeldApps
 * payouts), and Stripe only lets platforms request `read_write`; `read_only`
 * was reserved for the now-retired Connect extensions (Stripe Apps replace
 * them). We only ever read. API calls use the platform key plus the
 * `Stripe-Account` header; the token response's `access_token` is deprecated.
 * Accounts controlled by another platform cannot be connected this way: Stripe
 * offers to create a new account instead, so those merchants use an API key.
 *
 * @see https://docs.stripe.com/connect/oauth-reference
 * @see https://docs.stripe.com/connect/oauth-changes-for-standard-platforms
 */

export const STRIPE_CONNECT_AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize';
export const STRIPE_CONNECT_TOKEN_URL = 'https://connect.stripe.com/oauth/token';
export const STRIPE_CONNECT_DEAUTHORIZE_URL = 'https://connect.stripe.com/oauth/deauthorize';
export const STRIPE_CONNECT_SCOPE = 'read_write';
/** OAuth `state` prefix, so the shared callback page knows to finish a Stripe connect. */
export const STRIPE_OAUTH_STATE_PREFIX = 'stripe_';
export const STRIPE_AUTH_STATE_TTL_SECONDS = 15 * 60;
/** Same platform page Moneybird returns to; the state prefix tells them apart. */
export const STRIPE_CALLBACK_PATH = '/weldconnect/connectors/callback';

export interface StripeOAuthTokens {
  /** The connected account (`acct_…`). */
  stripeUserId: string;
  /** Deprecated by Stripe; kept only as a fallback for workers without the platform key. */
  accessToken: string | null;
  refreshToken: string | null;
  livemode: boolean;
  scope: string | null;
}

export function stripeRedirectUri(publicAppUrl: string): string {
  return `${publicAppUrl.replace(/(?<!\/)\/+$/, '')}${STRIPE_CALLBACK_PATH}`;
}

export function newStripeOAuthState(): string {
  return `${STRIPE_OAUTH_STATE_PREFIX}${crypto.randomUUID()}`;
}

export function isStripeOAuthState(state: string | null | undefined): boolean {
  return Boolean(state?.startsWith(STRIPE_OAUTH_STATE_PREFIX));
}

export function buildStripeAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL(STRIPE_CONNECT_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('scope', args.scope ?? STRIPE_CONNECT_SCOPE);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('state', args.state);
  // Existing merchants land on the login form instead of the sign-up form.
  url.searchParams.set('stripe_landing', 'login');
  return url.toString();
}

/** HTTP Basic with the secret key as user and no password, as Stripe's OAuth endpoints expect. */
function basicAuth(secretKey: string): string {
  const userAndPassword = secretKey + ':';
  return `Basic ${btoa(userAndPassword)}`;
}

function oauthErrorMessage(json: Record<string, unknown>, status: number, fallback: string): string {
  const description = typeof json.error_description === 'string' ? json.error_description : null;
  const code = typeof json.error === 'string' ? json.error : null;
  return description ?? code ?? `${fallback} (${status})`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function exchangeStripeCode(args: {
  secretKey: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<StripeOAuthTokens> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(STRIPE_CONNECT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(args.secretKey),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: args.code }).toString(),
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(oauthErrorMessage(json, response.status, 'Stripe token request failed'));
  }
  const stripeUserId = typeof json.stripe_user_id === 'string' ? json.stripe_user_id : '';
  if (!stripeUserId) throw new Error('Stripe did not return the connected account id');
  return {
    stripeUserId,
    accessToken: typeof json.access_token === 'string' && json.access_token ? json.access_token : null,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    livemode: json.livemode === true,
    scope: typeof json.scope === 'string' ? json.scope : null,
  };
}

/** Revoke the platform's access to a connected account. A 401 "already disconnected" counts as done. */
export async function deauthorizeStripeAccount(args: {
  secretKey: string;
  clientId: string;
  stripeUserId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(STRIPE_CONNECT_DEAUTHORIZE_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(args.secretKey),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ client_id: args.clientId, stripe_user_id: args.stripeUserId }).toString(),
  });
  if (response.ok || response.status === 401) return;
  const json = await readJson(response);
  throw new Error(oauthErrorMessage(json, response.status, 'Stripe deauthorize failed'));
}
