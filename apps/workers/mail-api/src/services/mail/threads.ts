/**
 * Thread aggregation for mail.
 *
 * Builds a paginated list of "thread summaries" — one entry per unique
 * `(accountId, COALESCE(threadId, id))` — filtered by label, optionally
 * scoped to a single account or to the union of accounts the caller can
 * read. Used by the per-account label view and the unified inbox.
 *
 * The query plan is:
 *   1. Window over `mail_messages` to pull the paginated page of thread
 *      IDs + their latest dates (DISTINCT + ORDER BY + LIMIT/OFFSET).
 *   2. Pull the full message bodies for those threads in a second query.
 *   3. Group + summarise in memory (participants, label union, latest
 *      sender, attachment flag, unread count).
 *   4. Resolve contact names + avatars via a single `people` join.
 *
 * The api-worker version does the same thing in two places (per-account
 * and unified); we've collapsed both into `listThreadsByLabel`.
 */

import { and, asc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  inTrashOrSpamCondition,
  labelCondition,
  resolveCustomLabelNames,
  SYSTEM_LABELS,
  toSystemLabel,
} from './labels';
import { anyRecipientMatches, containsPattern, messageSearchCondition, senderMatches } from './messages';
import { wakeDueSnoozedMessages } from './snooze';
import { hasAccessToAccount, isAdminOrOwner, userAccessCondition } from '@weldsuite/mail-domain/access';

const { mailAccounts, mailMessages, people: contacts } = schema;

export interface ListThreadsByLabelInput {
  labelSlug: string;
  /** When set, restricts to one account. Otherwise unions every account the
   *  caller can read. */
  accountId?: string;
  page?: number;
  pageSize?: number;
  /**
   * Free-text search over subject, body and participants. A search looks
   * through the whole mailbox (everything but trash and spam) rather than the
   * folder in `labelSlug`: the mail someone is looking for is usually not in
   * the folder they happen to have open.
   */
  search?: string;
  /** Sender name or address contains this text. */
  from?: string;
  /** A To / Cc recipient's name or address contains this text. */
  to?: string;
  /** Subject contains this text. */
  subject?: string;
  hasAttachment?: boolean;
}

export interface ThreadSummary {
  threadId: string;
  accountId: string;
  subject: string;
  participants: string[];
  latestMessageId: string;
  latestSender: string;
  latestSenderEmail: string;
  latestSenderAvatarUrl: string | null;
  latestDate: Date | null;
  preview: string;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
  labels: string[];
  scheduledFor: Date | null;
  sendStatus: string | null;
  messages: typeof mailMessages.$inferSelect[];
}

type MessageRow = typeof mailMessages.$inferSelect;

/**
 * The account-scope conditions for a thread listing: one verified account, or
 * the union of every account the caller can read. Null when nothing is readable.
 */
async function resolveAccountScope(
  db: Database,
  userId: string,
  accountId: string | undefined,
): Promise<SQL | null> {
  if (accountId) {
    // Single-account variant — verify access first.
    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
      .limit(1);
    if (!account) return null;
    const admin = await isAdminOrOwner(db, userId);
    if (!hasAccessToAccount(account, userId, admin)) return null;
    return eq(mailMessages.accountId, accountId);
  }

  // Unified variant — every account the caller can read.
  const admin = await isAdminOrOwner(db, userId);
  const accountConditions: SQL[] = [isNull(mailAccounts.deletedAt)!];
  if (!admin) accountConditions.push(userAccessCondition(userId));
  const accessibleAccounts = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(...accountConditions));
  if (accessibleAccounts.length === 0) return null;
  return inArray(
    mailMessages.accountId,
    accessibleAccounts.map((a) => a.id),
  );
}

/** Flip scheduled messages whose send time has passed to `sent`, in the DB and in the given rows. */
async function resolveExpiredScheduled(db: Database, messages: MessageRow[]): Promise<void> {
  const now = new Date();
  const expired = messages.filter(
    (m) => m.sendStatus === 'scheduled' && m.scheduledFor && new Date(m.scheduledFor) <= now,
  );
  if (expired.length === 0) return;

  await db
    .update(mailMessages)
    .set({ sendStatus: 'sent', sentDate: now, scheduledFor: null, updatedAt: now })
    .where(
      inArray(
        mailMessages.id,
        expired.map((m) => m.id),
      ),
    );
  for (const msg of expired) {
    msg.sendStatus = 'sent';
    msg.scheduledFor = null;
    msg.sentDate = now;
  }
}

function groupMessagesByThread(messages: MessageRow[]): Map<string, MessageRow[]> {
  const threadMap = new Map<string, MessageRow[]>();
  for (const msg of messages) {
    const key = `${msg.accountId}::${msg.threadId ?? msg.id}`;
    const bucket = threadMap.get(key) ?? [];
    bucket.push(msg);
    threadMap.set(key, bucket);
  }
  return threadMap;
}

