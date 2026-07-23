/**
 * app-api browser client — the module-singleton successor to the legacy
 * api-worker transport.
 *
 * Domain clients under `lib/api/domains/` are plain modules, not hooks, so
 * `useAppApiClient()` is unavailable to them. This mirrors the proven shape of
 * `weldbooks-client.ts`: a singleton whose Clerk token getter is injected by
 * `ApiClientProvider`, with a `window.Clerk` fallback for TanStack route
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

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';

let browserTokenGetter: (() => Promise<string | null>) | null = null;

/** Injected by `ApiClientProvider` so calls reuse Clerk's cached session token. */
export function setAppApiTokenGetter(getter: (() => Promise<string | null>) | null) {
  browserTokenGetter = getter;
}

/** Pre-provider fallback: pull the token straight off `window.Clerk`. */
async function getClerkBrowserToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const Clerk = (window as { Clerk?: { loaded?: boolean; session?: { getToken: () => Promise<string | null> } } }).Clerk;
    if (Clerk?.loaded) {
      try {
        return (await Clerk.session?.getToken()) ?? null;
      } catch {
        return null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * Singleton app-api client. Paths are prefix-free — `createClientApi` prepends
 * `/api`, exactly as the legacy transport did, which keeps the swap a drop-in.
 */
export const appApi = createClientApi({
  getToken: async () => (browserTokenGetter ? browserTokenGetter() : getClerkBrowserToken()),
  baseUrl: APP_API_URL,
});
