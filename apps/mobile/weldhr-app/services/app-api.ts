/**
 * app-api client for WeldHR mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients. A module-level token getter is
 * wired from `app/_layout.tsx` using the session credentials (see
 * `setAppApiTokenGetter`) — the client re-reads the token on every request, so
 * no rebuild is needed when it refreshes.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * Call sites wrap calls in try/catch and read `.data` directly.
 *
 * WeldHR paths (`/api/weldhr/*`) belong to hr-api; where the server runs that
 * module on its own host they go straight there, otherwise app-api forwards
 * them. The host is read per request (`@weldsuite/mobile-platform/api`), so
 * nothing here may read the runtime at import time.
 */

import { createMobileApiClient } from '@weldsuite/mobile-platform/api';
import { createAccountApi } from '@weldsuite/app-api-client/domains/account';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createWeldHrApi } from '@weldsuite/app-api-client/domains/weldhr';
import { createWeldHrPayrollApi } from '@weldsuite/app-api-client/domains/weldhr-payroll';

import { APP } from '@/lib/server';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

/** Wire the session token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

// `appCode` becomes X-Weld-App: which app's permissions apply (per-app permission
// model, see @weldsuite/permissions APP_CONTEXT_HEADER).
const { client, requestInit } = createMobileApiClient({
  appCode: APP.code,
  getToken: () => tokenGetter(),
});

export const appApi = {
  account: createAccountApi(client),
  workspaces: createWorkspacesApi(client),
  dashboard: createDashboardApi(client),
  me: createMeApi(client),
  pushTokens: createPushTokensApi(client),
  weldhr: createWeldHrApi(client),
  payroll: createWeldHrPayrollApi(client),
};

/**
 * URL and headers for a request the domain clients cannot make on a phone:
 * downloading a PDF straight to a file. Same host choice and auth as `client`.
 */
export { requestInit as getAppApiRequestInit };

/**
 * Raw client for surfaces without a dedicated domain wrapper yet. Returns the
 * same `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
