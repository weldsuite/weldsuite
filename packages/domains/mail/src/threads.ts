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
 *   4. Resolve sender names + avatars (own mailbox, contacts) with the same
 *      helper the reading pane uses (`enrichSenderContacts`).
 *
 * The api-worker version does the same thing in two places (per-account
 * and unified); we've collapsed both into `listThreadsByLabel`.
 */

import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  archivedCondition,
  inTrashOrSpamCondition,
  labelCondition,
  labelFolderHidesArchived,
  resolveCustomLabelNames,
  SYSTEM_LABELS,
  toSystemLabel,
} from './labels';
import {
  anyRecipientMatches,
  containsPattern,
  enrichSenderContacts,
  messageContainsAnyWord,
  messageSearchCondition,
  senderMatches,
} from './messages';
import { buildWakeDueSnoozedUpdate } from './snooze';
import { batchWriteThenReads } from './db-batch';
import {
  principalAccessCondition,
  principalHasAccess,
  principalIsAdmin,
  toPrincipal,
  type MailCaller,
} from './access';
import { buildThreadSummary, normalizeSubject } from './store/thread-summary';

export { normalizeSubject };

const { mailAccounts, mailMessages } = schema;

// Every `mail_messages` column except bodies, raw MIME and the two JSONB
// blobs no list view reads — `getTableColumns` + an omitting destructure so a
// column added to the schema later shows up here too, the same "all but
// these" rule the plan asks for (docs/plans/weldmail-mailbox-storage.md,
// phase 1 item 1).
const { textBody, htmlBody, rawMessage, headers, customFields, clickedLinks, ...threadListMessageColumns } =
  getTableColumns(mailMessages);

export interface ListThreadsByLabelInput {
  labelSlug: string;
  /** When set, restricts to one account. Otherwise unions every account the
   *  caller can read. */
  accountId?: string;
  page?: number;
  pageSize?: number;
  /**
   * Row offset; overrides `page` when set. The public API pages with an opaque
   * cursor that carries the offset, so a caller can change `limit` mid-walk.
   */
  offset?: number;
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
  /** Some message in the thread has an attachment (not only the latest one, not only one in this folder). */
  hasAttachment?: boolean;
  /**
   * "Doesn't have": leave out threads where any message contains any of these
   * space-separated words in its subject, body or sender.
   */
  excludeWords?: string;
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
  messages: ThreadListMessage[];
}

type MessageRow = typeof mailMessages.$inferSelect;

/**
 * A message as the thread list returns it: every column `MessageRow` has
 * except `textBody`, `htmlBody`, `rawMessage`, `headers`, `customFields` and
 * `clickedLinks` — bodies and raw MIME the list never shows, and two JSONB
 * blobs no list view reads. Opening a thread loads the full `MessageRow` on
 * its own (`getThreadByKey`, `GET /api/mail-messages/:id/thread`), which this
 * leaves untouched.
 */
export type ThreadListMessage = Omit<
  MessageRow,
  'textBody' | 'htmlBody' | 'rawMessage' | 'headers' | 'customFields' | 'clickedLinks'
>;

/** `mail_messages.accountId IN (...)`, or `= accountId` for a single id — same condition either way. */
function accountIdsScopeCondition(accountIds: string[]): SQL {
  return accountIds.length === 1
    ? eq(mailMessages.accountId, accountIds[0]!)
    : inArray(mailMessages.accountId, accountIds);
}

/**
 * The account-scope conditions for a thread listing: one verified account, or
 * the union of every account the caller can read. Null when nothing is readable.
 */
async function resolveAccountScope(
  db: Database,
  caller: MailCaller,
  accountId: string | undefined,
): Promise<SQL | null> {
  const principal = toPrincipal(caller);
  if (accountId) {
    // Single-account variant — verify access first.
    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
      .limit(1);
    if (!account) return null;
    // A shared account is open to every principal regardless of role —
    // `principalHasAccess` never consults admin status for one — so the
    // admin lookup (a `workspace_members` round trip) only runs when it could
    // actually change the answer.
    const allowed =
      account.isShared || principalHasAccess(account, principal, await principalIsAdmin(db, principal));
    if (!allowed) return null;
    return eq(mailMessages.accountId, accountId);
  }

  // Unified variant — every account the caller can read.
  const accessibleAccounts = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(isNull(mailAccounts.deletedAt), await principalAccessCondition(db, principal)));
  if (accessibleAccounts.length === 0) return null;
  return inArray(
    mailMessages.accountId,
    accessibleAccounts.map((a) => a.id),
  );
}

