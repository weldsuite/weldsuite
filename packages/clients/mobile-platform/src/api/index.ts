/**
 * `@weldsuite/mobile-platform/api`: the app-api client every mobile app
 * builds its domain clients on, pointed at the booted server.
 *
 * - Global: per-path hosts (`EXPO_PUBLIC_API_MODULES` modules go to their own
 *   `<module>-api` worker, the rest to app-api), as before.
 * - EU / self-hosted: every path to the server's origin (the Rust backend
 *   serves all modules).
 *
 * Hosts are read on each request, never at import time: modules load before
 * the runtime boots.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createApiOriginResolver, type ApiOriginResolver } from '@weldsuite/api-modules';
import { getMobileRuntime } from '../runtime/state';

export interface MobileApiClientOptions {
  /** Sent as `X-Weld-App`: which app's permissions apply (per-app permission model). */
  appCode: string;
  /** The bearer token; null sends no Authorization header. */
  getToken: () => Promise<string | null>;
  /** Further headers per request (WeldBooks' `X-Accounting-Entity-Id`). */
  getExtraHeaders?: () => Record<string, string>;
}

let resolver: ApiOriginResolver | null = null;

function origins(): ApiOriginResolver {
  if (resolver) return resolver;
  const runtime = getMobileRuntime();
  resolver = createApiOriginResolver({ coreOrigin: runtime.apiOrigin, enabled: new Set(runtime.apiModules) });
  return resolver;
}

/** The origin that serves `path` (a full path, `/api/...`). */
export function apiOriginForPath(path: string): string {
  return origins().originForPath(path);
}

/** The core API origin (app-api on Global, the server on Kubernetes). */
export function apiOrigin(): string {
  return getMobileRuntime().apiOrigin;
}

/** personal-api's base URL (consumer WeldMail and WeldCalendar). */
export function personalApiOrigin(): string {
  return getMobileRuntime().personalApiOrigin;
}

/** The realtime base URL (append `/ws`). */
export function realtimeUrl(): string {
  return getMobileRuntime().realtimeUrl;
}

/** The web app, for links that open it. */
export function platformUrl(): string {
  return getMobileRuntime().platformUrl;
}

export function createMobileApiClient(options: MobileApiClientOptions) {
  const headers = (): Record<string, string> => ({
    ...options.getExtraHeaders?.(),
    'X-Weld-App': options.appCode,
  });
  const client = createClientApi({
    baseUrl: (fullPath: string) => apiOriginForPath(fullPath),
    getToken: () => options.getToken(),
    getExtraHeaders: headers,
  });

  /**
   * Absolute URL + auth headers for a binary (non-JSON) endpoint, such as an
   * attachment download. `path` is relative to `/api`, like `client.get`.
   * Throws `Authentication required` without a session, like the client.
   */
  async function requestInit(path: string): Promise<{ url: string; headers: Record<string, string> }> {
    const token = await options.getToken();
    if (!token) throw new Error('Authentication required');
    const fullPath = `/api${path}`;
    return {
      url: `${apiOriginForPath(fullPath)}${fullPath}`,
      headers: { Authorization: `Bearer ${token}`, ...headers() },
    };
  }

  return { client, requestInit };
}

/** For tests: forget the cached host resolver. */
export function resetApiOrigins(): void {
  resolver = null;
}
