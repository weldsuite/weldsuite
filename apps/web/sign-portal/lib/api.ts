/**
 * Server-side only helpers: the upstream app-api origin, the signer session
 * cookie name, and the URL builder every `app/api/*` route handler uses to
 * reach `/public/sign-portal/*` (sign-api, forwarded by app-api). Never import
 * this from a client component: it reads `APP_API_URL`, which is not exposed
 * to the browser.
 *
 * Unlike hr-portal there is no workspace slug: sign-api finds the workspace
 * from the link token (master `sign_link_registry`) or the signer session.
 */

const COOKIE = 'signportal_session';
const APP_API_URL = process.env.APP_API_URL || 'http://localhost:8789';

export function appApiUrl(): string {
  return APP_API_URL.replace(/\/$/, '');
}

export function sessionCookieName(): string {
  return COOKIE;
}

export function portalUpstream(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${appApiUrl()}/public/sign-portal${normalizedPath}`;
}
