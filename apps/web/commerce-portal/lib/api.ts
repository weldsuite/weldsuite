const COOKIE = 'cportal_session';
const APP_API_URL = process.env.APP_API_URL || 'http://localhost:8789';

export function appApiUrl(): string {
  return APP_API_URL.replace(/\/$/, '');
}

export function sessionCookieName(): string {
  return COOKIE;
}

export function portalUpstream(slug: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = `${appApiUrl()}/public/commerce-portal${normalizedPath}`;
  const url = new URL(base);
  url.searchParams.set('slug', slug);
  return url.toString();
}
