/**
 * `MailboxObject`'s read core (design §3.3, §3.5, task B3). Pure functions
 * over a `SqlStorage` implementing every read method of `MailboxStore`
 * (`../store/types`) — the future RPC class (task C1) is a thin wrapper that
 * calls these with `this.ctx.storage.sql` and its own `ref`.
 *
 * No writes, no `transactionSync`: every function here is a plain read, so
 * none of this needs the `WritableStorage` wrapper `./writes.ts` uses.
 *
 * Query plans (design §3.3):
 *  - **Fast path** (`listThreadsFast`): a folder with no search/filter, reads
 *    `thread_labels`/`threads` directly via `thread_labels_page_idx
 *    (label_key, latest_at DESC, thread_key)`; the folder's thread count comes
 *    straight from `label_counts.threads` — no scan of `messages` at all.
 *  - **Filtered path** (`listThreadsFiltered`): search or any of
 *    `from`/`to`/`subject`/`hasAttachment`/`excludeWords` present. Computes
 *    the matching `thread_key`s from `messages` (`message_labels` for the
 *    folder, the two FTS tables for `search`/`excludeWords`,
 *    `messages_account_thread_key`-style grouping via `DISTINCT thread_key`),
 *    then joins `threads` for ordering and `has_attachments`. Indexes used:
 *    `messages_list_idx`/`messages_thread_idx` for the `deleted_at IS NULL`
 *    scan, `message_labels_msg_idx` for the per-message label check,
 *    `message_addresses_msg_idx` for `to`/`counterparty`, and the two FTS5
 *    tables for `search`/`excludeWords`.
 *  - Both paths share one keyset/offset tail (`cursorCondition`,
 *    `clampThreadOffset`) and one lean-message pull
 *    (`loadLiveMessagesForThreadKeys`, one `IN (thread keys)` query, chunked)
 *    feeding `buildThreadSummary` (`../store/thread-summary`) — the same
 *    aggregation rule the Postgres store and `writes.ts`'s `refreshThread`
 *    use, so a thread's shape never depends on which path answered it.
 *
 * Intentional differences from the Postgres store (anything beyond decision
 * 3's search semantics is called out here, not left implicit):
 *  - **Search is FTS, not `ILIKE`** (decision 3, excluded from parity by
 *    design): `messages_fts_meta` (trigram) for a substring match on
 *    subject/sender/recipients, ORed with `messages_fts_body`
 *    (`unicode61`, token-prefix) for the body. `excludeWords` follows the
 *    same split — the old single-table design's "subject sender preview
 *    body" list is now "subject sender recipients" (meta, substring) OR
 *    "body" (body, token-prefix); there is no indexed `preview` column any
 *    more (decision 3 drops it), so a word that only appears in the preview
 *    and nowhere else no longer excludes a thread. Both query builders quote
 *    every word so `AND`/`OR`/`NOT` typed by a user can never become FTS5
 *    operators.
 *  - **`MessageListQuery.threadId` matches `thread_key`, not the raw
 *    `thread_id` column.** Postgres's `listMessages`/`listMessagesWide`
 *    filter on the possibly-null `mailMessages.threadId` column directly;
 *    every message in the object already carries a resolved `thread_key`
 *    (its own id when standalone), which is the thing callers actually mean
 *    by "this thread's messages" and is never null.
 *  - **`findByRfcIds`'s `providerIds` match `provider_message_id` only.**
 *    Postgres's `findThreadByReplyIds` (used by `resolveInbound`) also
 *    checks `mailcowMessageId`, a legacy Mailcow-sync column `sql.ts`'s
 *    `mapMessageRow` comment already documents as dropped from this schema
 *    ("nothing in the new ingest/op surface ever sets" it) — there is
 *    nothing to match it against here. `findByRfcIds` itself (the
 *    send/ingest de-dup read) matches Postgres exactly: `provider_message_id`
 *    and `external_message_id`, never `mailcowMessageId` either.
 *  - **`SnoozedMessage.triggerRunId` is always `null`.** It is Postgres's
 *    `unsnoozeTriggerRunId`, also absent from this schema per the same
 *    `mapMessageRow` comment.
 *  - **Bodies are never populated**, regardless of `getMessage`'s/
 *    `exportPage`'s options — `textBody`/`htmlBody`/`rawMessage` come back
 *    `null` unconditionally (`mapMessageRow`'s own contract: "a caller
 *    wanting bodies reads R2 itself"). Postgres's `getMessage`/`exportPage`
 *    include real body text when asked.
 *  - **`MailboxStats.labels` lists only folder keys that currently have at
 *    least one message** (every row of `label_counts`, a table `writes.ts`
 *    deletes down to zero rows). The Postgres store additionally zero-fills
 *    every *known* custom label name from `mail_labels`, a table this object
 *    has no access to (label definitions live in the KV directory, design
 *    §6) — a brand-new, still-empty custom label shows no badge here until
 *    its first message, where Postgres already shows a `0`. `labelCounts(
 *    keys)` is unaffected: it zero-fills any key the caller actually asks
 *    for.
 *  - **The offset cap (design §5, `ThreadListQuery.offset`'s "capped at 5000
 *    by the caller") is also enforced here**, defensively, even though
 *    `PostgresMailboxStore` does not re-clamp it either — belt and braces
 *    for the one store implementation callers are most likely to hit first.
 */

import type { MailEmailAddress } from '@weldsuite/db/schema/mail-messages';
import type { MailDraft } from '@weldsuite/db/schema/mail-drafts';
import type { MailSubscription, MailSubscriptionStatus, MailUnsubscribeMethod } from '@weldsuite/db/schema/mail-subscriptions';
import { toSystemLabel } from '../store/model';
import { buildExcludeWordsMatchQuery, buildMailSearchQuery, quoteFtsPhrase } from '../store/fts-query';
import {
  bareSubject,
  conversationSubjects,
  hasReplyPrefix,
  involvesAddress,
  messageIdVariants,
  providerMessageIds,
} from '../store/thread-match';
import { buildThreadSummary } from '../store/thread-summary';
import type { MessageStats } from '../messages';
import type { ThreadSummary } from '../threads';
import type {
  FolderKey,
  InboundThreadQuery,
  LabelCount,
  MailAttachmentRecord,
  MailboxRef,
  MailboxStats,
  MailMessageListRow,
  MailMessageRecord,
  MessageCursor,
  MessageListQuery,
  MessagePage,
  SnoozedMessage,
  ThreadCursor,
  ThreadFilter,
  ThreadListQuery,
  ThreadPage,
} from '../store/types';
import {
  type AttachmentRow,
  chunk,
  epochToDate,
  epochToDateRequired,
  fromBit,
  loadLabelCounts,
  loadMessageRow,
  loadMessageRows,
  mapAttachmentRow,
  mapMessageRow,
  type MessageRow,
  parseJsonArray,
  parseJsonOrNull,
  placeholders,
  type ThreadRow,
  toBit,
} from './sql';

