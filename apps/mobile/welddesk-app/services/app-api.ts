/**
 * Strip tickets domain — desk conversations are the v1 surface.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createApiOriginResolver, parseModuleList } from '@weldsuite/api-modules';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createNotificationsApi } from '@weldsuite/app-api-client/domains/notifications';

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

let tokenGetter: () => Promise<string | null> = async () => null;

export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

const client = createClientApi({
  baseUrl: apiOrigins.originForPath,
  getToken: () => tokenGetter(),
  // Tells app-api which app's permissions apply (per-app permission model,
  // see @weldsuite/permissions APP_CONTEXT_HEADER).
  getExtraHeaders: () => ({ 'X-Weld-App': 'welddesk' }),
});

export const appApi = {
  workspaces: createWorkspacesApi(client),
  dashboard: createDashboardApi(client),
  me: createMeApi(client),
  pushTokens: createPushTokensApi(client),
  notifications: createNotificationsApi(client),
};

export { client as appApiClient };

export default appApi;
