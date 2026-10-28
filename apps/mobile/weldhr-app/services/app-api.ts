/**
 * app-api client for WeldHR mobile.
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
 *
 * WeldHR paths (`/api/weldhr/*`) belong to hr-api; with `EXPO_PUBLIC_API_MODULES`
 * set they go straight there, otherwise app-api forwards them.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createApiOriginResolver, parseModuleList } from '@weldsuite/api-modules';
import { createAccountApi } from '@weldsuite/app-api-client/domains/account';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createWeldHrApi } from '@weldsuite/app-api-client/domains/weldhr';
import { createWeldHrPayrollApi } from '@weldsuite/app-api-client/domains/weldhr-payroll';

import { APP_CODE } from '@/lib/access';

/** app-api base URL. Defaults to the local wrangler dev port (`apps/workers/app-api`). */
export const APP_API_URL = process.env.EXPO_PUBLIC_APP_API_URL || 'http://localhost:8789';

/**
 * Modules served by their own worker (`<module>-api` host), from
 * `EXPO_PUBLIC_API_MODULES` (e.g. `pass,host`). Everything else goes to app-api,
 * which forwards moved modules. See docs/plans/app-api-module-split.md.
 */
const apiOrigins = createApiOriginResolver({
  coreOrigin: APP_API_URL,
  enabled: parseModuleList(process.env.EXPO_PUBLIC_API_MODULES),
});

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

/** Wire the Clerk token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

const client = createClientApi({
  baseUrl: apiOrigins.originForPath,
  getToken: () => tokenGetter(),
  // Tells the API which app's permissions apply (per-app permission model,
  // see @weldsuite/permissions APP_CONTEXT_HEADER).
  getExtraHeaders: () => ({ 'X-Weld-App': APP_CODE }),
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
export async function getAppApiRequestInit(
  path: string,
): Promise<{ url: string; headers: Record<string, string> }> {
  const token = await tokenGetter();
  if (!token) throw new Error('Authentication required');
  const fullPath = `/api${path}`;
  return {
    url: `${apiOrigins.originForPath(fullPath)}${fullPath}`,
    headers: { Authorization: `Bearer ${token}`, 'X-Weld-App': APP_CODE },
  };
}

/**
 * Raw client for surfaces without a dedicated domain wrapper yet. Returns the
 * same `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
