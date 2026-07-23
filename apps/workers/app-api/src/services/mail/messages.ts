/**
 * Mail message service — read/patch operations.
 *
 * Send paths live in `./send.ts` so the same code drives both compose and
 * reply. This file is everything that doesn't talk to Cloudflare's
 * `send_email` binding.
 */

import { and, asc, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import { labelCondition, addLabels, removeLabels } from './labels';

const { mailMessages, mailAttachments, people: contacts } = schema;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface MessageFilters {
  accountId?: string;
  /**
   * Restricts results to this set of account IDs. Used by the route layer
   * to enforce per-account access control when no single `accountId` is
   * provided — the route resolves the caller's accessible accounts and
   * passes them here.
   */
  accessibleAccountIds?: string[];
  limit?: number;
  cursor?: string;
  search?: string;
  isRead?: boolean;
  isStarred?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
  threadId?: string;
  label?: string;
  /** Only return messages whose `from.email` is in this set. */
  fromEmails?: string[];
}

export async function listMessages(db: Database, filters: MessageFilters) {
  const limit = Math.min(filters.limit ?? 50, 100);
  const conditions: SQL[] = [isNull(mailMessages.deletedAt)!];

  if (filters.accountId) conditions.push(eq(mailMessages.accountId, filters.accountId));
  if (filters.accessibleAccountIds) {
    conditions.push(inArray(mailMessages.accountId, filters.accessibleAccountIds));
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(or(like(mailMessages.subject, term), like(mailMessages.preview, term))!);
  }
  if (filters.isRead !== undefined) conditions.push(eq(mailMessages.isRead, filters.isRead));
  if (filters.isStarred !== undefined) conditions.push(eq(mailMessages.isStarred, filters.isStarred));
  if (filters.isFlagged !== undefined) conditions.push(eq(mailMessages.isFlagged, filters.isFlagged));
  if (filters.hasAttachments !== undefined) {
    conditions.push(eq(mailMessages.hasAttachments, filters.hasAttachments));
  }
  if (filters.threadId) conditions.push(eq(mailMessages.threadId, filters.threadId));
  if (filters.label) conditions.push(labelCondition(filters.label));

  if (filters.cursor) {
    const [cur] = await db
      .select({ sentDate: mailMessages.sentDate, id: mailMessages.id })
      .from(mailMessages)
      .where(eq(mailMessages.id, filters.cursor))
      .limit(1);
    if (cur?.sentDate) {
      conditions.push(
        sql`(${mailMessages.sentDate} < ${cur.sentDate} OR (${mailMessages.sentDate} = ${cur.sentDate} AND ${mailMessages.id} < ${cur.id}))`,
      );
    }
  }

  const where = and(...conditions);
  const filterConditions = filters.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = and(...filterConditions);

  const [rows, countRes] = await Promise.all([
    db
      .select({
        id: mailMessages.id,
        accountId: mailMessages.accountId,
        messageId: mailMessages.messageId,
        threadId: mailMessages.threadId,
        from: mailMessages.from,
        to: mailMessages.to,
        cc: mailMessages.cc,
        subject: mailMessages.subject,
        preview: mailMessages.preview,
        sentDate: mailMessages.sentDate,
        receivedDate: mailMessages.receivedDate,
        isRead: mailMessages.isRead,
        isStarred: mailMessages.isStarred,
        isFlagged: mailMessages.isFlagged,
        isImportant: mailMessages.isImportant,
        isDraft: mailMessages.isDraft,
        hasAttachments: mailMessages.hasAttachments,
        attachmentCount: mailMessages.attachmentCount,
        priority: mailMessages.priority,
        labels: mailMessages.labels,
        sizeBytes: mailMessages.sizeBytes,
        scheduledFor: mailMessages.scheduledFor,
        sendStatus: mailMessages.sendStatus,
        createdAt: mailMessages.createdAt,
      })
      .from(mailMessages)
      .where(where)
      .orderBy(desc(mailMessages.sentDate), desc(mailMessages.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(mailMessages).where(countWhere),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
  const totalCount = Number(countRes[0]?.count ?? 0);

  // Resolve sender contact name + avatar so the list view doesn't need a
  // second round-trip per row. Best-effort — never gates the response.
  await enrichSenderContacts(db, data);

  return { data, hasMore, cursor, totalCount };
}

async function enrichSenderContacts(
  db: Database,
  rows: Array<{ from: unknown }>,
): Promise<void> {
  const senderEmails = new Set<string>();
  for (const msg of rows) {
    const from = msg.from as { email?: string } | null;
    if (from?.email) senderEmails.add(from.email.toLowerCase());
  }
  if (senderEmails.size === 0) return;

  const contactRows = await db
    .select({
      email: contacts.email,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      avatarUrl: contacts.avatarUrl,
    })
    .from(contacts)
    .where(and(inArray(contacts.email, [...senderEmails]), isNull(contacts.deletedAt)));

  const nameMap = new Map<string, string>();
  const avatarMap = new Map<string, string>();
  for (const row of contactRows) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    const name = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim();
    if (name && !nameMap.has(key)) nameMap.set(key, name);
    if (row.avatarUrl && !avatarMap.has(key)) avatarMap.set(key, row.avatarUrl);
  }

  for (const msg of rows) {
    const from = msg.from as { email?: string; name?: string } | null;
    if (from?.email) {
      const key = from.email.toLowerCase();
      const contactName = nameMap.get(key);
      const avatarUrl = avatarMap.get(key);
      if (contactName || avatarUrl) {
        (msg as { from: unknown }).from = {
          ...from,
          name: contactName ?? from.name,
          avatarUrl: avatarUrl ?? null,
        };
      }
    }
  }
}

/**
 * Lightweight helper used by route handlers to resolve a message's
 * `accountId` without fetching the full row. Returns `null` when the
 * message doesn't exist or is soft-deleted.
 */
export async function getMessageAccountId(db: Database, id: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: mailMessages.accountId })
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  return row?.accountId ?? null;
}

export async function getMessage(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!row) return null;

  const attachments = row.hasAttachments
    ? await db.select().from(mailAttachments).where(eq(mailAttachments.messageId, id))
    : [];
  return { ...row, attachments };
}

export async function getThread(db: Database, messageId: string) {
  const [anchor] = await db
    .select({ threadId: mailMessages.threadId, accountId: mailMessages.accountId })
    .from(mailMessages)
    .where(and(eq(mailMessages.id, messageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  // Only a genuinely missing (or deleted) message yields no thread. A message
  // that simply has no `threadId` is a conversation of one — return it as a
  // single-message thread rather than null. Callers (the mobile detail views)
  // fetch the message and its thread together, so a null here used to 404 the
  // whole open and surface a bogus "Email not found" for any threadless email.
  if (!anchor) return null;
  if (!anchor.threadId) {
    const single = await db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.id, messageId), isNull(mailMessages.deletedAt)))
      .limit(1);
    return { threadId: messageId, messages: single };
  }

  const rows = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.threadId, anchor.threadId),
        eq(mailMessages.accountId, anchor.accountId),
        isNull(mailMessages.deletedAt),
      ),
    )
    .orderBy(asc(mailMessages.sentDate), asc(mailMessages.id));
  return { threadId: anchor.threadId, messages: rows };
}

