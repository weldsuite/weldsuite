// Test stub for `@weldsuite/mobile-ui/contexts/ClerkAuthContext`.
// MailContext imports `useClerkAuth` at module load; the provider that calls it
// is never rendered in these tests, so a minimal no-op is enough.
module.exports = {
  useClerkAuth: () => ({ getToken: async () => null, isSignedIn: false }),
};
