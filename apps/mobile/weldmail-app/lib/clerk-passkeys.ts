/**
 * Clerk's passkey support, kept in one file the `@clerk/expo` lint rule lets
 * through (see `ignores` in `eslint.config.js`). Passkeys are a Clerk feature:
 * `AuthProvider` takes them as `clerk={{ passkeys }}` and they only run when
 * the app is signed in through Clerk (WeldSuite cloud).
 */
export { passkeys } from '@clerk/expo/passkeys';
