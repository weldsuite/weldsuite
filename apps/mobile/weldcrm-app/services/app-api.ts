/**
 * app-api client for WeldCRM mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/api-client` client + `@weldsuite/app-api-client` domain
 * clients. Which host each request goes to is decided per request by
 * `@weldsuite/mobile-platform/api`. A module-level token getter is wired from
 * `app/_layout.tsx` from the session credentials (see `setAppApiTokenGetter`) — the client re-reads the
 * token on every request, so no rebuild is needed when it refreshes.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * The CRM data layer in `services/api.ts` adapts these envelopes back to the
 * legacy `{ success, data }` shape the screens consume.
 */

import { createMobileApiClient } from '@weldsuite/mobile-platform/api';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { APP } from '@/lib/server';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

/** Wire the session token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

const { client } = createMobileApiClient({
  appCode: APP.code,
  getToken: () => tokenGetter(),
});

export const appApi = {
  workspaces: createWorkspacesApi(client),
  dashboard: createDashboardApi(client),
};

/**
 * Raw client for surfaces without a dedicated domain wrapper yet (the CRM
 * endpoints in `services/api.ts`). Returns the same `{ data }` /
 * `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
