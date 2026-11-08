import '@tanstack/react-start/server-only';

/**
 * Who is signed in, on the Node build for Kubernetes (ADR FE-018): the person
 * in the sealed session cookie the OIDC sign-in left (`oidc.ts`), let in only
 * by an active row of the install's `admin_users` roster, read on every
 * request (`staff-roster.ts`). A missing or broken configuration, cookie or
 * roster row means nobody: the console fails closed.
 */

import { getRequest } from '@tanstack/react-start/server';
import type * as Clerk from './identity.clerk';
import { sessionCookieOf } from './auth-routes';
import { oidcConfig, readSession, type StaffSession } from './oidc';
import { staffIdentity } from './staff-roster';

async function currentSession(): Promise<StaffSession | null> {
  let config;
  try {
    config = oidcConfig();
  } catch {
    return null;
  }
  return readSession(config, sessionCookieOf(getRequest()));
}

export const isSignedIn: typeof Clerk.isSignedIn = async () => (await currentSession()) !== null;

export const currentAdminIdentity: typeof Clerk.currentAdminIdentity = async () => {
  const session = await currentSession();
  return session ? staffIdentity(session) : null;
};
