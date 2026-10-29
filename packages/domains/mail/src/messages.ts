/**
 * Mail message service — read/patch operations.
 *
 * Send paths live in `./send.ts` so the same code drives both compose and
 * reply. This file is everything that doesn't talk to Cloudflare's
 * `send_email` binding.
 */

import { and, asc, desc, eq, getTableColumns, inArray, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  addLabels,
  bulkAddLabelToMessages,
  canonicalLabelNames,
  bulkRemoveLabelFromMessages,
  flagsForLabelChange,
  inTrashOrSpamCondition,
  labelCondition,
  moveMessagesToLocation,
  removeLabels,
  resolveCustomLabelNames,
  SYSTEM_LABELS,
} from './labels';
import { labelsForFlagPatch } from './store/model';
import { batchQueries } from './db-batch';

const { mailAccounts, mailMessages, mailAttachments, mailDrafts, people: contacts } = schema;

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
  /** The sender's name or address contains this text. */
  from?: string;
  /** Leave out trashed messages (the platform lists show them in their own folder). */
  excludeTrash?: boolean;
  /** Leave out spam. */
  excludeSpam?: boolean;
  /**
   * Exact address match across from/to/cc/bcc — the CRM Emails tab and the
   * store's `MessageListQuery.counterparty` (design §5, §2). Unlike `from`
   * this is case-insensitive equality, not a `LIKE` substring, and it checks
   * every participant role, not only the sender.
   */
  counterparty?: string;
  /**
   * A pre-resolved keyset position `(sentDate, id)` — the store's
   * `MessageCursor`, already decoded by the caller. Skips the `cursor`
   * id-lookup below entirely; set this instead of `cursor` when the caller
   * already has both values (design task B4).
   */
  cursorValue?: { sentDate: Date; id: string };
}

