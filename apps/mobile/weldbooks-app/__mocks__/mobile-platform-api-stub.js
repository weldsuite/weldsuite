// Stands in for @weldsuite/mobile-platform/api, which needs the booted server
// runtime. The origin is tested in mobile-platform.
module.exports = {
  apiOrigin: jest.fn(() => 'http://localhost:8080'),
  // X-Weld-Workspace: only in OIDC header mode (WeldID in membership mode).
  // Nothing to add here outside that mode — see mobile-platform's own tests.
  workspaceHeaders: jest.fn(() => ({})),
};
