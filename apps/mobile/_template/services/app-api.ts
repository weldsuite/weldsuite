/**
 * app-api client for {{APP_NAME}} mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients. A module-level token getter is
 * wired from `app/_layout.tsx` using Clerk credentials (see
 * `setAppApiTokenGetter`) — the client re-reads the token on every request, so
 * no rebuild is needed when it refreshes.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * Call sites wrap calls in try/catch and read `.data` directly.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';

/** app-api base URL. Defaults to the local wrangler dev port (`apps/workers/app-api`). */
export const APP_API_URL = process.env.EXPO_PUBLIC_APP_API_URL || 'http://localhost:8789';

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire the Clerk token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

const client = createClientApi({
  baseUrl: APP_API_URL,
  getToken: () => tokenGetter(),
});

export const appApi = {
  workspaces: createWorkspacesApi(client),
  dashboard: createDashboardApi(client),
  me: createMeApi(client),
  pushTokens: createPushTokensApi(client),
  // Add your app-specific domain clients below, e.g.:
  //   widgets: createWidgetsApi(client),
  // (import from '@weldsuite/app-api-client/domains/<domain>')
};

/**
 * Raw client for surfaces without a dedicated domain wrapper yet. Returns the
 * same `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