/** The message carries this system label. */
function hasSystemLabel(label: string): SQL {
  return sql`COALESCE(${mailMessages.labels}, '[]'::jsonb) @> ${JSON.stringify([label])}::jsonb`;
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

/** One of the addresses in a recipient column matches exactly (case-insensitive), not a substring. */
function recipientEquals(column: SQL, address: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END) AS recipient
    WHERE lower(recipient->>'email') = ${address}
  )`;
}

/**
 * The message's sender or any To/Cc/Bcc recipient is exactly this address
 * (case-insensitive) — the CRM Emails tab's `counterparty` filter (design §5:
 * "exact address match"), as opposed to `senderMatches`/`anyRecipientMatches`,
 * which are substring filters over From/To/Cc only.
 */
export function counterpartyCondition(address: string): SQL {
  const normalized = address.trim().toLowerCase();
  return sql`(
    lower(${mailMessages.from}->>'email') = ${normalized}
    OR ${recipientEquals(sql`${mailMessages.to}`, normalized)}
    OR ${recipientEquals(sql`${mailMessages.cc}`, normalized)}
    OR ${recipientEquals(sql`${mailMessages.bcc}`, normalized)}
  )`;
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

/**
 * The mirror of `messageSearchCondition` for a "doesn't have" filter: the
 * message contains ANY of the space-separated words in its subject, body or
 * sender. Case-insensitive. Returns undefined for an empty list. A caller that
 * lists threads negates it for the whole conversation, not one message.
 */
export function messageContainsAnyWord(words: string | undefined): SQL | undefined {
  const terms = (words ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 10);
  if (terms.length === 0) return undefined;
  return or(
    ...terms.map((term) => {
      const pattern = containsPattern(term);
      return or(
        ilike(mailMessages.subject, pattern),
        ilike(mailMessages.preview, pattern),
        ilike(mailMessages.textBody, pattern),
        senderMatches(term),
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
  if (filters.from?.trim()) conditions.push(senderMatches(filters.from));
  if (filters.counterparty?.trim()) conditions.push(counterpartyCondition(filters.counterparty));
  if (filters.excludeTrash) conditions.push(sql`NOT ${hasSystemLabel(SYSTEM_LABELS.TRASH)}`);
  if (filters.excludeSpam) conditions.push(sql`NOT ${hasSystemLabel(SYSTEM_LABELS.SPAM)}`);

  return conditions;
}

export async function listMessages(db: Database, filters: MessageFilters) {
  const limit = Math.min(filters.limit ?? 50, 100);
  const labelNames = filters.label
    ? await resolveCustomLabelNames(db, filters.label, filters.accountId)
    : [];
  const conditions = buildMessageConditions(filters, labelNames);

  let hasCursorCondition = false;
  if (filters.cursorValue) {
    // Already-decoded keyset position (the store's `MessageCursor`) — no
    // id-lookup round trip needed, unlike the legacy `cursor` string below.
    conditions.push(
      sql`(${mailMessages.sentDate} < ${filters.cursorValue.sentDate} OR (${mailMessages.sentDate} = ${filters.cursorValue.sentDate} AND ${mailMessages.id} < ${filters.cursorValue.id}))`,
    );
    hasCursorCondition = true;
  } else if (filters.cursor) {
    const [cur] = await db
      .select({ sentDate: mailMessages.sentDate, id: mailMessages.id })
      .from(mailMessages)
      .where(eq(mailMessages.id, filters.cursor))
      .limit(1);
    if (cur?.sentDate) {
      conditions.push(
        sql`(${mailMessages.sentDate} < ${cur.sentDate} OR (${mailMessages.sentDate} = ${cur.sentDate} AND ${mailMessages.id} < ${cur.id}))`,
      );
      hasCursorCondition = true;
    }
  }

  const where = and(...conditions);
  const filterConditions = hasCursorCondition ? conditions.slice(0, -1) : conditions;
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

// Every `mail_messages` column except bodies, raw MIME and the two JSONB
// blobs no list view reads — the same set `threads.ts`'s `ThreadListMessage`
// picks (the design's lean list row, `store/types.ts` `MailMessageListRow`).
// Redefined here rather than imported from `./threads`, which already
// imports from this file, to avoid a module cycle.
const {
  textBody: _wideTextBody,
  htmlBody: _wideHtmlBody,
  rawMessage: _wideRawMessage,
  headers: _wideHeaders,
  customFields: _wideCustomFields,
  clickedLinks: _wideClickedLinks,
  ...wideListColumns
} = getTableColumns(mailMessages);

/**
 * `listMessages`'s filter/pagination semantics, but the full lean-row column
 * set (`MailMessageListRow`) instead of the ~20-column projection the live
 * `GET /api/mail-messages` route serializes today. Used by the store (design
 * task B4: `PostgresMailboxStore.listMessages`), which must return the
 * contract's full `MailMessageListRow` shape; `listMessages` itself is left
 * untouched so today's route keeps its exact response shape.
 */
export async function listMessagesWide(db: Database, filters: MessageFilters) {
  const limit = Math.min(filters.limit ?? 50, 100);
  const labelNames = filters.label
    ? await resolveCustomLabelNames(db, filters.label, filters.accountId)
    : [];
  const conditions = buildMessageConditions(filters, labelNames);

  let hasCursorCondition = false;
  if (filters.cursorValue) {
    conditions.push(
      sql`(${mailMessages.sentDate} < ${filters.cursorValue.sentDate} OR (${mailMessages.sentDate} = ${filters.cursorValue.sentDate} AND ${mailMessages.id} < ${filters.cursorValue.id}))`,
    );
    hasCursorCondition = true;
  } else if (filters.cursor) {
    const [cur] = await db
      .select({ sentDate: mailMessages.sentDate, id: mailMessages.id })
      .from(mailMessages)
      .where(eq(mailMessages.id, filters.cursor))
      .limit(1);
    if (cur?.sentDate) {
      conditions.push(
        sql`(${mailMessages.sentDate} < ${cur.sentDate} OR (${mailMessages.sentDate} = ${cur.sentDate} AND ${mailMessages.id} < ${cur.id}))`,
      );
      hasCursorCondition = true;
    }
  }

  const where = and(...conditions);
  const filterConditions = hasCursorCondition ? conditions.slice(0, -1) : conditions;
  const countWhere = and(...filterConditions);

  const [rows, countRes] = await Promise.all([
    db
      .select(wideListColumns)
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

  await enrichSenderContacts(db, data);

  return { data, hasMore, cursor, totalCount };
}

/** Live lean rows for a set of ids within one account — the store's `getMessages` (locate, bulk checks). */
export async function getLiveMessagesByIds(db: Database, accountId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select(wideListColumns)
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), inArray(mailMessages.id, ids), isNull(mailMessages.deletedAt)));
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

/** `accountId::email` to display name, for senders that are the mailbox itself. */
function ownMailboxNameMap(
  accounts: Array<{ id: string; email: string; displayName: string | null }>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const a of accounts) {
    const name = a.displayName?.trim();
    if (a.email && name) names.set(`${a.id}::${a.email.toLowerCase()}`, name);
  }
  return names;
}

type OwnMailboxAccountRow = { id: string; email: string; displayName: string | null };
type SenderContactRow = { email: string | null; firstName: string | null; lastName: string | null; avatarUrl: string | null };

/**
 * Resolve every sender's display name and avatar in place, the one rule the
 * list rows, the thread summaries and the reading pane all share: the mailbox's
 * own display name for mail from the mailbox itself, else the matching
 * contact's name, else the From header's name (the address when it has none).
 * A row without an `accountId` skips the own-mailbox rule.
 */
export async function enrichSenderContacts(
  db: Database,
  rows: Array<{ from: unknown; accountId?: string | null }>,
): Promise<void> {
  const senderEmails = collectSenderEmails(rows);
  if (senderEmails.size === 0) return;
  const accountIds = [...new Set(rows.map((r) => r.accountId).filter((id): id is string => !!id))];

  const contactsQuery = (h: Database) =>
    h
      .select({
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        avatarUrl: contacts.avatarUrl,
      })
      .from(contacts)
      .where(and(inArray(contacts.email, [...senderEmails]), isNull(contacts.deletedAt)));

  let ownNames: Map<string, string>;
  let contactRows: SenderContactRow[];
  if (accountIds.length === 0) {
    // Nothing to look an own-mailbox name up for — one round trip, not two.
    ownNames = new Map();
    contactRows = await contactsQuery(db);
  } else {
    const accountsQuery = (h: Database) =>
      h
        .select({ id: mailAccounts.id, email: mailAccounts.email, displayName: mailAccounts.displayName })
        .from(mailAccounts)
        .where(inArray(mailAccounts.id, accountIds));
    // Independent reads (neither depends on the other's result) — one round
    // trip for both instead of two.
    const [accounts, rows2] = (await batchQueries(db, (h) => [accountsQuery(h), contactsQuery(h)])) as [
      OwnMailboxAccountRow[],
      SenderContactRow[],
    ];
    ownNames = ownMailboxNameMap(accounts);
    contactRows = rows2;
  }

  const { nameMap, avatarMap } = buildContactLookups(contactRows);

  for (const msg of rows) {
    const from = msg.from as { email?: string; name?: string } | null;
    if (from?.email) {
      const key = from.email.toLowerCase();
      const ownName = msg.accountId ? ownNames.get(`${msg.accountId}::${key}`) : undefined;
      const contactName = ownName ?? nameMap.get(key);
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
  // Same sender names as the list shows for this message.
  await enrichSenderContacts(db, [row]);

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
    await enrichSenderContacts(db, single);
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
  await enrichSenderContacts(db, rows);
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
 * follow (`inTrashOrSpamCondition`: the TRASH / SPAM label or the isTrash /
 * isSpam flag, so a legacy row labelled ["INBOX","TRASH"] does not inflate the
 * inbox badge). Drafts live in `mail_drafts`, so they are counted there.
 *
 * Always scoped: one account, or the list of accounts the caller may open
 * (the unified sidebar). There is no "every mailbox" form, and an empty list
 * counts nothing.
 */
export async function getMessageStats(
  db: Database,
  accountIds: string | string[],
): Promise<MessageStats> {
  const ids = typeof accountIds === 'string' ? [accountIds] : accountIds;
  if (ids.length === 0) return { ...EMPTY_STATS };
  const conditions: SQL[] = [isNull(mailMessages.deletedAt)!, inArray(mailMessages.accountId, ids)];

  const labels = sql`COALESCE(${mailMessages.labels}, '[]'::jsonb)`;
  const has = (label: string) => sql`${labels} @> ${JSON.stringify([label])}::jsonb`;
  const live = sql`NOT ${inTrashOrSpamCondition()}`;
  const unread = sql`${mailMessages.isRead} = false`;
  const count = (condition: SQL) => sql<number>`count(*) filter (where ${condition})::int`;
  // Drafts live in a different table; folded into the same statement as a
  // scalar subquery rather than a second round trip.
  const idsArrayItems = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const idsArray = sql`ARRAY[${idsArrayItems}]::text[]`;
  const drafts = sql<number>`(SELECT count(*)::int FROM ${mailDrafts} WHERE ${mailDrafts.deletedAt} IS NULL AND ${mailDrafts.accountId} = ANY(${idsArray}))`;

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: count(unread),
      inboxUnread: count(sql`${has('INBOX')} AND ${live} AND ${unread}`),
      starred: count(sql`(${has('STARRED')} OR ${mailMessages.isStarred} = true) AND ${live}`),
      importantUnread: count(
        sql`(${has('IMPORTANT')} OR ${mailMessages.isImportant} = true) AND ${live} AND ${unread}`,
      ),
      sentUnread: count(sql`${has('SENT')} AND ${live} AND ${unread}`),
      archiveUnread: count(sql`${has('ARCHIVE')} AND ${live} AND ${unread}`),
      trashUnread: count(sql`${has('TRASH')} AND ${unread}`),
      spam: count(has('SPAM')),
      snoozed: count(sql`${has('SNOOZED')} AND ${live}`),
      scheduled: count(sql`${has('SCHEDULED')} AND ${mailMessages.sendStatus} = 'scheduled' AND ${live}`),
      drafts,
    })
    .from(mailMessages)
    .where(and(...conditions));
  return { ...EMPTY_STATS, ...row };
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
  now: Date = new Date(),
): Promise<typeof mailMessages.$inferSelect | null> {
  const [existing] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const patch: Record<string, unknown> = { updatedAt: now };
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

// `leaveLocation` and the labels-from-a-flag-patch logic moved to
// `./store/model` (`labelsForFlagPatch`) so the mailbox object can share them
// (design task A3); imported above, re-used here unchanged.

/**
 * Soft-delete a message. Returns the identifying fields the route needs
 * for the entity event payload, or `null` when no live message had that id.
 */
export async function softDeleteMessage(
  db: Database,
  id: string,
  now: Date = new Date(),
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
    .set({ deletedAt: now, updatedAt: now })
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
  now: Date = new Date(),
): Promise<{ affected: number }> {
  const where = and(inArray(mailMessages.id, messageIds), isNull(mailMessages.deletedAt));

  switch (action) {
    case 'markRead':
      await db.update(mailMessages).set({ isRead: true, updatedAt: now }).where(where);
      break;
    case 'markUnread':
      await db.update(mailMessages).set({ isRead: false, updatedAt: now }).where(where);
      break;
    case 'star':
      await bulkAddLabelToMessages(db, SYSTEM_LABELS.STARRED, messageIds, now);
      break;
    case 'unstar':
      await bulkRemoveLabelFromMessages(db, SYSTEM_LABELS.STARRED, messageIds, now);
      break;
    case 'flag':
      await db.update(mailMessages).set({ isFlagged: true, updatedAt: now }).where(where);
      break;
    case 'unflag':
      await db.update(mailMessages).set({ isFlagged: false, updatedAt: now }).where(where);
      break;
    case 'trash':
      await moveMessagesToLocation(db, messageIds, SYSTEM_LABELS.TRASH, now);
      break;
    case 'restore':
      await moveMessagesToLocation(db, messageIds, SYSTEM_LABELS.INBOX, now);
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
  rawLabels: string[],
  now: Date = new Date(),
): Promise<string[] | null> {
  const [existing] = await db
    .select({ labels: mailMessages.labels, accountId: mailMessages.accountId })
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const labels = await canonicalLabelNames(db, existing.accountId, rawLabels);
  const next = addLabels(existing.labels as string[] | null, ...labels);
  await db
    .update(mailMessages)
    .set({ labels: next, ...flagsForLabelChange(labels, 'add'), updatedAt: now })
    .where(eq(mailMessages.id, id));
  return next;
}

export async function removeMessageLabels(
  db: Database,
  id: string,
  rawLabels: string[],
  now: Date = new Date(),
): Promise<string[] | null> {
  const [existing] = await db
    .select({ labels: mailMessages.labels, accountId: mailMessages.accountId })
    .from(mailMessages)
    .where(and(eq(mailMessages.id, id), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!existing) return null;
  const labels = await canonicalLabelNames(db, existing.accountId, rawLabels);
  const next = removeLabels(existing.labels as string[] | null, ...labels);
  await db
    .update(mailMessages)
    .set({ labels: next, ...flagsForLabelChange(labels, 'remove'), updatedAt: now })
    .where(eq(mailMessages.id, id));
  return next;
}
