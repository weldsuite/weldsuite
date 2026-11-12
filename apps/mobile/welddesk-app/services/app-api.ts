/**
 * Strip tickets domain — desk conversations are the v1 surface.
 */

import { createMobileApiClient } from '@weldsuite/mobile-platform/api';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createChatMembersApi } from '@weldsuite/app-api-client/domains/chat-members';
import { createNotificationsApi } from '@weldsuite/app-api-client/domains/notifications';
import { APP } from '@/lib/server';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

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
  notifications: createNotificationsApi(client),
  members: createChatMembersApi(client),
};

export { client as appApiClient };

export default appApi;
