import '@tanstack/react-start/server-only';

import { redirect } from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import { currentAdminIdentity } from './server/identity';
import type { AdminRole } from './roles';

export interface AdminIdentity {
  /** The admin's user id at the identity provider (Clerk on Global). */
  userId: string;
  /** Lowercased primary email. */
  email: string;
  /** Display name (from the identity provider's profile), when available. */
  name: string | null;
  /** Effective admin role. */
  role: AdminRole;
  /** Convenience flag — true when `role === 'superadmin'`. */
  isSuperAdmin: boolean;
}

/** One identity lookup per request: loaders, guards and actions share it. */
const perRequest = new WeakMap<Request, Promise<AdminIdentity | null>>();

/**
 * Resolve the current admin identity, or `null` if nobody is signed in or the
 * person isn't an admin. The identity provider decides who that is
 * (`lib/server/identity.ts`). Never throws.
 */
export function getAdminIdentity(): Promise<AdminIdentity | null> {
  const request = getRequest();
  let identity = perRequest.get(request);
  if (!identity) {
    identity = currentAdminIdentity().catch((err: unknown) => {
      console.error('[admin/auth] identity lookup failed:', err);
      return null;
    });
    perRequest.set(request, identity);
  }
  return identity;
}

/**
 * Guard for loaders. Returns the admin identity or redirects to the
 * `/unauthorized` screen. Fail-closed.
 */
export async function requireAdmin(): Promise<AdminIdentity> {
  const identity = await getAdminIdentity();
  if (!identity) throw redirect({ href: '/unauthorized' });
  return identity;
}

/**
 * Guard for pages that must be superadmin-only. Redirects viewers/admins to
 * `/unauthorized`.
 */
export async function requireSuperAdmin(): Promise<AdminIdentity> {
  const identity = await requireAdmin();
  if (!identity.isSuperAdmin) throw redirect({ href: '/unauthorized' });
  return identity;
}

export type Guarded =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; error: string };

/**
 * Action guard for write operations. Denies unauthenticated users and
 * read-only `viewer` admins. Returns an error result (no redirect) so server
 * actions can surface it as a toast instead of navigating away.
 */
export async function guardWrite(): Promise<Guarded> {
  const identity = await getAdminIdentity();
  if (!identity) return { ok: false, error: 'Not authorized' };
  if (identity.role === 'viewer') {
    return { ok: false, error: 'Your account has read-only access' };
  }
  return { ok: true, identity };
}

/**
 * Action guard for superadmin-only operations. Only superadmins qualify.
 */
export async function guardSuperAdmin(): Promise<Guarded> {
  const identity = await getAdminIdentity();
  if (!identity) return { ok: false, error: 'Not authorized' };
  if (!identity.isSuperAdmin) {
    return { ok: false, error: 'Only superadmins can perform this action' };
  }
  return { ok: true, identity };
}
