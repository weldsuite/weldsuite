/**
 * app-api client for WeldAgent mobile.
 *
 * Talks to the unified app-api (`/api`) via shared `@weldsuite/app-api-client`
 * domain clients. A module-level token getter is wired from `app/_layout.tsx`.
 */

import { createMobileApiClient } from '@weldsuite/mobile-platform/api';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createDashboardApi } from '@weldsuite/app-api-client/domains/dashboard';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createPushTokensApi } from '@weldsuite/app-api-client/domains/push-tokens';
import { createWeldAgentApi } from '@weldsuite/app-api-client/domains/weldagent';
import { createWorkspaceAgentsApi } from '@weldsuite/app-api-client/domains/workspace-agents';
import { createAiApi } from '@weldsuite/app-api-client/domains/ai';
import { createNotificationsApi } from '@weldsuite/app-api-client/domains/notifications';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

// Hosts come from the booted server runtime and are read per request, never at import time.
const { client } = createMobileApiClient({
  // WeldAgent isn't an app in the permission registry
  // (@weldsuite/permissions PERMISSION_APPS): `workspace` is the explicit
  // "no app" context, the same checks as sending no header (as before).
  appCode: 'workspace',
  getToken: () => tokenGetter(),
});

export interface CreditsBalance {
  currentBalance: number;
  planCredits: number;
  subscribedCredits: number;
  monthlyAllocation: number;
  rolledOverCredits: number;
  periodStart: string;
  periodEnd: string;
  daysRemaining: number;
  usagePercentage: number;
  isLow: boolean;
  isExhausted: boolean;
}

export const appApi = {
  workspaces: createWorkspacesApi(client),
  dashboard: createDashboardApi(client),
  me: createMeApi(client),
  pushTokens: createPushTokensApi(client),
  notifications: createNotificationsApi(client),
  weldagent: createWeldAgentApi(client),
  agents: createWorkspaceAgentsApi(client),
  ai: createAiApi(client),
  credits: {
    balance(): Promise<{ data: CreditsBalance }> {
      return client.get<{ data: CreditsBalance }>('/credits/balance');
    },
  },
};

export { client as appApiClient };

export default appApi;
