/**
 * Clerk-only surfaces: WeldSuite's own sign-in and sign-up forms, the SSO
 * callback, passkeys, two-factor, sessions and step-up verification. They
 * exist only where Clerk is the identity provider (Global). A screen that
 * imports from here must render inside `<ClerkOnly>` from `@/lib/auth`, whose
 * fallback covers the other providers, where the provider's own pages do
 * these jobs.
 *
 * Everything else (who is signed in, the bearer token, workspaces) comes from
 * `@/lib/auth`.
 */

export {
  useClerk,
  useReverification,
  useSession,
  useSignIn,
  useSignUp,
  useOrganizationList as useClerkOrganizationList,
  useUser as useClerkUser,
} from '@clerk/clerk-react';
export {
  isClerkAPIResponseError,
  isClerkRuntimeError,
  isReverificationCancelledError,
} from '@clerk/clerk-react/errors';
export type { PasskeyResource, SessionWithActivitiesResource, TOTPResource } from '@clerk/types';
