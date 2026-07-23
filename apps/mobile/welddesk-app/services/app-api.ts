/**
 * app-api client for WeldDesk mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients. A module-level token getter is
 * wired from `services/api.ts` (which `app/_layout.tsx` drives through the
 * legacy-compatible `setTokenRefreshCallback`) — the client re-reads the
 * token on every request, so no rebuild is needed when it refreshes.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * The compat facade in `services/api.ts` adapts these back to the legacy
 * `{ success, data }` shape the screens consume.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createTicketsApi } from '@weldsuite/app-api-client/domains/tickets';
import { createNotificationsApi } from '@weldsuite/app-api-client/domains/notifications';

/** app-api base URL. Defaults to the local wrangler dev port (`apps/workers/app-api`). */
export const APP_API_URL = process.env.EXPO_PUBLIC_APP_API_URL || 'http://localhost:8789';

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire the Clerk token getter. Called from `services/api.ts`. */
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
  tickets: createTicketsApi(client),
  notifications: createNotificationsApi(client),
};

/**
 * Raw client for surfaces without a dedicated domain wrapper yet
 * (conversations, helpdesk-contacts, onboarding, …). Returns the same
 * `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
