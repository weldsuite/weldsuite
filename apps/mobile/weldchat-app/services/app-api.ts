/**
 * app-api client for WeldChat mobile.
 *
 * Wires the WeldChat mobile app to the unified app-api (`/api`) via the shared
 * `@weldsuite/app-api-client` domain clients. This is the sole API client for
 * the app. A module-level token getter is wired from `app/_layout.tsx` using Clerk
 * credentials (see `setAppApiTokenGetter`) — the client re-reads the token on
 * every request, so no rebuild is needed when it refreshes.
 *
 * Domain clients return the app-api envelope: `{ data }` for single items,
 * `{ data, pagination }` for lists, and they THROW on non-2xx (204 → `{}`).
 * Call sites wrap calls in try/catch and read `.data` directly — no
 * `{ success }` branching like the legacy client.
 */

import { createClientApi } from '@weldsuite/api-client/client';
import { createChannelsApi } from '@weldsuite/app-api-client/domains/channels';
import { createChatMessagesApi } from '@weldsuite/app-api-client/domains/chat-messages';
import { createChatSectionsApi } from '@weldsuite/app-api-client/domains/chat-sections';
import { createChatDmApi } from '@weldsuite/app-api-client/domains/chat-dm';
import { createChatSearchApi } from '@weldsuite/app-api-client/domains/chat-search';
import { createChatCallsApi } from '@weldsuite/app-api-client/domains/chat-calls';
import { createChatMembersApi } from '@weldsuite/app-api-client/domains/chat-members';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createNotificationsApi } from '@weldsuite/app-api-client/domains/notifications';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';

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
  channels: createChannelsApi(client),
  chatMessages: createChatMessagesApi(client),
  chatSections: createChatSectionsApi(client),
  chatDm: createChatDmApi(client),
  chatSearch: createChatSearchApi(client),
  chatCalls: createChatCallsApi(client),
  chatMembers: createChatMembersApi(client),
  // AI chat agent (chatAgent.ask via /ask) has been removed along with the
  // AI backend — see ChannelView.tsx's handleSend for the unavailable notice.
  workspaces: createWorkspacesApi(client),
  pushTokens: createPushTokensApi(client),
  notifications: createNotificationsApi(client),
  dashboard: createDashboardApi(client),
};

/**
 * Raw client for surfaces without a dedicated domain wrapper yet. Returns the
 * same `{ data }` / `{ data, pagination }` envelopes and throws on non-2xx.
 */
export { client as appApiClient };

export default appApi;
