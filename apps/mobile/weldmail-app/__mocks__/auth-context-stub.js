// Test stub for `@weldsuite/mobile-ui/contexts/AuthContext`.
// MailContext imports `useAuthSession` at module load; the provider that calls it
// is never rendered in these tests, so a minimal no-op is enough.
module.exports = {
  useAuthSession: () => ({ getToken: async () => null, isSignedIn: false }),
  AuthSessionProvider: ({ children }) => children,
};
