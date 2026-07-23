/**
 * app-api client for the WeldSuite flagship mobile app (W1b phase-out).
 *
 * Talks to the unified app-api (`/api/...`) via the shared framework-agnostic
 * client from `@weldsuite/api-client/client`. A module-level token getter is
 * wired from `services/api.ts` (which `app/_layout.tsx` drives through the
 * legacy-compatible `setTokenRefreshCallback` / `setAccessToken`) — the client
 * re-reads the token on every request, so no rebuild is needed when it
 * refreshes.
 *
 * The client returns the app-api envelope: `{ data }` for single items,
 * `{ data, pagination: { totalCount, hasMore, cursor } }` for lists, and it
 * THROWS an `ApiError` (`.isApiError`, `.status`) on non-2xx (204 → `{}`).
 * The compat facade in `services/api.ts` + `services/modules/*` adapts these
 * back to the legacy `{ success, data }` shape the screens consume.
 */

import { createClientApi } from '@weldsuite/api-client/client';

/** app-api base URL. Defaults to the local wrangler dev port (`apps/workers/app-api`). */
export const APP_API_URL = process.env.EXPO_PUBLIC_APP_API_URL || 'http://localhost:8789';

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire the Clerk token getter. Called from `services/api.ts`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

/**
 * Raw app-api client (get/getRaw/post/put/patch/delete/postForm). Paths are
 * relative to `/api` (e.g. `client.get('/tickets')` → `GET {base}/api/tickets`).
 */
export const appApiClient = createClientApi({
  baseUrl: APP_API_URL,
  getToken: () => tokenGetter(),
});

export default appApiClient;
