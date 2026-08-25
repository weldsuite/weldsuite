// Test stub for every `@weldsuite/app-api-client/domains/*` module.
//
// The jest config maps all domain subpaths here, so this must export each
// factory `services/api.ts` imports. Returns a labeled sentinel.
const factory = (label) => () => ({ __domain: label });

module.exports = {
  createWorkspacesApi: factory('workspaces'),
};
