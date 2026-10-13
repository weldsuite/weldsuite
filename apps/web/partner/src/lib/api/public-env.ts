/**
 * Browser API / platform URLs for the partner portal.
 *
 * Vite inlines `VITE_*` at build time. A local `.env.local` can leak
 * `http://localhost:…` into a hosted build, so hosted origins ignore localhost
 * values and derive the hosts from the portal's own hostname.
 */

const LOCAL_APP_API = 'http://localhost:8789';
const LOCAL_PLATFORM = 'http://localhost:3000';

function isLocalHostname(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1';
}

function isLocalUrl(url: string | undefined): boolean {
  return !url || /localhost|127\.0\.0\.1/.test(url);
}

function spaHostname(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.hostname;
}

/** partner-test.weldsuite.org, and Vercel preview URLs (never production). */
export function isTestHost(host: string): boolean {
  return host === 'partner-test.weldsuite.org' || host.endsWith('.vercel.app');
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function resolve(envUrl: string | undefined, local: string, test: string, production: string): string {
  const host = spaHostname();
  if (!host || isLocalHostname(host)) return trimSlash(envUrl || local);
  if (envUrl && !isLocalUrl(envUrl)) return trimSlash(envUrl);
  return isTestHost(host) ? test : production;
}

/** app-api origin. The partner routes (`/api/partner/*`) are core, so they never go to a module worker. */
export function getAppApiUrl(): string {
  return resolve(
    import.meta.env.VITE_APP_API_URL,
    LOCAL_APP_API,
    'https://app-api-test.weldsuite.org',
    'https://app-api.weldsuite.org',
  );
}

/** The WeldSuite platform, for "Back to WeldSuite". */
export function getPlatformUrl(): string {
  return resolve(
    import.meta.env.VITE_PLATFORM_URL,
    LOCAL_PLATFORM,
    'https://app-test.weldsuite.org',
    'https://app.weldsuite.org',
  );
}
