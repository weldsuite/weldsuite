import '@tanstack/react-start/server-only';

import { auth, clerkClient } from '@clerk/tanstack-react-start/server';
import { ADMIN_ROLES, type AdminRole } from '../roles';
import type { AdminIdentity } from '../auth';

/** Clerk's user, as the SDK's own `@clerk/backend` returns it. */
type User = Awaited<ReturnType<ReturnType<typeof clerkClient>['users']['getUser']>>;

/**
 * Default role for a signed-in admin whose Clerk profile has no explicit
 * `publicMetadata.role`. Access to the console is gated by Clerk itself
 * (sign-ups are disabled, so it's invite-only) — anyone who can sign in is a
 * trusted admin. Superadmin and viewer must be granted explicitly in Clerk.
 */
const DEFAULT_ROLE: AdminRole = 'admin';

function primaryEmail(user: User): string | null {
  const primary =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ??
    user.emailAddresses[0];
  return primary ? primary.emailAddress.trim().toLowerCase() : null;
}

function displayName(user: User): string | null {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || user.username || null;
}

/**
 * Read the admin role from the Clerk user's `publicMetadata.role`. Set this in
 * the Clerk dashboard (User → Metadata → Public → `{ "role": "superadmin" }`).
 * Unknown or missing values fall back to {@link DEFAULT_ROLE}.
 */
function roleFromUser(user: User): AdminRole {
  const raw = user.publicMetadata?.role;
  if (typeof raw === 'string' && ADMIN_ROLES.includes(raw as AdminRole)) {
    return raw as AdminRole;
  }
  return DEFAULT_ROLE;
}

/** Whether the request carries a Clerk session at all (sign-in page or not). */
export async function isSignedIn(): Promise<boolean> {
  const { userId } = await auth();
  return Boolean(userId);
}

/**
 * The signed-in admin, or null. Since Clerk is invite-only (sign-ups
 * disabled), every authenticated user is an authorized admin — Clerk is the
 * sole source of truth.
 */
export async function currentAdminIdentity(): Promise<AdminIdentity | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const user = await clerkClient().users.getUser(userId);
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
