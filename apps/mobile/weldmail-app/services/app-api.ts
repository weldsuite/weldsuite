/**
 * app-api client for WeldMail mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients. A module-level token getter is
 * wired from `app/_layout.tsx` using Clerk credentials (see
 * `setAppApiTokenGetter`) — the client re-reads the token on every request, so
 * no rebuild is needed when it refreshes.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * Call sites wrap calls in try/catch and read `.data` directly — no
 * `{ success }` branching like the legacy client.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createMailAccountsApi } from '@weldsuite/app-api-client/domains/mail-accounts';
import { createMailMessagesApi } from '@weldsuite/app-api-client/domains/mail-messages';
import { createMailThreadsApi } from '@weldsuite/app-api-client/domains/mail-threads';
import { createMailLabelsApi } from '@weldsuite/app-api-client/domains/mail-labels';
import { createMailDraftsApi } from '@weldsuite/app-api-client/domains/mail-drafts';
import { createMailWeldMailApi } from '@weldsuite/app-api-client/domains/mail-weldmail';
import { createMailSnoozeApi } from '@weldsuite/app-api-client/domains/mail-snooze';
import { createMailScheduledApi } from '@weldsuite/app-api-client/domains/mail-scheduled';
import { createMailDomainsApi } from '@weldsuite/app-api-client/domains/mail-domains';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';

/** app-api base URL. Defaults to the local wrangler dev port. */
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
  mailAccounts: createMailAccountsApi(client),
  mailMessages: createMailMessagesApi(client),
  mailThreads: createMailThreadsApi(client),
  mailLabels: createMailLabelsApi(client),
  mailDrafts: createMailDraftsApi(client),
  mailWeldmail: createMailWeldMailApi(client),
  mailSnooze: createMailSnoozeApi(client),
  mailScheduled: createMailScheduledApi(client),
  mailDomains: createMailDomainsApi(client),
  pushTokens: createPushTokensApi(client),
  workspaces: createWorkspacesApi(client),
  me: createMeApi(client),
};

/**
 * Raw client for surfaces without a dedicated domain wrapper yet (e.g. people
 * / contacts in Phase 6). Returns the same `{ data }` / `{ data, pagination }`
 * envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
