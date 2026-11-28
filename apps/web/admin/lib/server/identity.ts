import '@tanstack/react-start/server-only';

/**
 * Who is signed in, for `lib/auth.ts` (ADR FE-018): the person in the sealed
 * session cookie the OIDC sign-in left (`oidc.ts`), let in only
 * with an account of the staff organization and by an active row of the
 * install's `admin_users` roster, read on every request (`staff-roster.ts`).
 * A missing or broken configuration, cookie or roster row means nobody: the
 * console fails closed.
 */

import { getRequest } from '@tanstack/react-start/server';
import type { AdminIdentity } from '../auth';
import { sessionCookieOf } from './auth-routes';
import { oidcConfig, readSession, type OidcConfig, type StaffSession } from './oidc';
import { staffIdentity } from './staff-roster';

async function currentSession(): Promise<{ config: OidcConfig; session: StaffSession } | null> {
  let config;
  try {
    config = oidcConfig();
  } catch {
    return null;
  }
  const session = await readSession(config, sessionCookieOf(getRequest()));
  return session ? { config, session } : null;
}

/** Whether the request carries a staff session at all. */
export async function isSignedIn(): Promise<boolean> {
  return (await currentSession()) !== null;
}

/** The signed-in admin, or null. */
export async function currentAdminIdentity(): Promise<AdminIdentity | null> {
  const current = await currentSession();
  return current ? staffIdentity(current.session, { staffOrgId: current.config.staffOrgId }) : null;
}
