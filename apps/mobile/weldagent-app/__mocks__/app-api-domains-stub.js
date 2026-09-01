// Test stub for every `@weldsuite/app-api-client/domains/*` module.
//
// The jest config maps all domain subpaths here, so this must export each
// factory `services/app-api.ts` imports. Returns a labeled sentinel.
const factory = (label) => () => ({ __domain: label });

module.exports = {
  createWorkspacesApi: factory('workspaces'),
  createDashboardApi: factory('dashboard'),
  createMeApi: factory('me'),
  createPushTokensApi: factory('pushTokens'),
  createWeldAgentApi: factory('weldagent'),
  createWorkspaceAgentsApi: factory('agents'),
  createAiApi: factory('ai'),
  createNotificationsApi: factory('notifications'),
};