// ---------------------------------------------------------------------------
// Lean list-row mapping (design's `MailMessageListRow` = phase-1
// `ThreadListMessage` + `threadKey`)
// ---------------------------------------------------------------------------

/** `obj` without `keys` — an explicit drop instead of destructuring into unused `_name` bindings. */
function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...obj };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * `mapMessageRow` minus the fields `MailMessageListRow` (built on
 * `ThreadListMessage`) never carries: bodies, raw MIME and the two JSONB
 * blobs no list view reads. Built by stripping fields off `mapMessageRow`'s
 * own output rather than re-deriving ~60 columns by hand, so the two mappers
 * can never drift on everything they share.
 */
function mapMessageListRow(row: MessageRow, ref: Pick<MailboxRef, 'accountId'>): MailMessageListRow {
  const record = mapMessageRow(row, ref);
  return omit(record, ['textBody', 'htmlBody', 'rawMessage', 'headers', 'customFields', 'clickedLinks']);
}

/** Every live row for a set of thread keys, in `sent_at` order, grouped by thread key. One `IN (...)` pull (chunked), not one query per thread. */
function loadLiveMessagesForThreadKeys(
  sql: SqlStorage,
  ref: MailboxRef,
  threadKeys: readonly string[],
): Map<string, MailMessageListRow[]> {
  const map = new Map<string, MailMessageListRow[]>();
  if (threadKeys.length === 0) return map;
  for (const part of chunk(threadKeys)) {
    const rows = sql
      .exec<MessageRow>(
        `SELECT * FROM messages WHERE thread_key IN (${placeholders(part.length)}) AND deleted_at IS NULL ORDER BY sent_at ASC, id ASC`,
        ...part,
      )
      .toArray();
    for (const row of rows) {
      const list = map.get(row.thread_key) ?? [];
      list.push(mapMessageListRow(row, ref));
      map.set(row.thread_key, list);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Shared thread-list plumbing: cursor/offset, folder keys, the final page
// ---------------------------------------------------------------------------

/** Design §5's cap on legacy offset paging. */
const MAX_THREAD_OFFSET = 5000;

function clampThreadOffset(offset: number): number {
  return Math.min(Math.max(0, Math.trunc(offset)), MAX_THREAD_OFFSET);
}

/**
 * Translate the unified `(latestAt DESC, accountId ASC, threadKey ASC)`
 * cursor (design §5) into a condition against THIS mailbox's rows, given how
 * this mailbox's `accountId` compares with the cursor's — the comparison the
 * design leaves to "the worker" building the per-mailbox query:
 *  - same account: resume strictly after `(latestAt, threadKey)` ('gt' below);
 *  - this mailbox's id sorts after the cursor's: every row at `latestAt` is
 *    past the cursor regardless of its own `threadKey` ('all');
 *  - sorts before: nothing at `latestAt` qualifies, only strictly older rows
 *    do ('none' — reduces to just the first half of the OR).
 */
function threadCursorCondition(
  cursor: ThreadCursor,
  mailboxAccountId: string,
  latestAtCol: string,
  threadKeyCol: string,
): { sql: string; params: unknown[] } {
  if (mailboxAccountId === cursor.accountId) {
    return {
      sql: `(${latestAtCol} < ? OR (${latestAtCol} = ? AND ${threadKeyCol} > ?))`,
      params: [cursor.latestAt, cursor.latestAt, cursor.threadKey],
    };
  }
  if (mailboxAccountId > cursor.accountId) {
    return { sql: `${latestAtCol} <= ?`, params: [cursor.latestAt] };
  }
  return { sql: `${latestAtCol} < ?`, params: [cursor.latestAt] };
}

/** `'all'` → `'__all'`; everything else lower-cased, matching how `writes.ts`'s `folderKeys()` names every key it maintains. */
function folderKeyForLabelSlug(labelSlug: string): FolderKey {
  return labelSlug.toLowerCase() === 'all' ? '__all' : labelSlug.toLowerCase();
}

/** `ThreadFilter` carries more than a plain folder: any of these routes `listThreads` to the filtered path instead of the `thread_labels` fast path. */
function hasThreadFilters(q: ThreadFilter): boolean {
  return Boolean(q.search?.trim() || q.from?.trim() || q.to?.trim() || q.subject?.trim() || q.hasAttachment || q.excludeWords?.trim());
}

/** Shared tail of both thread-list paths: slice the (pageSize+1)-row page, pull lean messages for it, build summaries, compute the next cursor. */
function finishThreadPage(
  sql: SqlStorage,
  ref: MailboxRef,
  rows: readonly ThreadRow[],
  pageSize: number,
  totalCount: number,
): ThreadPage {
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const messagesByThread = loadLiveMessagesForThreadKeys(sql, ref, page.map((r) => r.thread_key));
  const threads: ThreadSummary[] = page.map((r) =>
    buildThreadSummary({ accountId: ref.accountId, threadId: r.thread_key }, messagesByThread.get(r.thread_key) ?? []),
  );
  const last = page.at(-1);
  const nextCursor: ThreadCursor | null =
    hasMore && last ? { latestAt: last.latest_at, accountId: ref.accountId, threadKey: last.thread_key } : null;
  return { threads, totalCount, nextCursor };
}

// ---------------------------------------------------------------------------
// Fast path: a plain folder, via `thread_labels`/`label_counts`
// ---------------------------------------------------------------------------

function listThreadsFast(sql: SqlStorage, ref: MailboxRef, q: ThreadListQuery, labelKey: FolderKey): ThreadPage {
  const totalCount = loadLabelCounts(sql, [labelKey]).get(labelKey)?.threads ?? 0;
  const params: unknown[] = [labelKey];
  let cursorSql = '';
  if (q.cursor) {
    const cond = threadCursorCondition(q.cursor, ref.accountId, 'tl.latest_at', 'tl.thread_key');
    cursorSql = ` AND (${cond.sql})`;
    params.push(...cond.params);
  }
  params.push(q.pageSize + 1);
  let limitOffsetSql = ' LIMIT ?';
  if (!q.cursor && q.offset) {
    limitOffsetSql += ' OFFSET ?';
    params.push(clampThreadOffset(q.offset));
  }
  const rows = sql
    .exec<ThreadRow>(
      `SELECT t.* FROM thread_labels tl JOIN threads t ON t.thread_key = tl.thread_key
       WHERE tl.label_key = ?${cursorSql}
       ORDER BY tl.latest_at DESC, tl.thread_key ASC${limitOffsetSql}`,
      ...params,
    )
    .toArray();
  return finishThreadPage(sql, ref, rows, q.pageSize, totalCount);
}

// ---------------------------------------------------------------------------
// Filtered path: search and/or from/to/subject/hasAttachment/excludeWords
// ---------------------------------------------------------------------------

/** Unicode-aware word splitter, matching `../store/fts-query`'s private one (kept local rather than exported from there just for this). */
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/** Escapes a `LIKE`/`ESCAPE '\\'` special character by prefixing it with a backslash. */
function escapeLikeChar(ch: string): string {
  return '\\' + ch;
}

function likePattern(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\\%_]/g, escapeLikeChar)}%`;
}

/**
 * The `excludeWords` check (design §3.3), adapted to the two-table split
 * (decision 3): a thread is excluded when ANY of its live messages matches
 * ANY word, by substring on subject/sender/recipients (meta, trigram —
 * quoted-phrase-OR, since trigram has no prefix-query form) OR by
 * token-prefix on body (`buildExcludeWordsMatchQuery`). `null` when there are
 * no indexable words (mirrors the other FTS builders' "nothing to search
 * for" contract).
 */
function buildExcludeWordsSql(words: string | undefined): { sql: string; params: unknown[] } | null {
  if (!words) return null;
  const tokens = (words.match(WORD_PATTERN) ?? []).map((t) => t.toLowerCase());
  if (tokens.length === 0) return null;
  const metaQuery = tokens.map(quoteFtsPhrase).join(' OR ');
  const bodyQuery = buildExcludeWordsMatchQuery(words);
  const parts = ['EXISTS (SELECT 1 FROM messages_fts_meta WHERE rowid = m2.rowid AND messages_fts_meta MATCH ?)'];
  const params: unknown[] = [metaQuery];
  if (bodyQuery) {
    parts.push('EXISTS (SELECT 1 FROM messages_fts_body WHERE rowid = m2.rowid AND messages_fts_body MATCH ?)');
    params.push(bodyQuery);
  }
  return { sql: parts.join(' OR '), params };
}

/**
 * The message-level WHERE a thread's messages must satisfy to put it in a
 * filtered listing (design §3.3's "matching message threads"): folder-or-
 * search, then the from/to/subject substring filters, then the two
 * thread-level predicates (`hasAttachment` via `threads.has_attachments`,
 * `excludeWords` via a `NOT EXISTS` over every live message of the thread,
 * not just the ones this WHERE already matched).
 *
 * Mirrors `threads.ts`'s `buildThreadScope` precisely: a `search` bypasses
 * the folder entirely (a search looks through the whole live mailbox, not
 * just the open folder) but still excludes trash/spam; a custom (non-system)
 * label additionally excludes archived mail, trash/spam folders exclude
 * neither rule since they volunteer themselves for the location they are.
 */
/**
 * The search-vs-folder branch of {@link buildThreadMessageMatch}: a `search`
 * bypasses the open folder entirely (still excluding trash/spam); otherwise
 * the folder's own location/archive rules apply. Early returns stand in for
 * the original if/else nesting so each case reads as its own short-circuit.
 */
function appendThreadScopeClause(clauses: string[], params: unknown[], q: ThreadFilter): void {
  const search = buildMailSearchQuery(q.search);
  if (search) {
    clauses.push('in_trash = 0 AND in_spam = 0');
    const orParts: string[] = [];
    if (search.meta) {
      orParts.push('EXISTS (SELECT 1 FROM messages_fts_meta WHERE rowid = messages.rowid AND messages_fts_meta MATCH ?)');
      params.push(search.meta);
    }
    if (search.body) {
      orParts.push('EXISTS (SELECT 1 FROM messages_fts_body WHERE rowid = messages.rowid AND messages_fts_body MATCH ?)');
      params.push(search.body);
    }
    if (orParts.length > 0) clauses.push(`(${orParts.join(' OR ')})`);
    return;
  }

  const key = folderKeyForLabelSlug(q.labelSlug);
  if (key === '__all') {
    clauses.push('in_trash = 0 AND in_spam = 0');
    return;
  }
  clauses.push('EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = messages.id AND ml.label_key = ?)');
  params.push(key);
  if (key === 'trash' || key === 'spam') return;
  clauses.push('in_trash = 0 AND in_spam = 0');
  if (!toSystemLabel(q.labelSlug)) clauses.push('archived = 0');
}

/** The from/to/subject/hasAttachment filters of {@link buildThreadMessageMatch}. */
function appendThreadFieldFilters(clauses: string[], params: unknown[], q: ThreadFilter): void {
  if (q.from?.trim()) {
    const pattern = likePattern(q.from);
    clauses.push("(LOWER(from_email) LIKE ? ESCAPE '\\' OR LOWER(from_name) LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (q.to?.trim()) {
    const pattern = likePattern(q.to);
    clauses.push(
      "EXISTS (SELECT 1 FROM message_addresses ma WHERE ma.message_id = messages.id AND ma.role IN ('to','cc') AND (LOWER(ma.address) LIKE ? ESCAPE '\\' OR LOWER(ma.name) LIKE ? ESCAPE '\\'))",
    );
    params.push(pattern, pattern);
  }
  if (q.subject?.trim()) {
    clauses.push("LOWER(subject) LIKE ? ESCAPE '\\'");
    params.push(likePattern(q.subject));
  }
  if (q.hasAttachment) {
    clauses.push('thread_key IN (SELECT thread_key FROM threads WHERE has_attachments = 1)');
  }
}

/** The `excludeWords` filter of {@link buildThreadMessageMatch}. */
function appendThreadExcludeWordsFilter(clauses: string[], params: unknown[], q: ThreadFilter): void {
  const exclude = buildExcludeWordsSql(q.excludeWords);
  if (!exclude) return;
  clauses.push(`thread_key NOT IN (SELECT m2.thread_key FROM messages m2 WHERE m2.deleted_at IS NULL AND (${exclude.sql}))`);
  params.push(...exclude.params);
}

function buildThreadMessageMatch(q: ThreadFilter): { where: string; params: unknown[] } {
  const clauses: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  appendThreadScopeClause(clauses, params, q);
  appendThreadFieldFilters(clauses, params, q);
  appendThreadExcludeWordsFilter(clauses, params, q);

  return { where: clauses.join(' AND '), params };
}

function listThreadsFiltered(sql: SqlStorage, ref: MailboxRef, q: ThreadListQuery): ThreadPage {
  const match = buildThreadMessageMatch(q);
  const candidateSql = `SELECT DISTINCT thread_key FROM messages WHERE ${match.where}`;

  const totalRow = sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM (${candidateSql})`, ...match.params).toArray()[0];
  const totalCount = totalRow?.c ?? 0;

  const params: unknown[] = [...match.params];
  let cursorSql = '';
  if (q.cursor) {
    const cond = threadCursorCondition(q.cursor, ref.accountId, 't.latest_at', 't.thread_key');
    cursorSql = ` AND (${cond.sql})`;
    params.push(...cond.params);
  }
  params.push(q.pageSize + 1);
  let limitOffsetSql = ' LIMIT ?';
  if (!q.cursor && q.offset) {
    limitOffsetSql += ' OFFSET ?';
    params.push(clampThreadOffset(q.offset));
  }
  const rows = sql
    .exec<ThreadRow>(
      `SELECT t.* FROM threads t JOIN (${candidateSql}) c ON c.thread_key = t.thread_key
       WHERE 1=1${cursorSql}
       ORDER BY t.latest_at DESC, t.thread_key ASC${limitOffsetSql}`,
      ...params,
    )
    .toArray();
  return finishThreadPage(sql, ref, rows, q.pageSize, totalCount);
}

