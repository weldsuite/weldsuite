/**
 * app-api client for WeldSocial mobile.
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
import { createApiOriginResolver, parseModuleList } from '@weldsuite/api-modules';
import { createSocialApi } from '@weldsuite/app-api-client/domains/social';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';

/** app-api base URL. Defaults to the local wrangler dev port. */
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

/** Wire the Clerk token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

const client = createClientApi({
  baseUrl: apiOrigins.originForPath,
  getToken: () => tokenGetter(),
  // Tells app-api which app's permissions apply (per-app permission model,
  // see @weldsuite/permissions APP_CONTEXT_HEADER).
  getExtraHeaders: () => ({ 'X-Weld-App': 'weldsocial' }),
});

export const appApi = {
  social: createSocialApi(client),
  pushTokens: createPushTokensApi(client),
  workspaces: createWorkspacesApi(client),
  me: createMeApi(client),
};

/**
 * Raw client for surfaces without a dedicated domain wrapper (e.g. the
 * dashboard installed-apps list). Same envelopes, throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
