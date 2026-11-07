import '@tanstack/react-start/server-only';

/**
 * Staff sign-in on the Kubernetes editions (ADR FE-018): OpenID Connect's
 * authorization code flow with PKCE, a state and a nonce, against the
 * install's identity provider (Zitadel on EU and bundled self-host), as a
 * confidential client. oauth4webapi does the protocol checks: the callback's
 * state and issuer, the token response, and the ID token's issuer, audience,
 * expiry and nonce. The ID token comes straight from the token endpoint over
 * TLS, which OIDC Core (3.1.3.7) accepts in place of checking its signature.
 *
 * Signing in only proves who someone is. Whether they get into the console,
 * and with which role, is the install's `admin_users` roster's to say, read on
 * every request (`staff-roster.ts`).
 *
 * Configuration (all required):
 * - `ADMIN_OIDC_ISSUER`: the provider's issuer URL, e.g. https://auth.eu.example
 * - `ADMIN_OIDC_CLIENT_ID`, `ADMIN_OIDC_CLIENT_SECRET`: the console's app there
 * - `ADMIN_PUBLIC_URL`: where staff open the console; the redirect URI is
 *   `{ADMIN_PUBLIC_URL}/auth/callback` (never taken from the Host header)
 * - `ADMIN_SESSION_SECRET`: at least 32 characters, seals the cookies
 */

import * as oauth from 'oauth4webapi';
import { cookieHeader, open, seal } from './sealed-cookie';

export const SESSION_COOKIE = '__Host-admin_session';
export const FLOW_COOKIE = '__Host-admin_oidc';

/** A staff session lasts a working day, then the provider is asked again. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
/** Time to finish signing in at the provider. */
export const FLOW_TTL_SECONDS = 10 * 60;

const SCOPES = 'openid email profile';

export interface OidcConfig {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  publicUrl: URL;
  sessionSecret: string;
}

/** What the session cookie holds: who signed in, not what they may do. */
export interface StaffSession {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** What the flow cookie holds between the redirect out and the callback. */
interface SignInFlow {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

export class OidcConfigError extends Error {}

/** The configuration, or an error naming every variable that is missing or wrong. */
export function oidcConfig(env: Record<string, string | undefined> = process.env): OidcConfig {
  const problems: string[] = [];
  const url = (name: string): URL | null => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} is not set`);
      return null;
    }
    try {
      return new URL(value);
    } catch {
      problems.push(`${name} is not a URL`);
      return null;
    }
  };
  const text = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is not set`);
    return value ?? '';
  };
  const issuer = url('ADMIN_OIDC_ISSUER');
  const publicUrl = url('ADMIN_PUBLIC_URL');
  const clientId = text('ADMIN_OIDC_CLIENT_ID');
  const clientSecret = text('ADMIN_OIDC_CLIENT_SECRET');
  const sessionSecret = text('ADMIN_SESSION_SECRET');
  if (sessionSecret && sessionSecret.length < 32) problems.push('ADMIN_SESSION_SECRET is shorter than 32 characters');
  if (problems.length > 0 || !issuer || !publicUrl) throw new OidcConfigError(problems.join('; '));
  return { issuer, clientId, clientSecret, publicUrl, sessionSecret };
}

/** Plain HTTP only to a provider on this machine (local development); TLS everywhere else. */
function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function requestOptions(config: OidcConfig) {
  return { [oauth.allowInsecureRequests]: isLoopback(config.issuer), signal: AbortSignal.timeout(10_000) };
}

function redirectUri(config: OidcConfig): string {
  return new URL('/auth/callback', config.publicUrl).href;
}

const client = (config: OidcConfig): oauth.Client => ({ client_id: config.clientId });

/** The provider's discovery document, kept for an hour; a failed fetch isn't kept. */
let discovered: { issuer: string; at: number; server: Promise<oauth.AuthorizationServer> } | null = null;

export function authorizationServer(config: OidcConfig, now = Date.now()): Promise<oauth.AuthorizationServer> {
  if (discovered?.issuer === config.issuer.href && now - discovered.at < 60 * 60 * 1000) return discovered.server;
  const server = oauth
    .discoveryRequest(config.issuer, requestOptions(config))
    .then((response) => oauth.processDiscoveryResponse(config.issuer, response));
  discovered = { issuer: config.issuer.href, at: now, server };
  server.catch(() => {
    if (discovered?.server === server) discovered = null;
  });
  return server;
}

