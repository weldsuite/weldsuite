/**
 * app-api browser client — the module-singleton successor to the legacy
 * api-worker transport.
 *
 * Domain clients under `lib/api/domains/` are plain modules, not hooks, so
 * `useAppApiClient()` is unavailable to them. This mirrors the proven shape of
 * `weldbooks-client.ts`: a singleton whose Clerk token getter is injected by
 * `ApiClientProvider`, with the auth facade's `getAuthToken()` for TanStack route
 * loaders that fire before the provider mounts.
 *
 * Building the client once at module load is safe: `createClientApi` resolves
 * `getToken()` per request inside its own `getAuthHeaders()`, so a lazy getter
 * is picked up on every call rather than captured at construction.
 *
 * Prefer this over `weldbooksApi` for non-accounting calls — that client
 * attaches an `X-Accounting-Entity-Id` header to every request.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { getApiOriginForPath } from '@/lib/api/public-env';
import { getAuthToken } from '@/lib/auth';

let browserTokenGetter: (() => Promise<string | null>) | null = null;

/** Injected by `ApiClientProvider` so calls reuse Clerk's cached session token. */
export function setAppApiTokenGetter(getter: (() => Promise<string | null>) | null) {
  browserTokenGetter = getter;
}


/**
 * The canonical browser token resolution for module-level (non-hook) callers:
 * the getter `ApiClientProvider` injects when it has mounted, otherwise the
 * auth facade (`getAuthToken`, waiting for the provider to load). Exported so
 * other singleton clients share one path
 * rather than re-implementing the fallback.
 */
export async function getBrowserAccessToken(): Promise<string | null> {
  return browserTokenGetter ? browserTokenGetter() : getAuthToken({ waitForLoad: true });
}

/**
 * Singleton app-api client. Paths are prefix-free — `createClientApi` prepends
 * `/api`, exactly as the legacy transport did, which keeps the swap a drop-in.
 */
export const appApi = createClientApi({
  getToken: getBrowserAccessToken,
  baseUrl: getApiOriginForPath,
});
