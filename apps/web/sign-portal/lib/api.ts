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

import { createHash } from 'node:crypto';

const COOKIE = 'signportal_session';
const APP_API_URL = process.env.APP_API_URL || 'http://localhost:8789';

export function appApiUrl(): string {
  return APP_API_URL.replace(/\/$/, '');
}

/**
 * The session cookie of one signing link. Each link gets its own cookie, so a
 * signer with two requests open in two tabs keeps both sessions apart.
 */
export function sessionCookieName(token: string): string {
  return `${COOKIE}_${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

/** Header the browser sends with every portal call: the link the page was opened with. */
export const SIGN_LINK_HEADER = 'x-sign-link';

export function portalUpstream(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${appApiUrl()}/public/sign-portal${normalizedPath}`;
}
