/**
 * Server-side only helpers: the upstream app-api origin, the session cookie
 * name, and the URL builder used by every `app/api/*` route handler to reach
 * `/public/hr-portal/*`. Never import this from a client component — it reads
 * `APP_API_URL`, which is not exposed to the browser.
 */

const COOKIE = 'hrportal_session';
const APP_API_URL = process.env.APP_API_URL || 'http://localhost:8789';

export function appApiUrl(): string {
  return APP_API_URL.replace(/\/$/, '');
}

export function sessionCookieName(): string {
  return COOKIE;
}

export function portalUpstream(slug: string, path: string): string {
  const base = `${appApiUrl()}/public/hr-portal${path.startsWith('/') ? path : `/${path}`}`;
  const url = new URL(base);
  if (slug) url.searchParams.set('slug', slug);
  return url.toString();
}
