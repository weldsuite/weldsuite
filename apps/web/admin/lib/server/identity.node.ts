import '@tanstack/react-start/server-only';

import type * as Clerk from './identity.clerk';

/**
 * Who is signed in, on the Node build for Kubernetes (ADR FE-018). Staff will
 * sign in with the install's Zitadel, and only people on its `admin_users`
 * roster get in. Until that lands nobody is signed in: the console fails
 * closed, every page sends people to the sign-in page, and every server
 * function refuses.
 */
export const isSignedIn: typeof Clerk.isSignedIn = async () => false;

export const currentAdminIdentity: typeof Clerk.currentAdminIdentity = async () => null;