/** `MailboxStore.listThreads` — routes to the fast or filtered path (design §3.3). */
export function listThreads(sql: SqlStorage, ref: MailboxRef, q: ThreadListQuery): ThreadPage {
  if (!hasThreadFilters(q)) {
    return listThreadsFast(sql, ref, q, folderKeyForLabelSlug(q.labelSlug));
  }
  return listThreadsFiltered(sql, ref, q);
}

// ---------------------------------------------------------------------------
// Thread / message reads
// ---------------------------------------------------------------------------

/** `MailboxStore.getThread`: every live message under a thread key, oldest first (matches `getThreadByKey`'s `asc(sentDate), asc(id)`). */
export function getThread(
  sql: SqlStorage,
  ref: MailboxRef,
  threadKey: string,
): { threadId: string; accountId: string; messages: MailMessageRecord[] } | null {
  const rows = sql
    .exec<MessageRow>('SELECT * FROM messages WHERE thread_key = ? AND deleted_at IS NULL ORDER BY sent_at ASC, id ASC', threadKey)
    .toArray();
  if (rows.length === 0) return null;
  return { threadId: threadKey, accountId: ref.accountId, messages: rows.map((r) => mapMessageRow(r, ref)) };
}

/**
 * `MailboxStore.getThreadOfMessage`: a soft-deleted or missing anchor yields
 * `null` (matches `getThread`'s "only a genuinely missing (or deleted)
 * message yields no thread"); otherwise its whole thread, even when that
 * thread is just itself.
 */
