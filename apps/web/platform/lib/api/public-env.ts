/**
 * Browser API / realtime URLs.
 *
 * Vite inlines `VITE_*` at build time. A local `.env.local` can leak
 * `http://localhost:8789` into a Pages build, so hosted origins ignore
 * localhost values and derive the worker host from the SPA hostname.
 */

import {
  API_MODULES,
  createApiOriginResolver,
  parseModuleList,
  type ApiModuleId,
  type ApiOriginResolver,
} from '@weldsuite/api-modules';

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

// ── Per-module API hosts ────────────────────────────────────────────────────
// app-api is being split into one worker per module
// (docs/plans/app-api-module-split.md). Paths stay the same; only the host
// changes. `VITE_API_MODULES` (e.g. `pass,host`) lists the modules the SPA
// calls directly on `<module>-api(-test).weldsuite.org`. Everything else keeps
// going to app-api, which forwards moved modules, so an empty list behaves
// exactly like the single-worker setup. `VITE_<MODULE>_API_URL` overrides one
// module's origin (ignored on hosted origins when it points at localhost).

let resolverCache: { key: string; resolver: ApiOriginResolver } | null = null;

function moduleOverrides(host: string | undefined): Partial<Record<ApiModuleId, string>> {
  const env = import.meta.env as Record<string, string | undefined>;
  const hosted = !!host && !isLocalHostname(host);
  const out: Partial<Record<ApiModuleId, string>> = {};
  for (const m of API_MODULES) {
    const value = env[`VITE_${m.id.toUpperCase()}_API_URL`];
    if (value && !(hosted && isLocalUrl(value))) out[m.id] = trimSlash(value);
  }
  return out;
}

function apiOriginResolver(): ApiOriginResolver {
  const coreOrigin = getAppApiUrl();
  const modules = (import.meta.env.VITE_API_MODULES as string | undefined) ?? '';
  const host = spaHostname();
  const overrides = moduleOverrides(host);
  const key = `${coreOrigin}|${modules}|${JSON.stringify(overrides)}`;
  if (resolverCache?.key !== key) {
    resolverCache = {
      key,
      resolver: createApiOriginResolver({ coreOrigin, enabled: parseModuleList(modules), overrides }),
    };
  }
  return resolverCache.resolver;
}

/** API origin for a full request path (`/api/tickets/123`). */
export function getApiOriginForPath(path: string): string {
  return apiOriginResolver().originForPath(path);
}

/** Absolute URL for a full request path: `apiUrl('/api/files/1/content')`. */
export function apiUrl(path: string): string {
  return `${getApiOriginForPath(path)}${path}`;
}

/** Every API origin the SPA may call (app-api first). */
export function getApiOrigins(): string[] {
  return apiOriginResolver().allOrigins();
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
