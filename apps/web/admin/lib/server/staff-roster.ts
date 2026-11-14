import '@tanstack/react-start/server-only';

/**
 * Who may use the console on the Kubernetes editions, and as what: the
 * install's `admin_users` roster, which `weldsuite admin staff` manages (ADR
 * SEC-014). Read on every request, so removing someone, or taking their
 * superadmin away, applies at once, not when their session ends.
 *
 * Only an account of the staff organization (`ADMIN_OIDC_ORG_ID`) gets in,
 * never a person's platform account (ADR SEC-018). It is matched on the row's
 * `console_subject`, which only this file writes: a row nobody has signed in
 * to yet matches the person's email, if the provider says they verified it,
 * and is then bound to their account, so from then on only that account gets
 * in, whatever happens to the email. `user_id` is the platform account, for
 * the WeldApps review gate; the console neither reads nor writes it.
 * No active row, no access.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { ADMIN_ROLES, type AdminRole } from '../roles';
import type { AdminIdentity } from '../auth';
import { getMasterDb, masterSchema } from '../db';
import type { StaffSession } from './oidc';

const { adminUsers } = masterSchema;

type RosterRow = {
  email: string;
  name: string | null;
  role: AdminRole;
  isActive: boolean;
  consoleSubject: string | null;
};

/** The role a roster row grants; an unknown value grants nothing. */
export function roleOf(value: string): AdminRole | null {
  return ADMIN_ROLES.includes(value as AdminRole) ? (value as AdminRole) : null;
}

/**
 * The decision, apart from the database: nothing for an account outside the
 * staff organization; else the row bound to the account, while it is active;
 * else the active, unbound row of a verified email; else nothing. Exported
 * for its tests.
 */
export function decide(
  session: StaffSession,
  staffOrgId: string,
  bySubject: RosterRow | undefined,
  byEmail: RosterRow | undefined,
): { row: RosterRow; bind: boolean } | null {
  if (!staffOrgId || session.org !== staffOrgId) return null;
  // A removed person's account stays out, under any email.
  if (bySubject) return bySubject.isActive ? { row: bySubject, bind: false } : null;
  if (!byEmail?.isActive || !session.emailVerified || !session.email) return null;
  // Bound to another account: someone else signed in with this email first.
  if (byEmail.consoleSubject !== null) return null;
  return { row: byEmail, bind: true };
}

const columns = {
  email: adminUsers.email,
  name: adminUsers.name,
  role: adminUsers.role,
  isActive: adminUsers.isActive,
  consoleSubject: adminUsers.consoleSubject,
};

/** The admin identity for a signed-in person, or null when the roster doesn't let them in. */
export async function staffIdentity(
  session: StaffSession,
  { staffOrgId, signingIn = false }: { staffOrgId: string; signingIn?: boolean },
): Promise<AdminIdentity | null> {
  if (!staffOrgId || session.org !== staffOrgId) return null;
  const db = getMasterDb();
  const [bySubject] = await db.select(columns).from(adminUsers).where(eq(adminUsers.consoleSubject, session.sub)).limit(1);
  const [byEmail] =
    bySubject || !session.email || !session.emailVerified
      ? []
      : await db
          .select(columns)
          .from(adminUsers)
          .where(and(sql`lower(${adminUsers.email}) = ${session.email}`, eq(adminUsers.isActive, true)))
          .limit(1);

  const decision = decide(session, staffOrgId, bySubject, byEmail);
  const role = decision ? roleOf(decision.row.role) : null;
  if (!decision || !role) return null;

  if (decision.bind) {
    // Only while still unbound: of two first sign-ins at once, one wins.
    const bound = await db
      .update(adminUsers)
      .set({ consoleSubject: session.sub, name: decision.row.name ?? session.name, lastLoginAt: new Date(), updatedAt: new Date() })
      .where(
        and(sql`lower(${adminUsers.email}) = ${session.email}`, isNull(adminUsers.consoleSubject), eq(adminUsers.isActive, true)),
      )
      .returning({ email: adminUsers.email });
    if (bound.length === 0) return null;
  } else if (signingIn) {
    await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.consoleSubject, session.sub));
  }

  return {
    userId: session.sub,
    email: decision.row.email.toLowerCase(),
    name: decision.row.name ?? session.name,
    role,
    isSuperAdmin: role === 'superadmin',
  };
}