/** The ids array a `COALESCE(threadId, id) = ANY(...)` / account-id condition compares against. */
function textArraySql(values: string[]): SQL {
  const items = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  return sql`ARRAY[${items}]::text[]`;
}

/**
 * The lean messages of a page's threads — built, not executed, so it can run
 * in the same batch as other statements a caller already needs (see
 * `listThreadsWithScope`'s snooze-wake batch).
 *
 * This used to be preceded by a write that flipped a scheduled message whose
 * `scheduledFor` had passed to `sent`, so a page read right after the send
 * time "resolved" it without waiting for `SendScheduledEmailWorkflow`. That
 * was wrong, not just stale metadata: `SendScheduledEmailWorkflow.sleepUntil`
 * wakes at or after `scheduledFor`, and its outbound guard can additionally
 * defer a send for up to 24h when a sending limit is in effect
 * (`workflows/send-scheduled-email.ts`). Any read of the list in that window
 * — the normal case, not an edge case — marked the message `sent` before an
 * email had actually gone out. Worse, once marked, the workflow's own guard
 * (`getSkipReason`: `sendStatus !== 'scheduled'`) treated that as "already
 * handled" and skipped the real send for good, so the message silently never
 * went out at all while the UI showed it as sent. The workflow is the only
 * authority on whether a scheduled send happened; a read must never guess.
 */
function buildThreadMessagesQuery(h: Database, accountIds: string[], threadIds: string[]) {
  return h
    .select(threadListMessageColumns)
    .from(mailMessages)
    .where(
      and(
        inArray(mailMessages.accountId, accountIds),
        sql`COALESCE(${mailMessages.threadId}, ${mailMessages.id}) = ANY(${textArraySql(threadIds)})`,
        isNull(mailMessages.deletedAt),
      ),
    )
    .orderBy(asc(mailMessages.sentDate));
}

function groupMessagesByThread(messages: ThreadListMessage[]): Map<string, ThreadListMessage[]> {
  const threadMap = new Map<string, ThreadListMessage[]>();
  for (const msg of messages) {
    const key = `${msg.accountId}::${msg.threadId ?? msg.id}`;
    const bucket = threadMap.get(key) ?? [];
    bucket.push(msg);
    threadMap.set(key, bucket);
  }
  return threadMap;
}

// `summarizeThreadMessages`, `buildThreadSummary` and `normalizeSubject`
// moved to `./store/thread-summary` so the mailbox object's `refreshThread`
// can share the exact aggregation rules (design task A3); imported above,
// re-exported below for existing callers of `normalizeSubject`.

/** The advanced-search From / To / Subject filters, per message. */
function fieldFilterConditions(input: ThreadListFilter): SQL[] {
  const conditions: SQL[] = [];
  if (input.from?.trim()) conditions.push(senderMatches(input.from));
  if (input.to?.trim()) conditions.push(anyRecipientMatches(input.to));
  if (input.subject?.trim()) conditions.push(ilike(mailMessages.subject, containsPattern(input.subject)));
  return conditions;
}

/** What decides which threads a listing holds; everything but the paging. */
export type ThreadListFilter = Omit<ListThreadsByLabelInput, 'page' | 'pageSize' | 'offset'>;

export interface ThreadScope {
  accountScope: SQL;
  conditions: SQL[];
  buildWake: (h: Database) => ReturnType<typeof buildWakeDueSnoozedUpdate>;
}

/**
 * The conditions a message must meet to put its thread in the list, given an
 * already-resolved account scope. Shared by the caller-checked variant
 * (`threadListScope`) and the store's accounts-list variant
 * (`threadListScopeForAccounts`, design task B4: "access is split out of
 * `listThreadsByLabel`/`threadListScope`") — the store already knows which
 * accounts are in play (its own `ref`, or `WorkspaceMailStore`'s resolved
 * accessible-account list) and must not re-run a principal access check to
 * find out again.
 *
 * The snooze wake-up is returned as `buildWake` — built, not executed — so
 * each caller decides when to run it: `markFolderRead` awaits it on its own
 * (same as before), `listThreadsByLabel` folds it into its own
 * `db.batch([...])` with the count and page queries, one round trip for all
 * three instead of three.
 */