export async function getMessageStats(db: Database, accountId?: string) {
  const conditions: SQL[] = [isNull(mailMessages.deletedAt)!];
  if (accountId) conditions.push(eq(mailMessages.accountId, accountId));
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where is_read = false)::int`,
      inboxUnread: sql<number>`count(*) filter (where labels @> '["INBOX"]'::jsonb AND is_read = false)::int`,
      starred: sql<number>`count(*) filter (where labels @> '["STARRED"]'::jsonb)::int`,
    })
    .from(mailMessages)
    .where(and(...conditions));
  return row ?? { total: 0, unread: 0, inboxUnread: 0, starred: 0 };
}

// ---------------------------------------------------------------------------
// Patch / Delete / Bulk / Labels
// ---------------------------------------------------------------------------

export interface UpdateMessageInput {
  isRead?: boolean;
  isStarred?: boolean;
  isFlagged?: boolean;
  isImportant?: boolean;
  isSpam?: boolean;
  isTrash?: boolean;
  threadId?: string;
  labels?: string[];
}

export async function updateMessage(
  db: Database,
  id: string,
  data: UpdateMessageInput,
): Promise<typeof mailMessages.$inferSelect | null> {
  const [existing] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;

  await db
    .update(mailMessages)
    .set(patch as typeof mailMessages.$inferInsert)
    .where(eq(mailMessages.id, id));

  const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, id)).limit(1);
  return after!;
}

/**
 * Soft-delete a message. Returns the identifying fields the route needs
 * for the entity event payload, or `null` when no live message had that id.
 */
export async function softDeleteMessage(
  db: Database,
  id: string,
): Promise<{ id: string; accountId: string; subject: string | null } | null> {
  const [existing] = await db
    .select({
      id: mailMessages.id,
      accountId: mailMessages.accountId,
      subject: mailMessages.subject,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!existing) return null;

  await db
    .update(mailMessages)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailMessages.id, id));
  return existing;
}

export type BulkAction =
  | 'markRead'
  | 'markUnread'
  | 'star'
  | 'unstar'
  | 'flag'
  | 'unflag'
  | 'trash'
  | 'restore'
  | 'delete';

export async function bulkUpdateMessages(
  db: Database,
  messageIds: string[],
  action: BulkAction,
): Promise<{ affected: number }> {
  const now = new Date();
  const where = and(inArray(mailMessages.id, messageIds), isNull(mailMessages.deletedAt));

  switch (action) {
    case 'markRead':
      await db.update(mailMessages).set({ isRead: true, updatedAt: now }).where(where);
      break;
    case 'markUnread':
      await db.update(mailMessages).set({ isRead: false, updatedAt: now }).where(where);
      break;
    case 'star':
      await db.update(mailMessages).set({ isStarred: true, updatedAt: now }).where(where);
      break;
    case 'unstar':
      await db.update(mailMessages).set({ isStarred: false, updatedAt: now }).where(where);
      break;
    case 'flag':
      await db.update(mailMessages).set({ isFlagged: true, updatedAt: now }).where(where);
      break;
    case 'unflag':
      await db.update(mailMessages).set({ isFlagged: false, updatedAt: now }).where(where);
      break;
    case 'trash':
      await db
        .update(mailMessages)
        .set({
          isTrash: true,
          labels: sql`coalesce(${mailMessages.labels}, '[]'::jsonb) - 'INBOX' || '["TRASH"]'::jsonb`,
          updatedAt: now,
        })
        .where(where);
      break;
    case 'restore':
      await db
        .update(mailMessages)
        .set({
          isTrash: false,
          labels: sql`coalesce(${mailMessages.labels}, '[]'::jsonb) - 'TRASH' || '["INBOX"]'::jsonb`,
          updatedAt: now,
        })
        .where(where);
      break;
    case 'delete':
      await db.update(mailMessages).set({ deletedAt: now, updatedAt: now }).where(where);
      break;
  }
  return { affected: messageIds.length };
}

export async function addMessageLabels(
  db: Database,
  id: string,
  labels: string[],
): Promise<string[] | null> {
  const [existing] = await db
    .select({ labels: mailMessages.labels })
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const next = addLabels(existing.labels as string[] | null, ...labels);
  await db
    .update(mailMessages)
    .set({ labels: next, updatedAt: new Date() })
    .where(eq(mailMessages.id, id));
  return next;
}

export async function removeMessageLabels(
  db: Database,
  id: string,
  labels: string[],
): Promise<string[] | null> {
  const [existing] = await db
    .select({ labels: mailMessages.labels })
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const next = removeLabels(existing.labels as string[] | null, ...labels);
  await db
    .update(mailMessages)
    .set({ labels: next, updatedAt: new Date() })
    .where(eq(mailMessages.id, id));
  return next;
}
