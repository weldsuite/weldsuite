/**
 * app-api client for WeldStash mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients. The host of each request is chosen
 * per request by `@weldsuite/mobile-platform/api` (server choice). A module-level
 * token getter is wired from `app/_layout.tsx` (see `setAppApiTokenGetter`); the
 * client re-reads it on every request.
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
import { createProductsApi } from '@weldsuite/app-api-client/domains/products';
import { createInventoryApi } from '@weldsuite/app-api-client/domains/inventory';
import { createWarehousesApi } from '@weldsuite/app-api-client/domains/warehouses';
import { createPickListsApi } from '@weldsuite/app-api-client/domains/pick-lists';
import { createSendcloudApi } from '@weldsuite/app-api-client/domains/sendcloud';
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
  me: createMeApi(client),
  pushTokens: createPushTokensApi(client),
  products: createProductsApi(client),
  inventory: createInventoryApi(client),
  warehouses: createWarehousesApi(client),
  pickLists: createPickListsApi(client),
  sendcloud: createSendcloudApi(client),
};

/**
 * Raw client for surfaces without a dedicated domain wrapper yet. Returns the
 * same `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
