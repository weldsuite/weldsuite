// Shared by every mobile app's eslint.config.js (required by relative path,
// so new apps scaffolded from _template get it too).
//
// Sign-in state comes from the auth facade, which is Clerk on WeldSuite cloud
// and the server's OIDC provider on EU and self-hosted servers (ADR MOB-006,
// weldsuite-documentation/plans/mobile-server-choice.md). Clerk-only files (passkeys, …) are
// passed as `ignores` and render inside <ClerkOnly>.
//
// An app that no longer offers WeldSuite cloud (Global is retired app by app,
// ADR OPS-025; `servers` in its lib/server.ts) ships no Clerk at all: it
// passes `{ noClerk: true }`, which also rules out LoginScreen (Clerk's own
// forms) in favour of HostedLoginScreen.

/**
 * @param {string[]} [ignores] Clerk-only files of the app, relative to it.
 * @param {{ noClerk?: boolean }} [options]
 */
module.exports = function authFacadeImports(ignores = [], options = {}) {
  const patterns = [
    {
      group: ['@clerk/expo', '@clerk/expo/*'],
      message: 'Import sign-in state from @weldsuite/mobile-platform/auth (the auth facade).',
    },
  ];
  if (options.noClerk) {
    patterns.push(
      {
        group: ['@clerk/*'],
        message: 'This app ships no Clerk: it signs in on its server’s own page (WeldID).',
      },
      {
        group: ['@weldsuite/mobile-ui/components/LoginScreen'],
        message: 'LoginScreen loads Clerk. Use @weldsuite/mobile-ui/components/HostedLoginScreen.',
      },
    );
  }
  return {
    files: ['**/*.ts', '**/*.tsx'],
    ignores,
    rules: {
      'no-restricted-imports': ['error', { patterns }],
    },
  };
};
