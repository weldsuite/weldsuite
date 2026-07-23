import 'server-only';

import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';
import { ADMIN_ROLES, type AdminRole } from './roles';

export interface AdminIdentity {
  /** Clerk user id of the signed-in admin. */
  userId: string;
  /** Lowercased primary email. */
  email: string;
  /** Display name (from Clerk profile), when available. */
  name: string | null;
  /** Effective admin role, from the Clerk user's `publicMetadata.role`. */
  role: AdminRole;
  /** Convenience flag — true when `role === 'superadmin'`. */
  isSuperAdmin: boolean;
}

/**
 * Default role for a signed-in admin whose Clerk profile has no explicit
 * `publicMetadata.role`. Access to the console is gated by Clerk itself
 * (sign-ups are disabled, so it's invite-only) — anyone who can sign in is a
 * trusted admin. Superadmin and viewer must be granted explicitly in Clerk.
 */
const DEFAULT_ROLE: AdminRole = 'admin';

function primaryEmail(user: Awaited<ReturnType<typeof currentUser>>): string | null {
  if (!user) return null;
  const primary =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ??
    user.emailAddresses[0];
  return primary ? primary.emailAddress.trim().toLowerCase() : null;
}

function displayName(user: Awaited<ReturnType<typeof currentUser>>): string | null {
  if (!user) return null;
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.username || null;
}

/**
 * Read the admin role from the Clerk user's `publicMetadata.role`. Set this in
 * the Clerk dashboard (User → Metadata → Public → `{ "role": "superadmin" }`).
 * Unknown or missing values fall back to {@link DEFAULT_ROLE}.
 */
function roleFromUser(user: Awaited<ReturnType<typeof currentUser>>): AdminRole {
  const raw = user?.publicMetadata?.role;
  if (typeof raw === 'string' && ADMIN_ROLES.includes(raw as AdminRole)) {
    return raw as AdminRole;
  }
  return DEFAULT_ROLE;
}

/**
 * Resolve the current admin identity, or `null` if nobody is signed in. Since
 * Clerk is invite-only (sign-ups disabled), every authenticated user is an
 * authorized admin — Clerk is the sole source of truth. Never throws.
 */
export async function getAdminIdentity(): Promise<AdminIdentity | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const user = await currentUser();
  const email = primaryEmail(user);
  if (!email) return null;

  const role = roleFromUser(user);
  return {
    userId,
    email,
    name: displayName(user),
    role,
    isSuperAdmin: role === 'superadmin',
  };
}

/**
 * Guard for pages/layouts. Returns the admin identity or redirects to the
 * `/unauthorized` screen. Fail-closed.
 */
export async function requireAdmin(): Promise<AdminIdentity> {
  const identity = await getAdminIdentity();
  if (!identity) redirect('/unauthorized');
  return identity;
}

/**
 * Guard for pages that must be superadmin-only. Redirects viewers/admins to
 * `/unauthorized`.
 */
export async function requireSuperAdmin(): Promise<AdminIdentity> {
  const identity = await requireAdmin();
  if (!identity.isSuperAdmin) redirect('/unauthorized');
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