export function getThreadOfMessage(
  sql: SqlStorage,
  ref: MailboxRef,
  messageId: string,
): { threadId: string; messages: MailMessageRecord[] } | null {
  const anchor = loadMessageRow(sql, messageId);
  if (!anchor || anchor.deleted_at !== null) return null;
  const rows = sql
    .exec<MessageRow>('SELECT * FROM messages WHERE thread_key = ? AND deleted_at IS NULL ORDER BY sent_at ASC, id ASC', anchor.thread_key)
    .toArray();
  return { threadId: anchor.thread_key, messages: rows.map((r) => mapMessageRow(r, ref)) };
}

/**
 * `MailboxStore.getMessage`. `o.bodies` is accepted for interface parity but
 * is a no-op: the object never stores body text, so `textBody`/`htmlBody`/
 * `rawMessage` come back `null` regardless (the caller reads R2 itself, per
 * `mapMessageRow`'s own contract).
 */
export function getMessage(
  sql: SqlStorage,
  ref: MailboxRef,
  id: string,
  o?: { bodies?: boolean; attachments?: boolean },
): (MailMessageRecord & { attachments?: MailAttachmentRecord[] }) | null {
  const row = loadMessageRow(sql, id);
  if (!row || row.deleted_at !== null) return null;
  const record: MailMessageRecord & { attachments?: MailAttachmentRecord[] } = mapMessageRow(row, ref);
  if (o?.attachments) record.attachments = listAttachments(sql, id);
  return record;
}

/** `MailboxStore.getMessages`: live lean rows for a set of ids in this mailbox (locate, bulk checks). */
export function getMessages(sql: SqlStorage, ref: MailboxRef, ids: string[]): MailMessageListRow[] {
  if (ids.length === 0) return [];
  return loadMessageRows(sql, ids)
    .filter((r) => r.deleted_at === null)
    .map((r) => mapMessageListRow(r, ref));
}

/** The message-level WHERE for `listMessages` (design §3.3 / `MessageListQuery`). See `buildThreadMessageMatch`'s doc for the search/FTS split. */
/** The `search` clause of {@link buildMessageMatch}. */
function appendMessageSearchClause(clauses: string[], params: unknown[], q: MessageListQuery): void {
  const search = buildMailSearchQuery(q.search);
  if (!search) return;
  const orParts: string[] = [];
  if (search.meta) {
    orParts.push('EXISTS (SELECT 1 FROM messages_fts_meta WHERE rowid = messages.rowid AND messages_fts_meta MATCH ?)');
    params.push(search.meta);
  }
  if (search.body) {
    orParts.push('EXISTS (SELECT 1 FROM messages_fts_body WHERE rowid = messages.rowid AND messages_fts_body MATCH ?)');
    params.push(search.body);
  }
  if (orParts.length > 0) clauses.push(`(${orParts.join(' OR ')})`);
}

