/**
 * Browser API / realtime URLs.
 *
 * Vite inlines `VITE_*` at build time. A local `.env.local` can leak
 * `http://localhost:8789` into a Pages build, so hosted origins ignore
 * localhost values and derive the worker host from the SPA hostname.
 */

const LOCAL_APP_API = 'http://localhost:8789';
const LOCAL_REALTIME = 'ws://localhost:8790/ws';

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
    host === 'app-test.weldsuite.org' ||
    host === 'app-tst.weldsuite.org' ||
    host === 'app-preview.weldsuite.org' ||
    host === 'weldsuite-test.pages.dev' ||
    host.endsWith('.weldsuite-test.pages.dev')
  );
}

function hostedAppApiUrl(host: string): string {
  return isTestSpaHost(host) ? 'https://app-api-test.weldsuite.org' : 'https://app-api.weldsuite.org';
}

function hostedRealtimeUrl(host: string): string {
  return isTestSpaHost(host) ? 'wss://realtime-test.weldsuite.org/ws' : 'wss://realtime.weldsuite.org/ws';
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
  return hostedAppApiUrl(host);
}

export function getRealtimeUrl(): string {
  const envUrl = import.meta.env.VITE_REALTIME_URL as string | undefined;
  const host = spaHostname();
  if (!host || isLocalHostname(host)) {
    return envUrl || LOCAL_REALTIME;
  }
  if (envUrl && !isLocalUrl(envUrl)) return envUrl;
  return hostedRealtimeUrl(host);
}

/** Realtime worker origin without the `/ws` path (RoomClient URLs). */
export function getRealtimeWsOrigin(): string {
  return getRealtimeUrl().replace(/\/ws\/?$/, '');
}
