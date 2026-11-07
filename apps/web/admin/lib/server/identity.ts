import '@tanstack/react-start/server-only';

/**
 * Who is signed in, for `lib/auth.ts`. Global signs in with the console's own
 * invite-only Clerk instance (ADR SEC-009). The Node build for Kubernetes
 * resolves this module to `identity.node.ts` instead (vite.config.ts).
 */
export { currentAdminIdentity, isSignedIn } from './identity.clerk';