async function buildThreadScope(db: Database, accountScope: SQL, input: ThreadListFilter): Promise<ThreadScope> {
  const baseConditions: SQL[] = [isNull(mailMessages.deletedAt)!, accountScope];

  // Which messages put a thread in this list: the folder's label, or the
  // whole mailbox for a search. Trash and spam only ever show in their own
  // folder, so a trashed conversation leaves Sent and Starred as well. A user
  // label's folder leaves out archived mail: "Done" there clears it like it
  // does in the inbox, and the label stays on the message.
  const searchCondition = messageSearchCondition(input.search);
  const system = toSystemLabel(input.labelSlug);
  if (input.labelSlug !== 'all' && !searchCondition) {
    const customNames = await resolveCustomLabelNames(db, input.labelSlug, input.accountId);
    baseConditions.push(labelCondition(input.labelSlug, customNames));
    if (labelFolderHidesArchived(input.labelSlug)) {
      baseConditions.push(sql`NOT ${archivedCondition()}`);
    }
  }
  if (searchCondition || (system !== SYSTEM_LABELS.TRASH && system !== SYSTEM_LABELS.SPAM)) {
    baseConditions.push(sql`NOT ${inTrashOrSpamCondition()}`);
  }
  if (searchCondition) baseConditions.push(searchCondition);
  baseConditions.push(...fieldFilterConditions(input));

  const threadIdExpr = sql<string>`COALESCE(${mailMessages.threadId}, ${mailMessages.id})`;
  const threadKey = sql`(${mailMessages.accountId}, ${threadIdExpr})`;
  // Thread-level filters look at every message of the conversation, wherever
  // it sits: a thread has an attachment when any reply does, and a word rules
  // a thread out when any message carries it.
  const anyMessageOfThread = (condition: SQL) =>
    db
      .select({ accountId: mailMessages.accountId, threadKey: threadIdExpr })
      .from(mailMessages)
      .where(and(isNull(mailMessages.deletedAt), accountScope, condition));
  if (input.hasAttachment) {
    baseConditions.push(
      sql`${threadKey} IN ${anyMessageOfThread(
        sql`(${mailMessages.hasAttachments} = true OR COALESCE(${mailMessages.attachmentCount}, 0) > 0)`,
      )}`,
    );
  }
  const excludeCondition = messageContainsAnyWord(input.excludeWords);
  if (excludeCondition) {
    baseConditions.push(sql`${threadKey} NOT IN ${anyMessageOfThread(excludeCondition)}`);
  }

  return {
    accountScope,
    conditions: baseConditions,
    buildWake: (h: Database) => buildWakeDueSnoozedUpdate(h, { scope: accountScope }),
  };
}

/**
 * The accounts a thread listing covers and the conditions a message must meet
 * to put its thread in the list. Null when the caller can read none of the
 * accounts. Shared by the listing and "mark all as read", so the button acts
 * on exactly the threads the folder shows.
 */
export async function threadListScope(
  db: Database,
  caller: MailCaller,
  input: ThreadListFilter,
): Promise<ThreadScope | null> {
  const accountScope = await resolveAccountScope(db, caller, input.accountId);
  if (!accountScope) return null;
  return buildThreadScope(db, accountScope, input);
}

/**
 * The accounts-list twin of {@link threadListScope}: `accountIds` is already
 * the resolved set the caller may read (the store's own mailbox, or
 * `WorkspaceMailStore`'s accessible-account list), so this never queries
 * `mail_accounts` / `workspace_members` to find out again. Null for an empty
 * account list, same "nothing to show" rule as `accountScopeCondition`.
 */
export async function threadListScopeForAccounts(
  db: Database,
  accountIds: string[],
  input: ThreadListFilter,
): Promise<ThreadScope | null> {
  if (accountIds.length === 0) return null;
  return buildThreadScope(db, accountIdsScopeCondition(accountIds), input);
}

/** The distinct-thread count for a listing — built, not executed (see `buildThreadMessagesQuery`). */
function buildThreadCountQuery(h: Database, baseConditions: SQL[]) {
  return h
    .select({
      count: sql<number>`COUNT(DISTINCT (${mailMessages.accountId}, COALESCE(${mailMessages.threadId}, ${mailMessages.id})))::int`,
    })
    .from(mailMessages)
    .where(and(...baseConditions));
}

