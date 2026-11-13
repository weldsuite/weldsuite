// Shared by every mobile app's eslint.config.js (required by relative path,
// so new apps scaffolded from _template get it too).
//
// Sign-in state comes from the auth facade, which is Clerk on WeldSuite cloud
// and the server's OIDC provider on EU and self-hosted servers (ADR MOB-006,
// docs/plans/mobile-server-choice.md). Clerk-only files (passkeys, …) are
// passed as `ignores` and render inside <ClerkOnly>.

/** @param {string[]} [ignores] Clerk-only files of the app, relative to it. */
module.exports = function authFacadeImports(ignores = []) {
  return {
    files: ['**/*.ts', '**/*.tsx'],
    ignores,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@clerk/expo', '@clerk/expo/*'],
              message: 'Import sign-in state from @weldsuite/mobile-platform/auth (the auth facade).',
            },
          ],
        },
      ],
    },
  };
};
