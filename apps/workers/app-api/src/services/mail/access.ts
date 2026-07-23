/**
 * Mail account access control.
 *
 * Shared accounts (`isShared = true`) are visible to every workspace
 * member. Non-shared accounts are visible only to assigned users and to
 * workspace admins/owners. The SQL predicate is exposed separately so list
 * queries can compose it into their WHERE clause without an extra round
 * trip.
 */

import { eq, and, or, sql, isNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';

const { mailAccounts, workspaceMembers } = schema;

export async function isAdminOrOwner(db: Database, userId: string): Promise<boolean> {
  const memberResult = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  const role = memberResult[0]?.role?.toUpperCase();
  return role === 'OWNER' || role === 'ADMIN';
}

export function userAccessCondition(userId: string): SQL {
  return or(
    eq(mailAccounts.isShared, true),
    sql`${mailAccounts.assignedUserIds} @> ${JSON.stringify([userId])}::jsonb`,
  )!;
}

export function hasAccessToAccount(
  account: { isShared: boolean | null; assignedUserIds: string[] | null },
  userId: string,
  isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  if (account.isShared) return true;
  return account.assignedUserIds?.includes(userId) ?? false;
}

/**
 * Verify that `userId` can access the mail account identified by
 * `accountId`. Returns `true` when access is allowed, `false` when the
 * account doesn't exist, and `false` when the caller lacks access.
 *
 * Callers should map `false` to 404 (account-not-found) or 403
 * (forbidden) as appropriate for the context. This helper intentionally
 * does not distinguish the two cases to avoid leaking account existence
 * to unprivileged callers — route handlers that already confirmed the
 * resource exists may use `hasAccessToAccount` directly.
 */
export async function checkAccountAccess(
  db: Database,
  accountId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ isShared: mailAccounts.isShared, assignedUserIds: mailAccounts.assignedUserIds })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!row) return false;

  const admin = await isAdminOrOwner(db, userId);
  return hasAccessToAccount(row, userId, admin);
}
