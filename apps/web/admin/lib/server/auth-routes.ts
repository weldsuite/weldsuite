import '@tanstack/react-start/server-only';

/**
 * The three sign-in endpoints of the Kubernetes build (`src/routes/auth/*`),
 * as plain fetch handlers. Global signs in with Clerk and answers 404 here.
 *
 *   GET  /auth/sign-in?redirect_url=/path   off to the identity provider
 *   GET  /auth/callback                     back from it, with a session
 *   POST /auth/sign-out                     session gone, provider's too
 */

import { isSameSiteRequest } from '../same-site';
import { cookieHeader, readCookie } from './sealed-cookie';
import {
  FLOW_COOKIE,
  OidcConfigError,
  SESSION_COOKIE,
  finishSignIn,
  oidcConfig,
  sessionCookie,
  signOutLocation,
  startSignIn,
  type OidcConfig,
} from './oidc';
import { staffIdentity } from './staff-roster';

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}

/** Sign-in isn't configured: say what is missing (names only, never values). */
function unconfigured(error: unknown): Response {
  const detail = error instanceof OidcConfigError ? error.message : 'unknown error';
  console.error('[admin/auth] staff sign-in is not configured:', detail);
  return new Response(`Staff sign-in is not configured: ${detail}.`, {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function config(): OidcConfig | Response {
  try {
    return oidcConfig();
  } catch (error) {
    return unconfigured(error);
  }
}

export async function handleSignIn(request: Request): Promise<Response> {
  const settings = config();
  if (settings instanceof Response) return settings;
  try {
    const returnTo = new URL(request.url).searchParams.get('redirect_url');
    const { location, cookie } = await startSignIn(settings, returnTo);
    return redirect(location, [cookie]);
  } catch (error) {
    console.error('[admin/auth] could not start sign-in:', error);
    return redirect('/sign-in?error=sign_in_failed');
  }
}

export async function handleCallback(request: Request): Promise<Response> {
  const settings = config();
  if (settings instanceof Response) return settings;
  const clearFlow = cookieHeader(FLOW_COOKIE, '', 0);
  try {
    const flow = readCookie(request.headers.get('cookie'), FLOW_COOKIE);
    const { session, returnTo } = await finishSignIn(settings, new URL(request.url), flow);
    // Binds a first sign-in to its roster row and notes the time. The session
    // is made even for someone not on the roster: they get the "no access"
    // page with a sign-out button, instead of a loop through the provider.
    const identity = await staffIdentity(session, { signingIn: true });
    if (!identity) console.warn('[admin/auth] signed in but not on the staff roster:', session.sub);
    return redirect(returnTo, [await sessionCookie(settings, session), clearFlow]);
  } catch (error) {
    console.error('[admin/auth] sign-in failed:', error);
    return redirect('/sign-in?error=sign_in_failed', [clearFlow]);
  }
}

export async function handleSignOut(request: Request): Promise<Response> {
  if (!isSameSiteRequest(request)) return new Response('Cross-site request refused', { status: 403 });
  const clear = cookieHeader(SESSION_COOKIE, '', 0);
  const settings = config();
  if (settings instanceof Response) return redirect('/sign-in?signed_out=1', [clear], 303);
  return redirect(await signOutLocation(settings), [clear], 303);
}

/** The session cookie of a request, for `identity.node.ts`. */
export function sessionCookieOf(request: Request): string | undefined {
  return readCookie(request.headers.get('cookie'), SESSION_COOKIE);
}