/**
 * Where to send someone after they sign in: a path on this console, never
 * another site (`//evil.example`, `/\evil.example` and absolute URLs fall back
 * to the dashboard).
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  try {
    const url = new URL(value, 'http://admin.local');
    if (url.origin !== 'http://admin.local') return '/';
    if (url.pathname.startsWith('/auth/')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

/** The redirect to the provider, and the flow cookie that the callback checks it against. */
export async function startSignIn(config: OidcConfig, returnTo: string | null): Promise<{ location: string; cookie: string }> {
  const as = await authorizationServer(config);
  if (!as.authorization_endpoint) throw new Error('The identity provider has no authorization endpoint');
  const flow: SignInFlow = {
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    verifier: oauth.generateRandomCodeVerifier(),
    returnTo: safeReturnTo(returnTo),
  };
  const location = new URL(as.authorization_endpoint);
  location.searchParams.set('client_id', config.clientId);
  location.searchParams.set('redirect_uri', redirectUri(config));
  location.searchParams.set('response_type', 'code');
  location.searchParams.set('scope', SCOPES);
  location.searchParams.set('state', flow.state);
  location.searchParams.set('nonce', flow.nonce);
  location.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(flow.verifier));
  location.searchParams.set('code_challenge_method', 'S256');
  const sealed = await seal(config.sessionSecret, FLOW_COOKIE, flow, FLOW_TTL_SECONDS);
  return { location: location.href, cookie: cookieHeader(FLOW_COOKIE, sealed, FLOW_TTL_SECONDS) };
}

/**
 * The provider's redirect back: checks it against the flow cookie, swaps the
 * code for tokens, and reads who signed in from the ID token and the userinfo
 * endpoint (whose `sub` must be the ID token's). Throws on anything wrong.
 */
export async function finishSignIn(
  config: OidcConfig,
  callback: URL,
  flowCookie: string | undefined,
): Promise<{ session: StaffSession; returnTo: string }> {
  const flow = await open<SignInFlow>(config.sessionSecret, FLOW_COOKIE, flowCookie);
  if (!flow) throw new Error('No sign-in in progress, or it took too long');

  const as = await authorizationServer(config);
  const params = oauth.validateAuthResponse(as, client(config), callback, flow.state);
  const auth = oauth.ClientSecretBasic(config.clientSecret);
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client(config),
    auth,
    params,
    redirectUri(config),
    flow.verifier,
    requestOptions(config),
  );
  const tokens = await oauth.processAuthorizationCodeResponse(as, client(config), response, {
    expectedNonce: flow.nonce,
    requireIdToken: true,
  });
  const claims = oauth.getValidatedIdTokenClaims(tokens);
  if (!claims?.sub) throw new Error('The identity provider returned no subject');

  const info = await oauth.processUserInfoResponse(
    as,
    client(config),
    claims.sub,
    await oauth.userInfoRequest(as, client(config), tokens.access_token, requestOptions(config)),
  );
  const email = typeof info.email === 'string' ? info.email.trim().toLowerCase() : null;
  const name = info.name ?? ([info.given_name, info.family_name].filter(Boolean).join(' ') || null);
  return {
    session: { sub: claims.sub, email: email || null, emailVerified: info.email_verified === true, name },
    returnTo: flow.returnTo,
  };
}

/** The session cookie for someone who just signed in. */
export async function sessionCookie(config: OidcConfig, session: StaffSession): Promise<string> {
  return cookieHeader(SESSION_COOKIE, await seal(config.sessionSecret, SESSION_COOKIE, session, SESSION_TTL_SECONDS), SESSION_TTL_SECONDS);
}

/** The session in a request's cookie, or null. */
export async function readSession(config: OidcConfig, cookie: string | undefined): Promise<StaffSession | null> {
  return open<StaffSession>(config.sessionSecret, SESSION_COOKIE, cookie);
}

/**
 * Where to send someone who signs out: the provider's end-session endpoint,
 * so its own session ends too, and back to the console; or straight back when
 * the provider has none.
 */
export async function signOutLocation(config: OidcConfig): Promise<string> {
  const back = new URL('/sign-in?signed_out=1', config.publicUrl).href;
  const as = await authorizationServer(config).catch(() => null);
  if (!as?.end_session_endpoint) return back;
  const location = new URL(as.end_session_endpoint);
  location.searchParams.set('client_id', config.clientId);
  location.searchParams.set('post_logout_redirect_uri', back);
  return location.href;
}
