import '@tanstack/react-start/server-only';

/**
 * Who is signed in, for `lib/auth.ts`. Global signs in with the console's own
 * invite-only Clerk instance (ADR SEC-009); the Kubernetes build will swap this
 * module for an OIDC one (ADR FE-018).
 */
export { currentAdminIdentity, isSignedIn } from './identity.clerk';