function summarizeThreadMessages(threadMessages: MessageRow[]): {
  participants: string[];
  labels: string[];
  hasAttachments: boolean;
  isStarred: boolean;
  unreadCount: number;
} {
  const participants = new Set<string>();
  const labels = new Set<string>();
  let hasAttachments = false;
  let isStarred = false;
  let unreadCount = 0;
  for (const msg of threadMessages) {
    const from = msg.from as { name?: string; email?: string } | null;
    const sender = from?.name || from?.email;
    if (sender) participants.add(sender);
    if (Array.isArray(msg.labels)) {
      for (const l of msg.labels as string[]) labels.add(l);
    }
    if (msg.hasAttachments) hasAttachments = true;
    if (msg.isStarred) isStarred = true;
    if (!msg.isRead) unreadCount += 1;
  }
  if (labels.has('STARRED')) isStarred = true;
  return { participants: [...participants], labels: [...labels], hasAttachments, isStarred, unreadCount };
}

function buildThreadSummary(
  row: { accountId: string; threadId: string },
  threadMessages: MessageRow[],
): ThreadSummary {
  threadMessages.sort(
    (a, b) =>
      dateOf(a.receivedDate, a.sentDate, a.createdAt) -
      dateOf(b.receivedDate, b.sentDate, b.createdAt),
  );

  const first = threadMessages[0]!;
  const latest = threadMessages[threadMessages.length - 1]!;
  const { participants, labels, hasAttachments, isStarred, unreadCount } =
    summarizeThreadMessages(threadMessages);

  const latestFrom = latest.from as { name?: string; email?: string } | null;
  const latestSender = latestFrom?.name || latestFrom?.email || 'Unknown';
  const latestSenderEmail = latestFrom?.email ?? '';

  return {
    threadId: row.threadId,
    accountId: row.accountId,
    subject: normalizeSubject(first.subject),
    participants,
    latestMessageId: latest.id,
    latestSender,
    latestSenderEmail,
    latestSenderAvatarUrl: null,
    latestDate: latest.receivedDate ?? latest.sentDate ?? latest.createdAt ?? null,
    preview: latest.preview ?? '',
    messageCount: threadMessages.length,
    unreadCount,
    hasAttachments,
    isStarred,
    labels,
    scheduledFor: latest.scheduledFor ?? null,
    sendStatus: latest.sendStatus ?? null,
    messages: threadMessages,
  };
}

export async function listThreadsByLabel(
  db: Database,
  userId: string,
  input: ListThreadsByLabelInput,
): Promise<{ threads: ThreadSummary[]; totalCount: number }> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const baseConditions: SQL[] = [isNull(mailMessages.deletedAt)!];

  const accountScope = await resolveAccountScope(db, userId, input.accountId);
  if (!accountScope) return { threads: [], totalCount: 0 };
  baseConditions.push(accountScope);

  // Snoozed mail that came due since the last sweep is back in the inbox
  // before the list is read. Never worth failing the listing over.
  await wakeDueSnoozedMessages(db, { scope: accountScope }).catch((err) => {
    console.error('[mail-threads] waking snoozed mail failed:', err);
  });

  // Which messages put a thread in this list: the folder's label, or the
  // whole mailbox for a search. Trash and spam only ever show in their own
  // folder, so a trashed conversation leaves Sent and Starred as well.
  const searchCondition = messageSearchCondition(input.search);
  const system = toSystemLabel(input.labelSlug);
  if (input.labelSlug !== 'all' && !searchCondition) {
    const customNames = await resolveCustomLabelNames(db, input.labelSlug, input.accountId);
    baseConditions.push(labelCondition(input.labelSlug, customNames));
  }
  if (searchCondition || (system !== SYSTEM_LABELS.TRASH && system !== SYSTEM_LABELS.SPAM)) {
    baseConditions.push(sql`NOT ${inTrashOrSpamCondition()}`);
  }
  if (searchCondition) baseConditions.push(searchCondition);
  if (input.from?.trim()) baseConditions.push(senderMatches(input.from));
  if (input.to?.trim()) baseConditions.push(anyRecipientMatches(input.to));
  if (input.subject?.trim()) {
    baseConditions.push(ilike(mailMessages.subject, containsPattern(input.subject)));
  }
  if (input.hasAttachment) baseConditions.push(eq(mailMessages.hasAttachments, true));

  const threadIdExpr = sql<string>`COALESCE(${mailMessages.threadId}, ${mailMessages.id})`;
  const latestDateExpr = sql<string>`MAX(COALESCE(${mailMessages.receivedDate}, ${mailMessages.sentDate}, ${mailMessages.createdAt}))`;

  // ---- count distinct threads -----------------------------------------
  const [countRow] = await db
    .select({
      count: sql<number>`COUNT(DISTINCT (${mailMessages.accountId}, COALESCE(${mailMessages.threadId}, ${mailMessages.id})))::int`,
    })
    .from(mailMessages)
    .where(and(...baseConditions));
  const totalCount = countRow?.count ?? 0;

  // ---- paginate the thread IDs ----------------------------------------
  const threadRows = await db
    .select({
      accountId: mailMessages.accountId,
      threadId: threadIdExpr,
      latestDate: latestDateExpr,
    })
    .from(mailMessages)
    .where(and(...baseConditions))
    .groupBy(mailMessages.accountId, threadIdExpr)
    .orderBy(sql`${latestDateExpr} DESC`)
    .limit(pageSize)
    .offset(offset);

  if (threadRows.length === 0) return { threads: [], totalCount };

  // ---- pull full messages for those threads ---------------------------
  const threadIds = threadRows.map((r) => r.threadId).filter(Boolean);
  const accountIds = [...new Set(threadRows.map((r) => r.accountId))];
  const messages = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        inArray(mailMessages.accountId, accountIds),
        sql`COALESCE(${mailMessages.threadId}, ${mailMessages.id}) = ANY(ARRAY[${sql.join(
          threadIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[])`,
        isNull(mailMessages.deletedAt),
      ),
    )
    .orderBy(asc(mailMessages.sentDate));

  // ---- auto-resolve expired scheduled messages ------------------------
  await resolveExpiredScheduled(db, messages);

  // ---- group + summarise ----------------------------------------------
  const threadMap = groupMessagesByThread(messages);

  const summaries: ThreadSummary[] = [];
  for (const r of threadRows) {
    const threadMessages = threadMap.get(`${r.accountId}::${r.threadId}`);
    if (!threadMessages || threadMessages.length === 0) continue;
    summaries.push(buildThreadSummary(r, threadMessages));
  }

  // ---- enrich with contact names + avatars ----------------------------
  await enrichThreadContacts(db, summaries);

  return { threads: summaries, totalCount };
}

