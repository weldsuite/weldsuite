// Test stub for every `@weldsuite/app-api-client/domains/*` module.
//
// The jest config maps all domain subpaths to this single file, so it must
// export every domain factory that `services/app-api.ts` imports. Each factory
// returns a labeled sentinel so tests can assert the `appApi` object is wired
// to the right domain client.
const factory = (label) => () => ({ __domain: label });

module.exports = {
  createMailAccountsApi: factory('mailAccounts'),
  createMailMessagesApi: factory('mailMessages'),
  createMailThreadsApi: factory('mailThreads'),
  createMailLabelsApi: factory('mailLabels'),
  createMailDraftsApi: factory('mailDrafts'),
  createMailWeldMailApi: factory('mailWeldmail'),
  createMailSnoozeApi: factory('mailSnooze'),
  createMailScheduledApi: factory('mailScheduled'),
  createMailDomainsApi: factory('mailDomains'),
  createPushTokensApi: factory('pushTokens'),
  createWorkspacesApi: factory('workspaces'),
  createMeApi: factory('me'),
};
