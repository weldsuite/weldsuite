/**
 * Mail account access control.
 *
 * Ported from `packages/domains/mail/src/access.ts` so the MCP
 * surface can never be broader than the UI's. Mail is the one object group
 * where a workspace-level permission is not the whole story: `messages:read`
 * says the caller may read mail, but *which* mailboxes is decided per account.
 * Shared accounts (`isShared`) are open to every member; a private account
 * only to its assigned users, admins/owners included. A private account with
 * nobody assigned falls back to admins/owners so it is never left unreadable.
 *
 * Every mail route resolves the caller's reachable accounts through here
 * before touching messages, labels or drafts — a tool call must not be able to
 * read a colleague's private mailbox just because it arrived over MCP.
 */

import { and, eq, inArray, isNull, or, sql, type Column, type SQL } from 'drizzle-orm';
import { schema } from '../db';
import type { Database } from '../db';

const { mailAccounts, workspaceMembers } = schema;

/** The role opens unassigned private mailboxes, nothing more. */
async function isAdminOrOwner(db: Database, userId: string): Promise<boolean> {
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  const role = member?.role?.toUpperCase();
  return role === 'OWNER' || role === 'ADMIN';
}

/** WHERE fragment selecting the accounts the caller may open. */
function userAccessCondition(userId: string, isAdmin: boolean): SQL {
  return or(
    eq(mailAccounts.isShared, true),
    sql`${mailAccounts.assignedUserIds} @> ${JSON.stringify([userId])}::jsonb`,
    isAdmin
      ? sql`coalesce(${mailAccounts.assignedUserIds}, '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb)`
      : undefined,
  )!;
}

/** Ids of every mail account the caller can reach. */
export async function accessibleAccountIds(db: Database, userId: string): Promise<string[]> {
  const admin = await isAdminOrOwner(db, userId);
  const rows = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(isNull(mailAccounts.deletedAt), userAccessCondition(userId, admin)));

  return rows.map((row) => row.id);
}

/**
 * Restrict a query to the caller's mailboxes.
 *
 * With no reachable accounts the condition is deliberately unsatisfiable
 * rather than absent, so an empty list can never widen into "everything".
 */
export function accountScopeCondition(
  /** The `accountId` column of the table being filtered (or `mailAccounts.id`). */
  column: Column,
  accounts: string[],
): SQL {
  if (accounts.length === 0) return sql`false`;
  return inArray(column, accounts);
}

/**
 * Verify the caller may use one specific account.
 *
 * `false` covers both "no such account" and "not yours" — the two are not
 * distinguished, so a caller cannot probe for the existence of mailboxes it
 * has no business knowing about.
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
  if (row.isShared) return true;

  const assigned = row.assignedUserIds ?? [];
  if (assigned.length > 0) return assigned.includes(userId);
  return isAdminOrOwner(db, userId);
}
