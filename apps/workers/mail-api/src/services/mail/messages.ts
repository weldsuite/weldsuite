/**
 * Mail message service — read/patch operations.
 *
 * Send paths live in `./send.ts` so the same code drives both compose and
 * reply. This file is everything that doesn't talk to Cloudflare's
 * `send_email` binding.
 */

import { and, asc, desc, eq, inArray, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  addLabels,
  bulkAddLabelToMessages,
  bulkRemoveLabelFromMessages,
  flagsForLabelChange,
  labelCondition,
  moveMessagesToLocation,
  removeLabels,
  resolveCustomLabelNames,
  SYSTEM_LABELS,
} from './labels';

const { mailMessages, mailAttachments, mailDrafts, people: contacts } = schema;

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

/** Escape LIKE wildcards so a search for `50%` or `a_b` matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** One of the addresses in a recipient column (`to` / `cc`) matches the LIKE pattern. */
function recipientMatches(column: SQL, pattern: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END) AS recipient
    WHERE recipient->>'email' ILIKE ${pattern} OR recipient->>'name' ILIKE ${pattern}
  )`;
}

/** The LIKE pattern for a "contains this text" filter. */
export function containsPattern(value: string): string {
  return `%${escapeLike(value.trim())}%`;
}

/** The sender's name or address contains the text. */
export function senderMatches(value: string): SQL {
  const pattern = containsPattern(value);
  return sql`(${mailMessages.from}->>'name' ILIKE ${pattern} OR ${mailMessages.from}->>'email' ILIKE ${pattern})`;
}

/** A To or Cc recipient's name or address contains the text. */
export function anyRecipientMatches(value: string): SQL {
  const pattern = containsPattern(value);
  return sql`(${recipientMatches(sql`${mailMessages.to}`, pattern)} OR ${recipientMatches(sql`${mailMessages.cc}`, pattern)})`;
}

/**
 * Free-text mail search: every space-separated term must appear in the
 * subject, the body, or one of the participants (sender, To, Cc) of a message.
 * Case-insensitive. Returns undefined for an empty query.
 */
export function messageSearchCondition(search: string | undefined): SQL | undefined {
  const terms = (search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 10);
  if (terms.length === 0) return undefined;
  return and(
    ...terms.map((term) => {
      const pattern = containsPattern(term);
      return or(
        ilike(mailMessages.subject, pattern),
        ilike(mailMessages.preview, pattern),
        ilike(mailMessages.textBody, pattern),
        senderMatches(term),
        anyRecipientMatches(term),
      )!;
    }),
  );
}

/** The WHERE conditions a set of message filters translates to (soft-deleted rows always excluded). */
function buildMessageConditions(filters: MessageFilters, labelNames: string[] = []): SQL[] {
  const conditions: SQL[] = [isNull(mailMessages.deletedAt)!];

  if (filters.accountId) conditions.push(eq(mailMessages.accountId, filters.accountId));
  if (filters.accessibleAccountIds) {
    conditions.push(inArray(mailMessages.accountId, filters.accessibleAccountIds));
  }
  const searchCondition = messageSearchCondition(filters.search);
  if (searchCondition) conditions.push(searchCondition);
  if (filters.isRead !== undefined) conditions.push(eq(mailMessages.isRead, filters.isRead));
  if (filters.isStarred !== undefined) conditions.push(eq(mailMessages.isStarred, filters.isStarred));
  if (filters.isFlagged !== undefined) conditions.push(eq(mailMessages.isFlagged, filters.isFlagged));
  if (filters.hasAttachments !== undefined) {
    conditions.push(eq(mailMessages.hasAttachments, filters.hasAttachments));
  }
  if (filters.threadId) conditions.push(eq(mailMessages.threadId, filters.threadId));
  if (filters.label) conditions.push(labelCondition(filters.label, labelNames));

  return conditions;
}

export async function listMessages(db: Database, filters: MessageFilters) {
  const limit = Math.min(filters.limit ?? 50, 100);
  const labelNames = filters.label
    ? await resolveCustomLabelNames(db, filters.label, filters.accountId)
    : [];
  const conditions = buildMessageConditions(filters, labelNames);

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

function collectSenderEmails(rows: Array<{ from: unknown }>): Set<string> {
  const senderEmails = new Set<string>();
  for (const msg of rows) {
    const from = msg.from as { email?: string } | null;
    if (from?.email) senderEmails.add(from.email.toLowerCase());
  }
  return senderEmails;
}

function buildContactLookups(
  contactRows: Array<{
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  }>,
): { nameMap: Map<string, string>; avatarMap: Map<string, string> } {
  const nameMap = new Map<string, string>();
  const avatarMap = new Map<string, string>();
  for (const row of contactRows) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    const name = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim();
    if (name && !nameMap.has(key)) nameMap.set(key, name);
    if (row.avatarUrl && !avatarMap.has(key)) avatarMap.set(key, row.avatarUrl);
  }
  return { nameMap, avatarMap };
}

async function enrichSenderContacts(
  db: Database,
  rows: Array<{ from: unknown }>,
): Promise<void> {
  const senderEmails = collectSenderEmails(rows);
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

  const { nameMap, avatarMap } = buildContactLookups(contactRows);

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

export interface MessageStats {
  total: number;
  unread: number;
  inboxUnread: number;
  /** Starred messages, read or not (the Starred folder badge). */
  starred: number;
  importantUnread: number;
  sentUnread: number;
  archiveUnread: number;
  trashUnread: number;
  spam: number;
  snoozed: number;
  scheduled: number;
  drafts: number;
}

const EMPTY_STATS: MessageStats = {
  total: 0,
  unread: 0,
  inboxUnread: 0,
  starred: 0,
  importantUnread: 0,
  sentUnread: 0,
  archiveUnread: 0,
  trashUnread: 0,
  spam: 0,
  snoozed: 0,
  scheduled: 0,
  drafts: 0,
};

/**
 * Folder counters for the mail sidebar. Trash and spam are counted on their
 * own and never towards another folder, the same rule the folder listings
 * follow. Drafts live in `mail_drafts`, so they are counted there.
 */
export async function getMessageStats(db: Database, accountId?: string): Promise<MessageStats> {
  const conditions: SQL[] = [isNull(mailMessages.deletedAt)!];
  if (accountId) conditions.push(eq(mailMessages.accountId, accountId));
  const draftConditions: SQL[] = [isNull(mailDrafts.deletedAt)!];
  if (accountId) draftConditions.push(eq(mailDrafts.accountId, accountId));

  const labels = sql`COALESCE(${mailMessages.labels}, '[]'::jsonb)`;
  const has = (label: string) => sql`${labels} @> ${JSON.stringify([label])}::jsonb`;
  const live = sql`NOT (${has('TRASH')} OR ${has('SPAM')})`;
  const unread = sql`${mailMessages.isRead} = false`;
  const count = (condition: SQL) => sql<number>`count(*) filter (where ${condition})::int`;

  const [[row], [draftRow]] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        unread: count(unread),
        inboxUnread: count(sql`${has('INBOX')} AND ${unread}`),
        starred: count(sql`(${has('STARRED')} OR ${mailMessages.isStarred} = true) AND ${live}`),
        importantUnread: count(
          sql`(${has('IMPORTANT')} OR ${mailMessages.isImportant} = true) AND ${live} AND ${unread}`,
        ),
        sentUnread: count(sql`${has('SENT')} AND ${live} AND ${unread}`),
        archiveUnread: count(sql`${has('ARCHIVE')} AND ${unread}`),
        trashUnread: count(sql`${has('TRASH')} AND ${unread}`),
        spam: count(has('SPAM')),
        snoozed: count(sql`${has('SNOOZED')} AND ${live}`),
        scheduled: count(sql`${has('SCHEDULED')} AND ${mailMessages.sendStatus} = 'scheduled' AND ${live}`),
      })
      .from(mailMessages)
      .where(and(...conditions)),
    db
      .select({ drafts: sql<number>`count(*)::int` })
      .from(mailDrafts)
      .where(and(...draftConditions)),
  ]);
  return { ...EMPTY_STATS, ...row, drafts: draftRow?.drafts ?? 0 };
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
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) patch[k] = v;
  }

  // The folder listings, thread summaries and counters read the labels array,
  // so a flag never changes without its system label. Explicit `labels` in
  // the patch wins when the caller sets both.
  if (data.labels === undefined) {
    const synced = labelsForFlagPatch(existing.labels as string[] | null, data);
    if (synced) Object.assign(patch, synced);
  }

  await db
    .update(mailMessages)
    .set(patch as typeof mailMessages.$inferInsert)
    .where(eq(mailMessages.id, id));

  const [after] = await db.select().from(mailMessages).where(eq(mailMessages.id, id)).limit(1);
  return after!;
}

/** Leave a location (`TRASH` / `SPAM`): back to the inbox unless the mail already sits somewhere else. */
function leaveLocation(labels: string[], location: string): string[] {
  const next = removeLabels(labels, location);
  const elsewhere = [SYSTEM_LABELS.TRASH, SYSTEM_LABELS.SPAM, SYSTEM_LABELS.ARCHIVE].some((l) =>
    next.includes(l),
  );
  return elsewhere ? next : addLabels(next, SYSTEM_LABELS.INBOX);
}

/**
 * The labels array (and the flags a move implies) that a patch of the boolean
 * flags leads to. Null when the patch sets none of the mirrored flags.
 */
function labelsForFlagPatch(
  existing: string[] | null,
  data: UpdateMessageInput,
): { labels: string[]; isTrash?: boolean; isSpam?: boolean } | null {
  const mirrored = [data.isStarred, data.isImportant, data.isSpam, data.isTrash];
  if (mirrored.every((v) => v === undefined)) return null;

  let labels = [...(existing ?? [])];
  const toggle = (value: boolean | undefined, label: string) => {
    if (value === undefined) return;
    labels = value ? addLabels(labels, label) : removeLabels(labels, label);
  };
  toggle(data.isStarred, SYSTEM_LABELS.STARRED);
  toggle(data.isImportant, SYSTEM_LABELS.IMPORTANT);
  if (data.isSpam === true) labels = addLabels(labels, SYSTEM_LABELS.SPAM);
  else if (data.isSpam === false) labels = leaveLocation(labels, SYSTEM_LABELS.SPAM);
  if (data.isTrash === true) labels = addLabels(labels, SYSTEM_LABELS.TRASH);
  else if (data.isTrash === false) labels = leaveLocation(labels, SYSTEM_LABELS.TRASH);

  const moved = data.isSpam !== undefined || data.isTrash !== undefined;
  return moved
    ? {
        labels,
        isTrash: labels.includes(SYSTEM_LABELS.TRASH),
        isSpam: labels.includes(SYSTEM_LABELS.SPAM),
      }
    : { labels };
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
      await bulkAddLabelToMessages(db, SYSTEM_LABELS.STARRED, messageIds);
      break;
    case 'unstar':
      await bulkRemoveLabelFromMessages(db, SYSTEM_LABELS.STARRED, messageIds);
      break;
    case 'flag':
      await db.update(mailMessages).set({ isFlagged: true, updatedAt: now }).where(where);
      break;
    case 'unflag':
      await db.update(mailMessages).set({ isFlagged: false, updatedAt: now }).where(where);
      break;
    case 'trash':
      await moveMessagesToLocation(db, messageIds, SYSTEM_LABELS.TRASH);
      break;
    case 'restore':
      await moveMessagesToLocation(db, messageIds, SYSTEM_LABELS.INBOX);
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
    .set({ labels: next, ...flagsForLabelChange(labels, 'add'), updatedAt: new Date() })
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
    .set({ labels: next, ...flagsForLabelChange(labels, 'remove'), updatedAt: new Date() })
    .where(eq(mailMessages.id, id));
  return next;
}
