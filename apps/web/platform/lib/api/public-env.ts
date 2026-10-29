/**
 * Browser API / realtime URLs.
 *
 * Runtime config first (`/config.json`, see `lib/runtime-config.ts`): a value
 * the deployment states there is used as-is. Otherwise the build-time
 * `VITE_*` value: Vite inlines those at build time, and a local `.env.local`
 * can leak `http://localhost:8789` into a Pages build, so hosted origins
 * ignore localhost values and derive the worker host from the SPA hostname.
 * On the Rust backend (Kubernetes) the API and realtime default to the SPA's
 * own origin.
 */

import {
  API_MODULES,
  createApiOriginResolver,
  parseModuleList,
  type ApiModuleId,
  type ApiOriginResolver,
} from '@weldsuite/api-modules';
import { isRuntimeEnv, isRustBackend, publicEnv } from '@/lib/runtime-config';

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

function hostedAppApiUrl(host: string): string {
  return isTestSpaHost(host) ? 'https://app-api-test.weldsuite.org' : 'https://app-api.weldsuite.org';
}

function hostedRealtimeUrl(host: string): string {
  return isTestSpaHost(host) ? 'wss://realtime-test.weldsuite.org/ws' : 'wss://realtime.weldsuite.org/ws';
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** A value the runtime config states, trusted as-is. */
function runtimeOverride(key: `VITE_${string}`): string | undefined {
  return isRuntimeEnv(key) ? publicEnv(key) : undefined;
}

export function getAppApiUrl(): string {
  const runtimeUrl = runtimeOverride('VITE_APP_API_URL');
  if (runtimeUrl) return trimSlash(runtimeUrl);
  const origin = spaOrigin();
  if (isRustBackend() && origin) return trimSlash(origin);
  const envUrl = publicEnv('VITE_APP_API_URL');
  const host = spaHostname();
  if (!host || isLocalHostname(host)) {
    return trimSlash(envUrl || LOCAL_APP_API);
  }
  if (envUrl && !isLocalUrl(envUrl)) return trimSlash(envUrl);
  return hostedAppApiUrl(host);
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

// ── Per-module API hosts ────────────────────────────────────────────────────
// app-api is being split into one worker per module
// (docs/plans/app-api-module-split.md). Paths stay the same; only the host
// changes. `VITE_API_MODULES` (e.g. `pass,host`, or `all` / `all,-crm`) lists the modules the SPA
// calls directly on `<module>-api(-test).weldsuite.org`. Everything else keeps
// going to app-api, which forwards moved modules, so an empty list behaves
// exactly like the single-worker setup. `VITE_<MODULE>_API_URL` overrides one
// module's origin (ignored on hosted origins when it points at localhost).
// The Rust backend serves every module from one origin, so it gets no list.

let resolverCache: { key: string; resolver: ApiOriginResolver } | null = null;

function moduleOverrides(host: string | undefined): Partial<Record<ApiModuleId, string>> {
  const hosted = !!host && !isLocalHostname(host);
  const out: Partial<Record<ApiModuleId, string>> = {};
  for (const m of API_MODULES) {
    const key = `VITE_${m.id.toUpperCase()}_API_URL` as const;
    const value = publicEnv(key);
    if (value && (isRuntimeEnv(key) || !(hosted && isLocalUrl(value)))) out[m.id] = trimSlash(value);
  }
  return out;
}

function apiOriginResolver(): ApiOriginResolver {
  const coreOrigin = getAppApiUrl();
  const modules = isRustBackend() ? '' : (publicEnv('VITE_API_MODULES') ?? '');
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
  const runtimeUrl = runtimeOverride('VITE_REALTIME_URL');
  if (runtimeUrl) return runtimeUrl;
  const origin = spaOrigin();
  if (isRustBackend() && origin) return `${origin.replace(/^http/, 'ws')}/ws`;
  const envUrl = publicEnv('VITE_REALTIME_URL');
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
