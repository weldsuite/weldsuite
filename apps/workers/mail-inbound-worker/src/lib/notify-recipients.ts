/**
 * Who is notified (realtime + push) about new mail in a workspace mailbox.
 *
 * The list is exactly the members who may open the mailbox, so it mirrors
 * `hasAccessToAccount` in `@weldsuite/mail-domain/access` (this worker does
 * not depend on that package; keep the two in step):
 *
 * - shared mailbox: every member;
 * - private mailbox: its assigned users only, admins/owners included;
 * - private mailbox with nobody assigned: admins/owners, the fallback readers.
 *
 * The result may be empty (every assignee deactivated, say). That only means
 * nobody is pinged: the caller must still store the message.
 */

export interface MailboxAccess {
  isShared: boolean | null;
  assignedUserIds: string[] | null;
}

function isAdminOrOwnerRole(role: string | null | undefined): boolean {
  const upper = role?.toUpperCase();
  return upper === 'OWNER' || upper === 'ADMIN';
}

export function selectNotifyMembers<T extends { userId: string; role: string | null }>(
  account: MailboxAccess,
  members: T[],
): T[] {
  if (account.isShared) return members;
  const assigned = account.assignedUserIds ?? [];
  if (assigned.length === 0) return members.filter((m) => isAdminOrOwnerRole(m.role));
  return members.filter((m) => assigned.includes(m.userId));
}