/**
 * One page of thread ids, newest first — built, not executed (see
 * `buildThreadMessagesQuery`). A thread sorts by its newest message of any
 * kind, so the reply you sent (SENT, not INBOX) lifts the conversation in the
 * inbox like it does in Gmail. That date comes from one grouped pass over the
 * scoped accounts, joined to the matching threads. A correlated subquery per
 * matching message would rescan the account each time: no index covers
 * COALESCE(thread_id, id).
 */
/** Resume after this position in the shared `(latestAt DESC, accountId ASC, threadKey ASC)` order (design §5). */
export interface ThreadKeysetCursor {
  latestAt: Date;
  accountId: string;
  threadKey: string;
}

type ThreadPaging = { offset: number } | { cursor: ThreadKeysetCursor };

function threadKeysetCondition(
  latestDate: SQL.Aliased<string>,
  accountId: SQL.Aliased<string>,
  threadId: SQL.Aliased<string>,
  cursor: ThreadKeysetCursor,
): SQL {
  return sql`(${latestDate} < ${cursor.latestAt} OR (${latestDate} = ${cursor.latestAt} AND (${accountId} > ${cursor.accountId} OR (${accountId} = ${cursor.accountId} AND ${threadId} > ${cursor.threadKey}))))`;
}

function buildThreadPageQuery(
  h: Database,
  baseConditions: SQL[],
  accountScope: SQL,
  threadIdExpr: SQL<string>,
  pageSize: number,
  paging: ThreadPaging,
) {
  const matchingThreads = h
    .select({
      accountId: sql<string>`${mailMessages.accountId}`.as('match_account_id'),
      threadId: sql<string>`${threadIdExpr}`.as('match_thread_key'),
    })
    .from(mailMessages)
    .where(and(...baseConditions))
    .groupBy(mailMessages.accountId, threadIdExpr)
    .as('matching_threads');
  const threadDates = h
    .select({
      accountId: sql<string>`${mailMessages.accountId}`.as('date_account_id'),
      threadId: sql<string>`${threadIdExpr}`.as('date_thread_key'),
      latestDate: sql<string>`MAX(COALESCE(${mailMessages.receivedDate}, ${mailMessages.sentDate}, ${mailMessages.createdAt}))`.as(
        'latest_date',
      ),
    })
    .from(mailMessages)
    .where(and(isNull(mailMessages.deletedAt), accountScope))
    .groupBy(mailMessages.accountId, threadIdExpr)
    .as('thread_dates');

  const joined = h
    .select({
      accountId: matchingThreads.accountId,
      threadId: matchingThreads.threadId,
      latestDate: threadDates.latestDate,
    })
    .from(matchingThreads)
    .innerJoin(
      threadDates,
      and(
        eq(threadDates.accountId, matchingThreads.accountId),
        eq(threadDates.threadId, matchingThreads.threadId),
      ),
    );

  const filtered =
    'cursor' in paging
      ? joined.where(
          threadKeysetCondition(threadDates.latestDate, matchingThreads.accountId, matchingThreads.threadId, paging.cursor),
        )
      : joined;

  const ordered = filtered
    .orderBy(desc(threadDates.latestDate), asc(matchingThreads.accountId), asc(matchingThreads.threadId))
    .limit(pageSize);

  return 'offset' in paging ? ordered.offset(paging.offset) : ordered;
}

type ThreadCountRow = { count: number };
type ThreadPageRow = { accountId: string; threadId: string; latestDate: string };

/** Pagination + the `withMessages`-independent shape every thread listing needs, once the scope is known. */
export interface ThreadListPagination {
  page?: number;
  pageSize?: number;
  offset?: number;
  cursor?: ThreadKeysetCursor | null;
}

/**
 * Page, summarise and enrich a thread listing once its `ThreadScope` is
 * known — the part `listThreadsByLabel` and `listThreadsForAccounts` share,
 * split out so the store's accounts-list variant never duplicates the
 * wake/expire/group/enrich pipeline (design task B4).
 */
