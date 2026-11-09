import '@tanstack/react-start/server-only';

/**
 * Who may use the console on the Kubernetes editions, and as what: the
 * install's `admin_users` roster, which `weldsuite admin staff` manages (ADR
 * SEC-014). Read on every request, so removing someone, or taking their
 * superadmin away, applies at once, not when their session ends.
 *
 * A person is matched by the provider's subject first (`user_id`, which
 * `staff add` fills from the platform's users, or the first sign-in below).
 * A roster row nobody has signed in to yet matches the person's email, if
 * the provider says they verified it, and is then bound to their subject, so
 * from then on only that account gets in, whatever happens to the email.
 * No active row, no access.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { ADMIN_ROLES, type AdminRole } from '../roles';
import type { AdminIdentity } from '../auth';
import { getMasterDb, masterSchema } from '../db';
import type { StaffSession } from './oidc';

const { adminUsers } = masterSchema;

type RosterRow = { email: string; name: string | null; role: AdminRole; userId: string | null };

/** The role a roster row grants; an unknown value grants nothing. */
export function roleOf(value: string): AdminRole | null {
  return ADMIN_ROLES.includes(value as AdminRole) ? (value as AdminRole) : null;
}

/**
 * The decision, apart from the database: the row matched on the subject, else
 * the unbound row matched on a verified email, else nothing. Exported for its
 * tests.
 */
export function decide(
  session: StaffSession,
  bySubject: RosterRow | undefined,
  byEmail: RosterRow | undefined,
): { row: RosterRow; bind: boolean } | null {
  if (bySubject) return { row: bySubject, bind: false };
  if (!byEmail || !session.emailVerified || !session.email) return null;
  // Bound to another account: someone else signed in with this email first.
  if (byEmail.userId !== null) return null;
  return { row: byEmail, bind: true };
}

const columns = {
  email: adminUsers.email,
  name: adminUsers.name,
  role: adminUsers.role,
  userId: adminUsers.userId,
};

/** The admin identity for a signed-in person, or null when the roster doesn't let them in. */
export async function staffIdentity(session: StaffSession, { signingIn = false } = {}): Promise<AdminIdentity | null> {
  const db = getMasterDb();
  const [bySubject] = await db
    .select(columns)
    .from(adminUsers)
    .where(and(eq(adminUsers.userId, session.sub), eq(adminUsers.isActive, true)))
    .limit(1);
  const [byEmail] =
    bySubject || !session.email || !session.emailVerified
      ? []
      : await db
          .select(columns)
          .from(adminUsers)
          .where(and(sql`lower(${adminUsers.email}) = ${session.email}`, eq(adminUsers.isActive, true)))
          .limit(1);

  const decision = decide(session, bySubject, byEmail);
  const role = decision ? roleOf(decision.row.role) : null;
  if (!decision || !role) return null;

  if (decision.bind) {
    // Only while still unbound: of two first sign-ins at once, one wins.
    const bound = await db
      .update(adminUsers)
      .set({ userId: session.sub, name: decision.row.name ?? session.name, lastLoginAt: new Date(), updatedAt: new Date() })
      .where(and(sql`lower(${adminUsers.email}) = ${session.email}`, isNull(adminUsers.userId), eq(adminUsers.isActive, true)))
      .returning({ email: adminUsers.email });
    if (bound.length === 0) return null;
  } else if (signingIn) {
    await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.userId, session.sub));
  }

  return {
    userId: session.sub,
    email: decision.row.email.toLowerCase(),
    name: decision.row.name ?? session.name,
    role,
    isSuperAdmin: role === 'superadmin',
  };
}
