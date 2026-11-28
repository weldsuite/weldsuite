/**
 * Browser API / realtime URLs.
 *
 * One origin serves every API path of every module: the Rust backend's. Its
 * image serves the SPA on that same origin, so the API defaults to the SPA's
 * own origin. A value the runtime config states (`/config.json`, see
 * `lib/runtime-config.ts`) is used as-is. Without a runtime config (a local
 * `pnpm dev`), the build-time `VITE_*` value applies, or the local
 * `weldsuite serve`; a localhost value baked into a build served from a real
 * host is ignored.
 */

import { getRuntimeConfig, isRuntimeEnv, publicEnv } from '@/lib/runtime-config';

/** `weldsuite serve` (rust/README.md): the API on 8080, realtime on its `/ws`. */
const LOCAL_APP_API = 'http://localhost:8080';
const LOCAL_REALTIME = 'ws://localhost:8080/ws';

function isLocalHostname(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1';
}

function isLocalUrl(url: string | undefined): boolean {
  return !url || /localhost|127\.0\.0\.1/.test(url);
}

function spaHostname(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.hostname;
}

function spaOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin;
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

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** A value the runtime config states, trusted as-is. */
function runtimeOverride(key: `VITE_${string}`): string | undefined {
  return isRuntimeEnv(key) ? publicEnv(key) : undefined;
}

/** The API origin: every request path (`/api/…`, `/public/…`, `/v1/…`) goes here. */
export function getAppApiUrl(): string {
  const runtimeUrl = runtimeOverride('VITE_APP_API_URL');
  if (runtimeUrl) return trimSlash(runtimeUrl);
  const origin = spaOrigin();
  if (getRuntimeConfig() && origin) return trimSlash(origin);
  const envUrl = publicEnv('VITE_APP_API_URL');
  const host = spaHostname();
  if (!host || isLocalHostname(host)) {
    return trimSlash(envUrl || LOCAL_APP_API);
  }
  if (envUrl && !isLocalUrl(envUrl)) return trimSlash(envUrl);
  return origin ? trimSlash(origin) : LOCAL_APP_API;
}

/** The partner portal, a separate app (apps/web/partner). */
export function getPartnerPortalUrl(): string {
  const runtimeUrl = runtimeOverride('VITE_PARTNER_PORTAL_URL');
  if (runtimeUrl) return trimSlash(runtimeUrl);
  const envUrl = publicEnv('VITE_PARTNER_PORTAL_URL');
  const host = spaHostname();
  if (!host || isLocalHostname(host)) {
    return trimSlash(envUrl || 'http://localhost:3203');
  }
  if (envUrl && !isLocalUrl(envUrl)) return trimSlash(envUrl);
  return isTestSpaHost(host) ? 'https://partner-test.weldsuite.org' : 'https://partner.weldsuite.org';
}

/** Absolute URL for a full request path: `apiUrl('/api/files/1/content')`. */
export function apiUrl(path: string): string {
  return `${getAppApiUrl()}${path}`;
}

/** The realtime WebSocket URL (`…/ws`); '' when realtime is off. */
export function getRealtimeUrl(): string {
  const runtimeUrl = runtimeOverride('VITE_REALTIME_URL');
  if (runtimeUrl) return runtimeUrl;
  // The backend serves realtime only where /config.json says so (`realtimeUrl`);
  // without it realtime is off, and callers get '' instead of a socket that is refused.
  if (getRuntimeConfig()) return '';
  const envUrl = publicEnv('VITE_REALTIME_URL');
  const host = spaHostname();
  if (!host || isLocalHostname(host)) {
    return envUrl || LOCAL_REALTIME;
  }
  return envUrl && !isLocalUrl(envUrl) ? envUrl : '';
}

/** Realtime origin without the `/ws` path (RoomClient URLs); '' when realtime is off. */
export function getRealtimeWsOrigin(): string {
  return getRealtimeUrl().replace(/\/ws\/?$/, '');
}
