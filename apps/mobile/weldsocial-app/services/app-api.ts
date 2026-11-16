/**
 * app-api client for WeldSocial mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients. A module-level token getter is
 * wired from `app/_layout.tsx` using the session credentials (see
 * `setAppApiTokenGetter`) — the client re-reads the token on every request, so
 * no rebuild is needed when it refreshes. The server (WeldSuite cloud, EU or
 * self-hosted) is the one `ServerRuntimeGate` booted.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * Call sites wrap calls in try/catch and read `.data` directly.
 */

import { createMobileApiClient } from '@weldsuite/mobile-platform/api';
import { createSocialApi } from '@weldsuite/app-api-client/domains/social';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { APP } from '@/lib/server';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

/** Wire the session token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

// Hosts are read per request from the booted server (`@weldsuite/mobile-platform/api`),
// never at import time. Sends `X-Weld-App` (the per-app permission model, see
// @weldsuite/permissions APP_CONTEXT_HEADER).
const { client } = createMobileApiClient({
  appCode: APP.code,
  getToken: () => tokenGetter(),
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
