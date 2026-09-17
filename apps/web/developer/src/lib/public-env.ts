/**
 * Browser API / platform URLs for the developer portal.
 * Hosted builds ignore localhost env leaks and derive from the SPA hostname.
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

function isTestSpaHost(host: string): boolean {
  return (
    host === 'developer-test.weldsuite.org' ||
    host === 'app-test.weldsuite.org' ||
    host === 'developer-web-test.pages.dev' ||
    host.endsWith('.developer-web-test.pages.dev') ||
    host.endsWith('.weldsuite-test.pages.dev')
  );
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

export function getAppApiUrl(): string {
  const envUrl = import.meta.env.VITE_APP_API_URL as string | undefined;
  const host = spaHostname();
  if (!host || isLocalHostname(host)) {
    return trimSlash(envUrl || LOCAL_APP_API);
  }
  if (envUrl && !isLocalUrl(envUrl)) return trimSlash(envUrl);
  return isTestSpaHost(host)
    ? 'https://app-api-test.weldsuite.org'
    : 'https://app-api.weldsuite.org';
}

export function getPlatformUrl(): string {
  const envUrl = import.meta.env.VITE_PLATFORM_URL as string | undefined;
  const host = spaHostname();
  if (!host || isLocalHostname(host)) {
    return trimSlash(envUrl || LOCAL_PLATFORM);
  }
  if (envUrl && !isLocalUrl(envUrl)) return trimSlash(envUrl);
  return isTestSpaHost(host)
    ? 'https://app-test.weldsuite.org'
    : 'https://app.weldsuite.org';
}

export function platformAppUrl(code: string): string {
  return `${getPlatformUrl()}/apps/${encodeURIComponent(code)}`;
}

export function platformManageUrl(): string {
  return `${getPlatformUrl()}/apps/manage`;
}