/** The from/label/thread/flag filters of {@link buildMessageMatch}. */
function appendMessageFieldFilters(clauses: string[], params: unknown[], q: MessageListQuery): void {
  if (q.from?.trim()) {
    const pattern = likePattern(q.from);
    clauses.push("(LOWER(from_email) LIKE ? ESCAPE '\\' OR LOWER(from_name) LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (q.label) {
    clauses.push('EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = messages.id AND ml.label_key = ?)');
    params.push(q.label.toLowerCase());
  }
  // Matches `thread_key`, not the raw (possibly null) `thread_id` column —
  // see this file's header comment, "intentional differences".
  if (q.threadId) {
    clauses.push('thread_key = ?');
    params.push(q.threadId);
  }
  if (q.isRead !== undefined) {
    clauses.push('is_read = ?');
    params.push(toBit(q.isRead));
  }
  if (q.isStarred !== undefined) {
    clauses.push('starred = ?');
    params.push(toBit(q.isStarred));
  }
  if (q.isFlagged !== undefined) {
    clauses.push('is_flagged = ?');
    params.push(toBit(q.isFlagged));
  }
  if (q.hasAttachments !== undefined) {
    clauses.push('has_attachments = ?');
    params.push(toBit(q.hasAttachments));
  }
}

/** The location/counterparty filters of {@link buildMessageMatch}. */
function appendMessageLocationFilters(clauses: string[], params: unknown[], q: MessageListQuery): void {
  if (q.excludeTrash) clauses.push('in_trash = 0');
  if (q.excludeSpam) clauses.push('in_spam = 0');
  if (q.counterparty?.trim()) {
    clauses.push('EXISTS (SELECT 1 FROM message_addresses ma WHERE ma.message_id = messages.id AND LOWER(ma.address) = ?)');
    params.push(q.counterparty.trim().toLowerCase());
  }
}

function buildMessageMatch(q: MessageListQuery): { where: string; params: unknown[] } {
  const clauses: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  appendMessageSearchClause(clauses, params, q);
  appendMessageFieldFilters(clauses, params, q);
  appendMessageLocationFilters(clauses, params, q);

  return { where: clauses.join(' AND '), params };
}

/** `MailboxStore.listMessages`: keyset `sent_at` desc, `id` desc (`messages_list_idx`). */
export function listMessages(sql: SqlStorage, ref: MailboxRef, q: MessageListQuery): MessagePage {
  const match = buildMessageMatch(q);
  const params: unknown[] = [...match.params];
  let cursorSql = '';
  if (q.cursor) {
    cursorSql = ' AND (sent_at < ? OR (sent_at = ? AND id < ?))';
    params.push(q.cursor.sentAt, q.cursor.sentAt, q.cursor.id);
  }
  const rows = sql
    .exec<MessageRow>(
      `SELECT * FROM messages WHERE ${match.where}${cursorSql} ORDER BY sent_at DESC, id DESC LIMIT ?`,
      ...params,
      q.limit + 1,
    )
    .toArray();
  const countRow = sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM messages WHERE ${match.where}`, ...match.params).toArray()[0];
  const totalCount = countRow?.c ?? 0;

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const data = page.map((r) => mapMessageListRow(r, ref));
  const last = page.at(-1);
  const nextCursor: MessageCursor | null = hasMore && last ? { sentAt: last.sent_at, id: last.id } : null;
  return { data, totalCount, nextCursor };
}

// ---------------------------------------------------------------------------
// Stats, unread, label counts
// ---------------------------------------------------------------------------

/** Every `label_counts` key `stats()` maps onto a `MessageStats` field (design §3.2's "Stats map"). */
const STATS_KEYS: readonly FolderKey[] = ['__total', '__scheduled', 'inbox', 'starred', 'important', 'sent', 'archive', 'trash', 'spam', 'snoozed'];

/**
 * `MailboxStore.stats()`. `labels` lists every `label_counts` row as-is — see
 * this file's header comment for how that differs from the Postgres store's
 * zero-filled, `mail_labels`-driven list.
 */
export function stats(sql: SqlStorage): MailboxStats {
  const counts = loadLabelCounts(sql, STATS_KEYS);
  const get = (key: FolderKey): LabelCount => {
    const row = counts.get(key);
    return { messages: row?.messages ?? 0, unread: row?.unread ?? 0, threads: row?.threads ?? 0 };
  };
  const draftsRow = sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM drafts WHERE deleted_at IS NULL').toArray()[0];

  const base: MessageStats = {
    total: get('__total').messages,
    unread: get('__total').unread,
    inboxUnread: get('inbox').unread,
    starred: get('starred').messages,
    importantUnread: get('important').unread,
    sentUnread: get('sent').unread,
    archiveUnread: get('archive').unread,
    trashUnread: get('trash').unread,
    spam: get('spam').messages,
    snoozed: get('snoozed').messages,
    scheduled: get('__scheduled').messages,
    drafts: draftsRow?.c ?? 0,
  };

  const labels: Record<FolderKey, LabelCount> = {};
  for (const row of sql.exec<{ label_key: string; messages: number; unread: number; threads: number }>('SELECT * FROM label_counts').toArray()) {
    labels[row.label_key] = { messages: row.messages, unread: row.unread, threads: row.threads };
  }
  return { ...base, labels };
}

/** `MailboxStore.unreadCount`: `'inbox'` → the `inbox` folder key; `'all-live'` → `__all` (every live, non-trash/spam message). */
export function unreadCount(sql: SqlStorage, scope: 'inbox' | 'all-live'): number {
  const key: FolderKey = scope === 'inbox' ? 'inbox' : '__all';
  return loadLabelCounts(sql, [key]).get(key)?.unread ?? 0;
}

/** `MailboxStore.labelCounts`: zero-fills any key with no `label_counts` row (an empty folder, or a label with no messages yet). */
export function labelCounts(sql: SqlStorage, keys: FolderKey[]): Record<FolderKey, LabelCount> {
  if (keys.length === 0) return {};
  const rows = loadLabelCounts(sql, keys);
  const result: Record<FolderKey, LabelCount> = {};
  for (const key of keys) {
    const row = rows.get(key);
    result[key] = { messages: row?.messages ?? 0, unread: row?.unread ?? 0, threads: row?.threads ?? 0 };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Attachments, recent addresses
// ---------------------------------------------------------------------------

/** `MailboxStore.listAttachments`. Order is this file's own choice (Postgres's `listAttachmentsForMessage` has none): `created_at` then `id`, for a deterministic result. */
export function listAttachments(sql: SqlStorage, messageId: string): MailAttachmentRecord[] {
  return sql
    .exec<AttachmentRow>('SELECT * FROM attachments WHERE message_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC', messageId)
    .toArray()
    .map(mapAttachmentRow);
}

/**
 * `MailboxStore.getAttachment`. `accountId` is always this mailbox's own, but
 * still needs the join Postgres's cross-table lookup does, to rule out an
 * attachment whose owning message is itself soft-deleted — a message delete
 * (`writes.ts`'s `applySoftDelete`) only ever sets `messages.deleted_at`,
 * never touches the `attachments` rows it owns.
 */
export function getAttachment(sql: SqlStorage, ref: MailboxRef, id: string): (MailAttachmentRecord & { accountId: string }) | null {
  const row = sql
    .exec<AttachmentRow>(
      `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE a.id = ? AND a.deleted_at IS NULL AND m.deleted_at IS NULL`,
      id,
    )
    .toArray()[0];
  if (!row) return null;
  return { ...mapAttachmentRow(row), accountId: ref.accountId };
}

/**
 * `MailboxStore.recentAttachments`. `totalCount` is computed with the exact
 * same WHERE as the page, `before` cursor included — matching
 * `PostgresMailboxStore.recentAttachments`'s behaviour (both queries reuse
 * one built `where`), not "every non-inline attachment ever".
 */
export function recentAttachments(
  sql: SqlStorage,
  q: { before?: { createdAt: number; id: string }; limit: number },
): { data: MailAttachmentRecord[]; totalCount: number } {
  const clauses = ['deleted_at IS NULL', 'is_inline = 0'];
  const params: unknown[] = [];
  if (q.before) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(q.before.createdAt, q.before.createdAt, q.before.id);
  }
  const where = clauses.join(' AND ');
  const rows = sql
    .exec<AttachmentRow>(`SELECT * FROM attachments WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, q.limit)
    .toArray();
  const countRow = sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM attachments WHERE ${where}`, ...params).toArray()[0];
  return { data: rows.map(mapAttachmentRow), totalCount: countRow?.c ?? 0 };
}

/**
 * `MailboxStore.recentAddresses`: distinct `from`/`to` addresses of the 200
 * most recent live messages (matches `PostgresMailboxStore.recentAddresses`
 * exactly, down to only looking at `from`/`to`, never `cc`/`bcc`), in
 * recency order, capped at `limit`.
 */
export function recentAddresses(sql: SqlStorage, limit: number): string[] {
  const recent = sql
    .exec<{ id: string; from_email: string }>('SELECT id, from_email FROM messages WHERE deleted_at IS NULL ORDER BY sent_at DESC LIMIT 200')
    .toArray();
  if (recent.length === 0) return [];

  const toAddressesByMessage = new Map<string, string[]>();
  for (const part of chunk(recent.map((r) => r.id))) {
    for (const row of sql
      .exec<{ message_id: string; address: string }>(
        `SELECT message_id, address FROM message_addresses WHERE role = 'to' AND message_id IN (${placeholders(part.length)})`,
        ...part,
      )
      .toArray()) {
      const list = toAddressesByMessage.get(row.message_id) ?? [];
      list.push(row.address);
      toAddressesByMessage.set(row.message_id, list);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | null | undefined) => {
    const value = raw?.trim().toLowerCase();
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  };
  for (const row of recent) {
    add(row.from_email);
    for (const address of toAddressesByMessage.get(row.id) ?? []) add(address);
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Inbound thread resolution (`resolveInbound`, ported from
// mail-inbound-worker's `isTenantDuplicate`/`findThreadByReplyIds`/
// `findThreadBySubject`/`resolveTenantThread`, design §2 inventory)
// ---------------------------------------------------------------------------

interface ThreadMatch {
  threadId: string;
  isExistingHamThread: boolean;
}

/** Ported from `computeThreadId` (the inbound worker) / `computeThreadId` (`store/postgres/inbound.ts`): first reference (conversation root), else `inReplyTo`, else the message's own RFC id. */
function computeInboundThreadId(q: Pick<InboundThreadQuery, 'rfcMessageId' | 'inReplyTo' | 'references'>): string {
  return q.references?.[0] || q.inReplyTo || q.rfcMessageId;
}

/**
 * Ported from `findThreadByReplyIds`: match the reply's In-Reply-To/
 * References (both Message-ID spellings) against `rfc_message_id` or
 * `external_message_id`, or their local parts against `provider_message_id`
 * (the object's closest equivalent to Postgres's `mailcowMessageId` — see
 * this file's header comment). No `deleted_at` filter, matching Postgres: a
 * reply can thread onto a since-deleted message.
 */
function findThreadByReplyIds(sql: SqlStorage, q: InboundThreadQuery): ThreadMatch | null {
  const lookupIds = messageIdVariants([...(q.inReplyTo ? [q.inReplyTo] : []), ...(q.references ?? [])]);
  if (lookupIds.length === 0) return null;
  const providerIds = providerMessageIds(lookupIds);

  const clauses = [`rfc_message_id IN (${placeholders(lookupIds.length)})`, `external_message_id IN (${placeholders(lookupIds.length)})`];
  const params: unknown[] = [...lookupIds, ...lookupIds];
  if (providerIds.length > 0) {
    clauses.push(`provider_message_id IN (${placeholders(providerIds.length)})`);
    params.push(...providerIds);
  }

  const row = sql
    .exec<{ thread_key: string; in_spam: number }>(`SELECT thread_key, in_spam FROM messages WHERE (${clauses.join(' OR ')}) LIMIT 1`, ...params)
    .toArray()[0];
  if (!row) return null;
  return { threadId: row.thread_key, isExistingHamThread: row.in_spam === 0 };
}

/** Ported from `findThreadBySubject`: the most recent of up to 20 same-subject candidates, optionally requiring the sender to have taken part in it already. */
function findThreadBySubject(sql: SqlStorage, q: InboundThreadQuery, opts: { requireParticipant: boolean } = { requireParticipant: false }): ThreadMatch | null {
  const subjects = conversationSubjects(q.subject);
  if (subjects.length === 0) return null;

  const rows = sql
    .exec<{ thread_key: string; in_spam: number; from_json: string; to_json: string; cc_json: string | null }>(
      `SELECT thread_key, in_spam, from_json, to_json, cc_json FROM messages
       WHERE LOWER(subject) IN (${placeholders(subjects.length)}) AND deleted_at IS NULL
       ORDER BY sent_at DESC LIMIT 20`,
      ...subjects,
    )
    .toArray();

  for (const row of rows) {
    if (opts.requireParticipant) {
      const from = parseJsonOrNull<MailEmailAddress>(row.from_json);
      const to = parseJsonArray<MailEmailAddress>(row.to_json);
      const cc = parseJsonOrNull<MailEmailAddress[]>(row.cc_json) ?? [];
      if (!involvesAddress({ from, to, cc }, q.fromEmail ?? undefined)) continue;
    }
    return { threadId: row.thread_key, isExistingHamThread: row.in_spam === 0 };
  }
  return null;
}

/**
 * `MailboxStore.resolveInbound`, ported verbatim (algorithm-wise) from
 * `resolveTenantThread` + `isTenantDuplicate`. The duplicate check has no
 * `deleted_at` filter either, matching Postgres: a redelivered message whose
 * only stored copy was since deleted is still reported as a duplicate.
 */
export function resolveInbound(sql: SqlStorage, q: InboundThreadQuery): { duplicate: boolean; threadId: string; isExistingHamThread: boolean } {
  if (q.rfcMessageId) {
    const existing = sql.exec<{ id: string; thread_key: string }>('SELECT id, thread_key FROM messages WHERE rfc_message_id = ? LIMIT 1', q.rfcMessageId).toArray()[0];
    if (existing) return { duplicate: true, threadId: existing.thread_key, isExistingHamThread: false };
  }

  if (!q.isReply) {
    if (hasReplyPrefix(q.subject) && bareSubject(q.subject)) {
      const bySubject = findThreadBySubject(sql, q, { requireParticipant: true });
      if (bySubject) return { duplicate: false, ...bySubject };
    }
    return { duplicate: false, threadId: q.rfcMessageId, isExistingHamThread: false };
  }

  const byIds = findThreadByReplyIds(sql, q);
  if (byIds) return { duplicate: false, ...byIds };

  const bySubject = findThreadBySubject(sql, q);
  if (bySubject) return { duplicate: false, ...bySubject };

  return { duplicate: false, threadId: computeInboundThreadId(q), isExistingHamThread: false };
}

/**
 * `MailboxStore.findByRfcIds`: de-dup lookups for the send/ingest paths.
 * `providerIds` match `external_message_id` AND `provider_message_id` —
 * matches `store/postgres/inbound.ts`'s `findByRfcIds` exactly (unlike
 * `resolveInbound`'s reply-matching, this one never looked at
 * `mailcowMessageId` in Postgres either). No `deleted_at` filter, matching
 * Postgres.
 */
export function findByRfcIds(sql: SqlStorage, ids: string[], providerIds: string[]): Array<{ id: string; threadId: string | null; source: string | null }> {
  if (ids.length === 0 && providerIds.length === 0) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (ids.length > 0) {
    clauses.push(`rfc_message_id IN (${placeholders(ids.length)})`);
    params.push(...ids);
  }
  if (providerIds.length > 0) {
    clauses.push(`external_message_id IN (${placeholders(providerIds.length)})`);
    params.push(...providerIds);
    clauses.push(`provider_message_id IN (${placeholders(providerIds.length)})`);
    params.push(...providerIds);
  }
  const rows = sql.exec<{ id: string; thread_id: string | null; source: string | null }>(`SELECT id, thread_id, source FROM messages WHERE ${clauses.join(' OR ')}`, ...params).toArray();
  return rows.map((r) => ({ id: r.id, threadId: r.thread_id, source: r.source }));
}

/** `MailboxStore.findSentByIdempotencyKey`. No `deleted_at` filter, matching Postgres. */
export function findSentByIdempotencyKey(sql: SqlStorage, key: string): { id: string; rfcMessageId: string; externalMessageId: string | null; subject: string | null } | null {
  const row = sql
    .exec<{ id: string; rfc_message_id: string; external_message_id: string | null; subject: string | null }>(
      'SELECT id, rfc_message_id, external_message_id, subject FROM messages WHERE idempotency_key = ? LIMIT 1',
      key,
    )
    .toArray()[0];
  if (!row) return null;
  return { id: row.id, rfcMessageId: row.rfc_message_id, externalMessageId: row.external_message_id, subject: row.subject };
}

/** `MailboxStore.countSentSince`: deleted included, matching `countSentSince`/`countSentToday`. Uses `messages_source_sent_idx(source, sent_at)`. */
export function countSentSince(sql: SqlStorage, since: number): number {
  const row = sql
    .exec<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE source = 'sent' AND (send_status IS NULL OR send_status = 'sent') AND sent_at >= ?", since)
    .toArray()[0];
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Scheduled, snoozed
// ---------------------------------------------------------------------------

/** `MailboxStore.listScheduled`: live, soonest first. Uses `messages_scheduled_idx`. */
export function listScheduled(sql: SqlStorage, ref: MailboxRef): MailMessageRecord[] {
  return sql
    .exec<MessageRow>("SELECT * FROM messages WHERE deleted_at IS NULL AND send_status = 'scheduled' ORDER BY scheduled_for ASC")
    .toArray()
    .map((r) => mapMessageRow(r, ref));
}

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * `MailboxStore.listSnoozed`: every live message carrying the `snoozed`
 * label. `triggerRunId` is always `null` — see this file's header comment
 * (Postgres's `unsnoozeTriggerRunId` isn't part of this schema).
 */
export function listSnoozed(sql: SqlStorage, ref: MailboxRef): SnoozedMessage[] {
  const rows = sql
    .exec<MessageRow>(
      `SELECT m.* FROM messages m JOIN message_labels ml ON ml.message_id = m.id AND ml.label_key = 'snoozed' WHERE m.deleted_at IS NULL`,
    )
    .toArray();
  return rows.map((r) => ({
    id: r.id,
    accountId: ref.accountId,
    subject: r.subject,
    from: parseJsonOrNull<MailEmailAddress>(r.from_json) ?? { email: r.from_email, name: r.from_name ?? undefined },
    snoozedUntil: toIso(r.snoozed_until),
    snoozedAt: toIso(r.snoozed_at),
    triggerRunId: null,
    createdAt: toIso(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

type SubscriptionRow = {
  id: string;
  sender_email: string;
  sender_name: string | null;
  sender_domain: string | null;
  list_id: string | null;
  unsubscribe_url: string | null;
  unsubscribe_mailto: string | null;
  one_click: number;
  message_count: number;
  last_subject: string | null;
  first_received_at: number;
  last_received_at: number;
  status: string;
  unsubscribe_method: string | null;
  unsubscribed_at: number | null;
  unsubscribed_by: string | null;
  created_at: number;
  updated_at: number;
}

function mapSubscriptionRow(row: SubscriptionRow, ref: Pick<MailboxRef, 'accountId'>): MailSubscription {
  return {
    id: row.id,
    accountId: ref.accountId,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    senderDomain: row.sender_domain,
    listId: row.list_id,
    unsubscribeUrl: row.unsubscribe_url,
    unsubscribeMailto: row.unsubscribe_mailto,
    oneClick: fromBit(row.one_click),
    messageCount: row.message_count,
    lastSubject: row.last_subject,
    firstReceivedAt: epochToDateRequired(row.first_received_at),
    lastReceivedAt: epochToDateRequired(row.last_received_at),
    status: row.status as MailSubscriptionStatus,
    unsubscribeMethod: row.unsubscribe_method as MailUnsubscribeMethod | null,
    unsubscribedAt: epochToDate(row.unsubscribed_at),
    unsubscribedBy: row.unsubscribed_by,
    createdAt: epochToDateRequired(row.created_at),
    updatedAt: epochToDateRequired(row.updated_at),
  };
}

/** `MailboxStore.listSubscriptions`. */
export function listSubscriptions(sql: SqlStorage, ref: MailboxRef, q: { status?: 'active' | 'unsubscribed' }): MailSubscription[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.status) {
    clauses.push('status = ?');
    params.push(q.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = sql.exec<SubscriptionRow>(`SELECT * FROM subscriptions ${where} ORDER BY last_received_at DESC LIMIT 1000`, ...params).toArray();
  return rows.map((r) => mapSubscriptionRow(r, ref));
}

/** `MailboxStore.getSubscription`. */
export function getSubscription(sql: SqlStorage, ref: MailboxRef, id: string): MailSubscription | null {
  const row = sql.exec<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ?', id).toArray()[0];
  return row ? mapSubscriptionRow(row, ref) : null;
}

/** `MailboxStore.rawSources`: candidate ham inbound messages for a subscriptions scan. No `deleted_at` filter, matching `store/postgres/subscriptions.ts`'s `rawSources`. */
export function rawSources(sql: SqlStorage, q: { since: number; limit: number }): Array<{ id: string; from: MailEmailAddress; subject: string | null; receivedAt: number }> {
  const rows = sql
    .exec<{ id: string; from_json: string; subject: string | null; received_at: number | null; sent_at: number }>(
      "SELECT id, from_json, subject, received_at, sent_at FROM messages WHERE source = 'inbound' AND in_spam = 0 AND sent_at >= ? ORDER BY sent_at DESC LIMIT ?",
      q.since,
      q.limit,
    )
    .toArray();
  return rows.map((r) => ({
    id: r.id,
    from: parseJsonOrNull<MailEmailAddress>(r.from_json) ?? { email: '' },
    subject: r.subject,
    receivedAt: r.received_at ?? r.sent_at,
  }));
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

type DraftRow = {
  id: string;
  subject: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  reply_to_json: string | null;
  body: string | null;
  html_body: string | null;
  importance: string | null;
  labels_json: string | null;
  attachment_ids_json: string | null;
  in_reply_to: string | null;
  original_message_id: string | null;
  is_reply: number | null;
  is_forward: number | null;
  has_attachments: number;
  attachment_count: number;
  last_auto_saved_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function mapDraftRow(row: DraftRow, ref: Pick<MailboxRef, 'accountId'>): MailDraft {
  return {
    id: row.id,
    accountId: ref.accountId,
    subject: row.subject,
    to: parseJsonOrNull<string[]>(row.to_json),
    cc: parseJsonOrNull<string[]>(row.cc_json),
    bcc: parseJsonOrNull<string[]>(row.bcc_json),
    replyTo: parseJsonOrNull<string[]>(row.reply_to_json),
    body: row.body,
    htmlBody: row.html_body,
    importance: row.importance,
    labels: parseJsonOrNull<string[]>(row.labels_json),
    hasAttachments: fromBit(row.has_attachments),
    attachmentCount: row.attachment_count,
    attachmentIds: parseJsonOrNull<string[]>(row.attachment_ids_json),
    inReplyTo: row.in_reply_to,
    originalMessageId: row.original_message_id,
    isReply: row.is_reply === null ? null : fromBit(row.is_reply),
    isForward: row.is_forward === null ? null : fromBit(row.is_forward),
    lastAutoSavedAt: epochToDate(row.last_auto_saved_at),
    createdAt: epochToDateRequired(row.created_at),
    updatedAt: epochToDateRequired(row.updated_at),
    deletedAt: epochToDate(row.deleted_at),
  };
}

/** `MailboxStore.listDrafts`: keyset `updated_at` desc, `id` desc — the cursor is a draft id, resolved to its own `(updated_at, id)` first, matching `drafts.ts`'s `listDrafts`. */
export function listDrafts(sql: SqlStorage, ref: MailboxRef, q: { limit: number; cursor?: string }): { data: MailDraft[]; hasMore: boolean; cursor: string | null; totalCount: number } {
  const countWhere = 'deleted_at IS NULL';
  let where = countWhere;
  const params: unknown[] = [];
  if (q.cursor) {
    const cur = sql.exec<{ updated_at: number; id: string }>('SELECT updated_at, id FROM drafts WHERE id = ?', q.cursor).toArray()[0];
    if (cur) {
      where += ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
      params.push(cur.updated_at, cur.updated_at, cur.id);
    }
  }
  const rows = sql.exec<DraftRow>(`SELECT * FROM drafts WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`, ...params, q.limit + 1).toArray();
  const countRow = sql.exec<{ c: number }>(`SELECT COUNT(*) AS c FROM drafts WHERE ${countWhere}`).toArray()[0];

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const data = page.map((r) => mapDraftRow(r, ref));
  const cursor = hasMore && page.length > 0 ? page[page.length - 1]!.id : null;
  return { data, hasMore, cursor, totalCount: countRow?.c ?? 0 };
}

/** `MailboxStore.getDraft`. */
export function getDraft(sql: SqlStorage, ref: MailboxRef, id: string): MailDraft | null {
  const row = sql.exec<DraftRow>('SELECT * FROM drafts WHERE id = ? AND deleted_at IS NULL', id).toArray()[0];
  return row ? mapDraftRow(row, ref) : null;
}

// ---------------------------------------------------------------------------
// Export (backfill parity, GDPR export, outbound-audit)
// ---------------------------------------------------------------------------

/**
 * `MailboxStore.exportPage`: every row (deleted included) by id, matching
 * `PostgresMailboxStore.exportPage`. Bodies are always `null` here — the
 * object has none to give; a caller that needs them reads R2 per message
 * using `body_bits` (not this file's job).
 */
export function exportPage(
  sql: SqlStorage,
  ref: MailboxRef,
  q: { cursor?: string; limit: number; sentOnly?: boolean; since?: number; until?: number },
): { data: MailMessageRecord[]; cursor: string | null } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.sentOnly) clauses.push("source = 'sent'");
  if (q.since !== undefined) {
    clauses.push('created_at >= ?');
    params.push(q.since);
  }
  if (q.until !== undefined) {
    clauses.push('created_at <= ?');
    params.push(q.until);
  }
  if (q.cursor) {
    clauses.push('id > ?');
    params.push(q.cursor);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = sql.exec<MessageRow>(`SELECT * FROM messages ${where} ORDER BY id ASC LIMIT ?`, ...params, q.limit + 1).toArray();
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const data = page.map((r) => mapMessageRow(r, ref));
  const cursor = hasMore ? page[page.length - 1]!.id : null;
  return { data, cursor };
}
