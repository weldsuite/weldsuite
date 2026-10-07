/**
 * Mail account access control.
 *
 * Two questions, answered separately:
 *
 * - **Who may open the mailbox** (read, send, label, rules, …). Shared accounts
 *   (`isShared = true`) are open to every workspace member. A private account
 *   is open only to its assigned users — workspace admins/owners included: the
 *   role alone does not open a colleague's mailbox. A private account with
 *   nobody assigned falls back to admins/owners, so a mailbox can never end up
 *   with no reader at all.
 * - **Who may manage the account** (settings, access, delete). Anyone who may
 *   open it, plus admins/owners. Managing never exposes mail; an admin who
 *   needs to read a private mailbox has to assign themselves first, which
 *   shows in the account's access list and its `mail_account` update event.
 *
 * The SQL predicate is exposed separately so list queries can compose it into
 * their WHERE clause without an extra round trip.
 */

import { eq, and, or, sql, isNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, workspaceMembers } = schema;

type AccountAccessFields = { isShared: boolean | null; assignedUserIds: string[] | null };

export async function isAdminOrOwner(db: Database, userId: string): Promise<boolean> {
  const memberResult = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  const role = memberResult[0]?.role?.toUpperCase();
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * WHERE fragment selecting the accounts `userId` may open. `isAdmin` only adds
 * the private accounts nobody is assigned to.
 */
export function userAccessCondition(userId: string, isAdmin: boolean): SQL {
  return or(
    eq(mailAccounts.isShared, true),
    sql`${mailAccounts.assignedUserIds} @> ${JSON.stringify([userId])}::jsonb`,
    isAdmin
      ? sql`coalesce(${mailAccounts.assignedUserIds}, '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb)`
      : undefined,
  )!;
}

/**
 * Ids of the accounts `userId` may open. For reads that span mailboxes (a
 * unified summary, a workspace-wide counter): scope them to this list, and
 * treat an empty list as "nothing to show", never as "no filter".
 */
export async function listAccessibleAccountIds(db: Database, userId: string): Promise<string[]> {
  const admin = await isAdminOrOwner(db, userId);
  const rows = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(isNull(mailAccounts.deletedAt), userAccessCondition(userId, admin)));
  return rows.map((r) => r.id);
}

/** Whether `userId` may open the mailbox. Mirrors {@link userAccessCondition}. */
export function hasAccessToAccount(
  account: AccountAccessFields,
  userId: string,
  isAdmin: boolean,
): boolean {
  if (account.isShared) return true;
  const assigned = account.assignedUserIds ?? [];
  if (assigned.length === 0) return isAdmin;
  return assigned.includes(userId);
}

/** Whether `userId` may change the account's settings, access or delete it. */
export function canManageAccount(
  account: AccountAccessFields,
  userId: string,
  isAdmin: boolean,
): boolean {
  return isAdmin || hasAccessToAccount(account, userId, false);
}

async function loadAccessFields(db: Database, accountId: string): Promise<AccountAccessFields | null> {
  const [row] = await db
    .select({ isShared: mailAccounts.isShared, assignedUserIds: mailAccounts.assignedUserIds })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Verify that `userId` may open the mail account identified by `accountId`.
 * Returns `true` when access is allowed, `false` when the account doesn't
 * exist, and `false` when the caller lacks access.
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
  const row = await loadAccessFields(db, accountId);
  if (!row) return false;

  const admin = await isAdminOrOwner(db, userId);
  return hasAccessToAccount(row, userId, admin);
}

/**
 * Verify that `userId` may manage the mail account identified by `accountId`.
 * Same `false` semantics as {@link checkAccountAccess}.
 */
export async function checkAccountManageAccess(
  db: Database,
  accountId: string,
  userId: string,
): Promise<boolean> {
  const row = await loadAccessFields(db, accountId);
  if (!row) return false;

  const admin = await isAdminOrOwner(db, userId);
  return canManageAccount(row, userId, admin);
}

/** The message content an `email` entity event can carry. */
type EmailEventContent = {
  accountId: string;
  subject?: string | null;
  from?: string | null;
  to?: string[] | null;
};

/**
 * Payload for an `email` entity event, cleared of message content unless the
 * mailbox is shared.
 *
 * Entity events are workspace-wide, not mailbox-scoped: the realtime hub
 * pushes the payload to every connected member, the audit log keeps it for
 * anyone with `general:read`, and webhooks, workflows and agents receive it as
 * trigger data. So only a shared mailbox, which every member may open anyway,
 * may put subject, sender or recipients on one. For a private mailbox the
 * event keeps its ids, which is all the cache refresh needs.
 *
 * Never throws, and fails closed: an account that cannot be resolved is
 * treated as private.
 */
export async function emailEventData<T extends EmailEventContent>(db: Database, data: T): Promise<T> {
  let shared = false;
  try {
    if (data.accountId) {
      shared = (await loadAccessFields(db, data.accountId))?.isShared === true;
    }
  } catch (err) {
    console.error('[mail/access] Could not resolve account for email event, dropping content:', err);
  }
  return shared ? data : { ...data, subject: null, from: null, to: null };
}