function dateOf(...candidates: (Date | null | undefined)[]): number {
  for (const c of candidates) {
    if (c instanceof Date) return c.getTime();
    if (typeof c === 'string') return new Date(c).getTime();
  }
  return 0;
}

function normalizeSubject(subject: string | null): string {
  if (!subject) return '(No subject)';
  return subject.replace(/^(Re:|Fwd:|Fw:)\s*/i, '');
}

function collectThreadSenderEmails(summaries: ThreadSummary[]): Set<string> {
  const emails = new Set<string>();
  for (const t of summaries) {
    if (t.latestSenderEmail) emails.add(t.latestSenderEmail.toLowerCase());
    for (const msg of t.messages) {
      const from = msg.from as { email?: string } | null;
      if (from?.email) emails.add(from.email.toLowerCase());
    }
  }
  return emails;
}

function buildContactLookups(
  contactRows: Array<{
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  }>,
): { nameByEmail: Map<string, string>; avatarByEmail: Map<string, string> } {
  const nameByEmail = new Map<string, string>();
  const avatarByEmail = new Map<string, string>();
  for (const row of contactRows) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    const fullName = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim();
    if (fullName && !nameByEmail.has(key)) nameByEmail.set(key, fullName);
    if (row.avatarUrl && !avatarByEmail.has(key)) avatarByEmail.set(key, row.avatarUrl);
  }
  return { nameByEmail, avatarByEmail };
}

/** Rewrite each message's `from` with the resolved contact name + avatar, where one is known. */
function applyContactsToMessages(
  messages: MessageRow[],
  nameByEmail: Map<string, string>,
  avatarByEmail: Map<string, string>,
): void {
  for (const msg of messages) {
    const from = msg.from as { name?: string; email?: string } | null;
    if (!from?.email) continue;
    const key = from.email.toLowerCase();
    const contactName = nameByEmail.get(key);
    const avatarUrl = avatarByEmail.get(key);
    if (contactName || avatarUrl) {
      (msg as { from: unknown }).from = {
        ...from,
        name: contactName ?? from.name,
        avatarUrl: avatarUrl ?? null,
      };
    }
  }
}

async function enrichThreadContacts(db: Database, summaries: ThreadSummary[]): Promise<void> {
  const emails = collectThreadSenderEmails(summaries);
  if (emails.size === 0) return;

  const contactRows = await db
    .select({
      email: contacts.email,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      avatarUrl: contacts.avatarUrl,
    })
    .from(contacts)
    .where(and(inArray(contacts.email, [...emails]), isNull(contacts.deletedAt)));

  const { nameByEmail, avatarByEmail } = buildContactLookups(contactRows);

  for (const t of summaries) {
    if (t.latestSenderEmail) {
      const key = t.latestSenderEmail.toLowerCase();
      const contactName = nameByEmail.get(key);
      if (contactName) t.latestSender = contactName;
      t.latestSenderAvatarUrl = avatarByEmail.get(key) ?? null;
    }
    applyContactsToMessages(t.messages, nameByEmail, avatarByEmail);
  }
}