async function listThreadsWithScope(
  db: Database,
  scope: ThreadScope,
  pagination: ThreadListPagination,
): Promise<{ threads: ThreadSummary[]; totalCount: number }> {
  const pageSize = Math.min(100, Math.max(1, pagination.pageSize ?? 25));
  const paging: ThreadPaging = pagination.cursor
    ? { cursor: pagination.cursor }
    : {
        offset:
          pagination.offset !== undefined
            ? Math.max(0, pagination.offset)
            : (Math.max(1, pagination.page ?? 1) - 1) * pageSize,
      };

  const { accountScope, conditions: baseConditions, buildWake } = scope;
  const threadIdExpr = sql<string>`COALESCE(${mailMessages.threadId}, ${mailMessages.id})`;

  // ---- wake snoozed mail, count distinct threads and page the thread ids,
  // in one round trip: the wake runs first, inside the same transaction as
  // the reads, so a mail that just came due is already back in the inbox for
  // the count and the page below. If the wake can't land (the workspace is
  // read-only during a database move, say) the listing still has to work, so
  // this retries with the two reads alone rather than failing the request.
  const [countRows, threadRows] = (await batchWriteThenReads(
    db,
    (h) => [
      buildWake(h),
      buildThreadCountQuery(h, baseConditions),
      buildThreadPageQuery(h, baseConditions, accountScope, threadIdExpr, pageSize, paging),
    ],
    (h) => [
      buildThreadCountQuery(h, baseConditions),
      buildThreadPageQuery(h, baseConditions, accountScope, threadIdExpr, pageSize, paging),
    ],
    'waking snoozed mail',
  )) as [ThreadCountRow[], ThreadPageRow[]];
  const totalCount = countRows[0]?.count ?? 0;

  if (threadRows.length === 0) return { threads: [], totalCount };

  // ---- pull the page's lean messages. No write here: whether a scheduled
  // message has actually sent is for `SendScheduledEmailWorkflow` alone to
  // say (see the note on `buildThreadMessagesQuery`) — a plain read. --------
  const threadIds = threadRows.map((r) => r.threadId).filter(Boolean);
  const accountIds = [...new Set(threadRows.map((r) => r.accountId))];
  const messages = await buildThreadMessagesQuery(db, accountIds, threadIds);

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

export async function listThreadsByLabel(
  db: Database,
  caller: MailCaller,
  input: ListThreadsByLabelInput,
): Promise<{ threads: ThreadSummary[]; totalCount: number }> {
  const scope = await threadListScope(db, caller, input);
  if (!scope) return { threads: [], totalCount: 0 };
  return listThreadsWithScope(db, scope, input);
}

/**
 * The accounts-list twin of {@link listThreadsByLabel}, for the Postgres
 * store (design task B4): `PostgresMailboxStore.listThreads` calls this with
 * `[ref.accountId]`, `PostgresWorkspaceMailStore.listThreads` with the
 * resolved accessible-account list — one query either way, no caller access
 * check. Supports the store's keyset `cursor` in addition to the legacy
 * `offset`/`page`.
 */
export async function listThreadsForAccounts(
  db: Database,
  accountIds: string[],
  input: ThreadListFilter & ThreadListPagination,
): Promise<{ threads: ThreadSummary[]; totalCount: number }> {
  const scope = await threadListScopeForAccounts(db, accountIds, input);
  if (!scope) return { threads: [], totalCount: 0 };
  return listThreadsWithScope(db, scope, input);
}

/**
 * One thread by its key: `COALESCE(threadId, id)`, the same key the listing
 * returns as `threadId`, within one account. Messages oldest first. Null when
 * the account has no live message under that key. The caller checks access to
 * `accountId` first.
 */
export async function getThreadByKey(
  db: Database,
  accountId: string,
  threadKey: string,
): Promise<{ threadId: string; accountId: string; messages: MessageRow[] } | null> {
  const messages = await db
    .select()
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        sql`COALESCE(${mailMessages.threadId}, ${mailMessages.id}) = ${threadKey}`,
        isNull(mailMessages.deletedAt),
      ),
    )
    .orderBy(asc(mailMessages.sentDate), asc(mailMessages.id));
  if (messages.length === 0) return null;
  return { threadId: threadKey, accountId, messages };
}

/**
 * Resolve sender names + avatars on every message through the shared helper
 * (own mailbox name, else contact name, else From name), then take the
 * thread's latest sender from the latest message, so the list row and the
 * reading pane show the same name.
 */
async function enrichThreadContacts(db: Database, summaries: ThreadSummary[]): Promise<void> {
  await enrichSenderContacts(
    db,
    summaries.flatMap((t) => t.messages),
  );
  for (const t of summaries) {
    const latest = t.messages.find((m) => m.id === t.latestMessageId);
    const from = latest?.from as { name?: string; email?: string; avatarUrl?: string | null } | null;
    if (!from) continue;
    t.latestSender = from.name || from.email || 'Unknown';
    t.latestSenderAvatarUrl = from.avatarUrl ?? null;
  }
}
