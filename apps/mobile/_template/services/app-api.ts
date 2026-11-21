/**
 * app-api client for {{APP_NAME}} mobile.
 *
 * Talks to the server the app runs against (`@weldsuite/mobile-platform/api`):
 * on WeldSuite cloud, app-api and the module workers; on EU or a self-hosted
 * server, that server's one origin. The host is read per request, so nothing
 * here may read the runtime at import time.
 *
 * A module-level token getter is wired from `app/_layout.tsx` (see
 * `setAppApiTokenGetter`); the client re-reads it on every request.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * Call sites wrap calls in try/catch and read `.data` directly.
 */

import { createMobileApiClient } from '@weldsuite/mobile-platform/api';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { APP } from '@/lib/server';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

/** Wire the session token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

const { client, requestInit } = createMobileApiClient({
  appCode: APP.code,
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

/** Absolute URL + auth headers for a binary endpoint (path relative to `/api`). */
export { requestInit as getAppApiRequestInit };

/**
 * Raw client for surfaces without a dedicated domain wrapper yet. Returns the
 * same `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
