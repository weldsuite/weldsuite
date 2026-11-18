/**
 * app-api client for WeldMail mobile.
 *
 * Talks to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients. A module-level token getter is
 * wired from `app/_layout.tsx` using the session credentials (see
 * `setAppApiTokenGetter`) — the client re-reads the token on every request, so
 * no rebuild is needed when it refreshes. Hosts come from the booted server
 * runtime (`@weldsuite/mobile-platform/api`) and are read per request, so nothing
 * here may read the runtime at import time.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * Call sites wrap calls in try/catch and read `.data` directly — no
 * `{ success }` branching like the legacy client.
 */

import { createMobileApiClient } from '@weldsuite/mobile-platform/api';
import { createMailAccountsApi } from '@weldsuite/app-api-client/domains/mail-accounts';
import { createMailMessagesApi } from '@weldsuite/app-api-client/domains/mail-messages';
import { createMailThreadsApi } from '@weldsuite/app-api-client/domains/mail-threads';
import { createMailLabelsApi } from '@weldsuite/app-api-client/domains/mail-labels';
import { createMailDraftsApi } from '@weldsuite/app-api-client/domains/mail-drafts';
import { createMailWeldMailApi } from '@weldsuite/app-api-client/domains/mail-weldmail';
import { createMailSnoozeApi } from '@weldsuite/app-api-client/domains/mail-snooze';
import { createMailSubscriptionsApi } from '@weldsuite/app-api-client/domains/mail-subscriptions';
import { createMailScheduledApi } from '@weldsuite/app-api-client/domains/mail-scheduled';
import { createMailDomainsApi } from '@weldsuite/app-api-client/domains/mail-domains';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createMailboxesApi } from '@weldsuite/app-api-client/domains/mailboxes';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { APP } from '@/lib/server';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

/** Wire the session token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

// `X-Weld-App` tells app-api which app's permissions apply (per-app permission model,
// see @weldsuite/permissions APP_CONTEXT_HEADER).
const { client, requestInit } = createMobileApiClient({
  appCode: APP.code,
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
  mailSubscriptions: createMailSubscriptionsApi(client),
  mailScheduled: createMailScheduledApi(client),
  mailDomains: createMailDomainsApi(client),
  pushTokens: createPushTokensApi(client),
  workspaces: createWorkspacesApi(client),
  mailboxes: createMailboxesApi(client),
  me: createMeApi(client),
};

/**
 * Absolute URL + auth headers for a binary (non-JSON) endpoint, e.g. an
 * attachment download. Same origin routing and credentials as the client
 * above (`path` is relative to `/api`, like `appApiClient.get`). Throws
 * `Authentication required` without a session, like the client does.
 */
export { requestInit as getAppApiRequestInit };

/**
 * Raw client for surfaces without a dedicated domain wrapper yet (e.g. people
 * / contacts in Phase 6). Returns the same `{ data }` / `{ data, pagination }`
 * envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
