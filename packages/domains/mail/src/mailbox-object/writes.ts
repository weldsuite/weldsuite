/**
 * `MailboxObject`'s write core (design §3.2, §3.5 `apply`/`applyBatch`, task
 * B1). Applies one `MailboxOp` (from `../store/types`) per call, each inside
 * its own `transactionSync`, keeping `messages`, `message_labels`,
 * `message_addresses`, `threads`, `thread_labels`, `label_counts` and both FTS
 * tables exactly consistent — plus `rebuildDerived()`, which recomputes
 * `threads`/`thread_labels`/`label_counts`/`message_addresses` from `messages`
 * + `message_labels` from scratch (used by the property test and by the real
 * object's maintenance RPC, task C4).
 *
 * Every label/folder/move rule is `../store/model`'s, imported and composed
 * here — never re-derived. The one piece of business logic this file does add
 * (`moveLabels`, below) is not a new rule: it is `../store/model`'s own
 * `addLabels`/`removeLabels`/`CLEARED_BY_MOVE`/`OUTGOING_LABELS` primitives
 * wired together the same way Postgres's `moveMessagesToLocation` (SQL) wires
 * them — `../store/model` has no pure function for that specific composition
 * yet, only its building blocks.
 *
 * Scope (design §9 Group B, task B1 only):
 *   implemented  — ingest, flags, labels.set, labels.add, labels.remove, move,
 *                  thread.label, thread.read, thread.set, delete (soft+hard).
 *   NOT implemented (task B2) — folder.read, label.rename, label.delete,
 *                  snooze/resnooze/unsnooze/snooze.wake, scheduled,
 *                  delivery.match, inbound.finalize, categories,
 *                  attachment.update/delete/associate, subscription.status,
 *                  draft.update/delete. These throw `MailboxOpNotImplementedError`.
 *   `attachment.create`/`draft.create` as standalone ops are also B2; ingest's
 *   OWN attachment rows and (ham) subscription upsert are handled here,
 *   because they are part of processing one `IngestMessage`, not a separate op.
 *
 * Judgment calls made in this file (flagged for the tasks that depend on
 * them):
 *   - `ingest`'s `threadId: null` + `threadHints` case does NOT run the
 *     subject/reply-id thread-matching heuristics (`../store/thread-match`)
 *     itself — that is `resolveInbound`, a *read* (design's inventory lists it
 *     as "S", task B3's `reads.ts`). A `null` `threadId` here becomes its own
 *     thread (`threadKey = id`), same as Postgres's `COALESCE(threadId, id)`
 *     with no `threadId`. A caller that wants resolved threading calls
 *     `resolveInbound` first and passes its result as `IngestMessage.threadId`.
 *   - `OpResult.ready` is always `true` here: backfill-state tracking
 *     (`meta.backfill`) belongs to task C4; the real RPC method (task C1)
 *     should overwrite `ready` from that state before returning to the caller.
 *   - The outbox `ledger.mail` payload shape mirrors `MailAddressBatchEntry`
 *     (`../mail-index/types`) exactly, so task C1's alarm can `JSON.parse` a
 *     row and hand it straight to `MailIndex.recordMailAddresses`. Its
 *     `addresses` list is every participant (from/to/cc/bcc), not just
 *     recipients — `mailboxesForAddress` needs to find a contact regardless of
 *     which role they had on a given message.
 *   - Clock-group assignment (`ClockGroup` in `./sql`) groups `isStarred`/
 *     `isImportant`/`isSpam`/`isTrash` under `'labels'` (they always rewrite
 *     `labels_json`) and keeps `'flag'` to just `isFlagged`, since `isRead` has
 *     its own `'read'` group per design §3.2's `clk_read`/`clk_flag` split.
 *     `thread.set` (no dedicated group in the design) uses `'meta'`.
 */

import { generateId } from '@weldsuite/worker-kit/id';
import type { MailEmailAddress } from '@weldsuite/db/schema/mail-messages';
import {
  addLabels,
  CLEARED_BY_MOVE,
  folderKeys,
  type FolderKey,
  type LocationLabel,
  leaveLocation,
  normalizeLabel,
  OUTGOING_LABELS,
  removeLabels,
  SYSTEM_LABELS,
} from '../store/model';
import { bareSubject } from '../store/thread-match';
import { messageObjectKeys } from '../store/bodies';
import type { MailAddressBatchEntry } from '../mail-index/types';
import type { FlagPatch, IngestMessage, IngestResult, MailboxOp, MailboxRef, OpResult } from '../store/types';
import {
  type AttachmentRow,
  type ClockGroup,
  clockValue,
  fromBit,
  loadLiveThreadMessages,
  loadMessageRow,
  mapMessageRow,
  type MessageRow,
  parseJsonArray,
  parseJsonOrNull,
  toBit,
  toEpoch,
  toJson,
  toJsonOrNull,
} from './sql';
import { buildThreadSummary } from '../store/thread-summary';

// ---------------------------------------------------------------------------
// Storage surface this file needs (the real `ctx.storage`; a plain
// `{sql, transactionSync}` in tests — see `sql.ts`'s `MigratableStorage` for
// the same pattern).
// ---------------------------------------------------------------------------

export interface WritableStorage {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

export class MailboxOpNotImplementedError extends Error {
  constructor(kind: string) {
    super(`MailboxObject: op kind not implemented in writes.ts yet (design task B2): ${kind}`);
    this.name = 'MailboxOpNotImplementedError';
  }
}

function baseResult(partial: Partial<OpResult> = {}): OpResult {
  return { applied: [], missing: [], stale: [], ready: true, ...partial };
}

// ---------------------------------------------------------------------------
// Label/location composition (built from `../store/model`'s primitives —
// see the file comment above)
// ---------------------------------------------------------------------------

/**
 * Mirrors Postgres's `moveMessagesToLocation`: every other location (and
 * PROMOTIONS/SNOOZED) is dropped, the new one added once — except moving to
 * INBOX, which drops them all and only re-adds INBOX when the mail isn't
 * outgoing (`SENT`/`DRAFT`/`DRAFTS`/`SCHEDULED`).
 */
function moveLabels(existing: readonly string[], location: LocationLabel): string[] {
  if (location === SYSTEM_LABELS.INBOX) {
    const cleared = removeLabels([...existing], ...CLEARED_BY_MOVE);
    const isOutgoing = OUTGOING_LABELS.some((l) => cleared.includes(l));
    return isOutgoing ? cleared : addLabels(cleared, SYSTEM_LABELS.INBOX);
  }
  return addLabels([...existing], location);
}

/**
 * The mirrored boolean columns, derived fresh from the final labels array
 * every time (rather than tracked incrementally per touched label) — always
 * exactly consistent with `labels_json` by construction.
 */
function mirrorFlagsFromLabels(
  labels: readonly string[],
): Pick<MessageRow, 'starred' | 'important' | 'in_trash' | 'in_spam' | 'archived'> {
  return {
    starred: toBit(labels.includes(SYSTEM_LABELS.STARRED)),
    important: toBit(labels.includes(SYSTEM_LABELS.IMPORTANT)),
    in_trash: toBit(labels.includes(SYSTEM_LABELS.TRASH)),
    in_spam: toBit(labels.includes(SYSTEM_LABELS.SPAM)),
    archived: toBit(labels.includes(SYSTEM_LABELS.ARCHIVE)),
  };
}

function labelPatch(labels: readonly string[]): Partial<MessageRow> {
  return { labels_json: toJson(labels), ...mirrorFlagsFromLabels(labels) };
}

function folderKeysOfRow(row: Pick<MessageRow, 'deleted_at' | 'labels_json' | 'in_trash' | 'in_spam' | 'send_status'>): Set<FolderKey> {
  return new Set(
    folderKeys({
      deletedAt: row.deleted_at,
      labels: parseJsonArray<string>(row.labels_json),
      isTrash: row.in_trash === 1,
      isSpam: row.in_spam === 1,
      sendStatus: row.send_status,
    }),
  );
}

// ---------------------------------------------------------------------------
// message_labels (exact label membership, independent of folder filtering)
// ---------------------------------------------------------------------------

function diffMessageLabels(sql: SqlStorage, messageId: string, before: readonly string[], after: readonly string[]): void {
  const beforeKeys = new Set(before.map((l) => l.toLowerCase()));
  const afterKeys = new Set(after.map((l) => l.toLowerCase()));
  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) {
      sql.exec('INSERT OR IGNORE INTO message_labels (label_key, message_id) VALUES (?, ?)', key, messageId);
    }
  }
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) {
      sql.exec('DELETE FROM message_labels WHERE label_key = ? AND message_id = ?', key, messageId);
    }
  }
}

// ---------------------------------------------------------------------------
// label_counts / thread_labels maintenance (design §3.2 step 5)
// ---------------------------------------------------------------------------

interface LabelCountDelta {
  messages?: number;
  unread?: number;
  threads?: number;
}

/**
 * Upserts `label_counts`, clamped at 0 (defensive — correct accounting never
 * goes negative; mirrors Postgres's `GREATEST(0, …)`), then deletes the row if
 * it lands back at all-zero: an empty folder has nothing to show, and
 * `rebuildDerived` never creates a row for a key no live message currently
 * holds — without this cleanup, a label added and then removed would leave a
 * `0/0/0` "ghost" row the incremental path has but a rebuild doesn't.
 */
function bumpLabelCounts(sql: SqlStorage, key: FolderKey, delta: LabelCountDelta): void {
  const messages = delta.messages ?? 0;
  const unread = delta.unread ?? 0;
  const threads = delta.threads ?? 0;
  if (messages === 0 && unread === 0 && threads === 0) return;
  sql.exec(
    `INSERT INTO label_counts (label_key, messages, unread, threads) VALUES (?, ?, ?, ?)
     ON CONFLICT(label_key) DO UPDATE SET
       messages = MAX(0, label_counts.messages + excluded.messages),
       unread = MAX(0, label_counts.unread + excluded.unread),
       threads = MAX(0, label_counts.threads + excluded.threads)`,
    key,
    messages,
    unread,
    threads,
  );
  sql.exec('DELETE FROM label_counts WHERE label_key = ? AND messages = 0 AND unread = 0 AND threads = 0', key);
}

type ThreadLabelEffect = 'created' | 'removed' | 'none';

/** Adjusts `thread_labels.match_count` for `(key, threadKey)`, inserting/deleting the row on a 0⇄non-zero transition. */
function bumpThreadLabelMatch(sql: SqlStorage, key: FolderKey, threadKey: string, delta: number): ThreadLabelEffect {
  if (delta === 0) return 'none';
  const existing = sql
    .exec<{ match_count: number }>('SELECT match_count FROM thread_labels WHERE label_key = ? AND thread_key = ?', key, threadKey)
    .toArray()[0];
  const before = existing?.match_count ?? 0;
  const after = before + delta;
  if (after <= 0) {
    if (!existing) return 'none';
    sql.exec('DELETE FROM thread_labels WHERE label_key = ? AND thread_key = ?', key, threadKey);
    return 'removed';
  }
  if (existing) {
    sql.exec('UPDATE thread_labels SET match_count = ? WHERE label_key = ? AND thread_key = ?', after, key, threadKey);
    return 'none';
  }
  // `latest_at` is a placeholder (0): `refreshThread`, called right after by
  // every op that reaches here, overwrites it from the thread's live messages.
  sql.exec('INSERT INTO thread_labels (label_key, thread_key, latest_at, match_count) VALUES (?, ?, 0, ?)', key, threadKey, after);
  return 'created';
}

/**
 * Applies one message's folder-key membership change to `label_counts` and
 * `thread_labels` (design §3.2 step 5). `before`/`after` are the full
 * folder-key sets for the SAME thread — for a message changing thread
 * (`thread.set`), use `bumpThreadLabelMatch` directly instead (its before/after
 * threads differ, which this helper doesn't model).
 */
function applyFolderKeyDiff(
  sql: SqlStorage,
  before: ReadonlySet<FolderKey>,
  after: ReadonlySet<FolderKey>,
  threadKey: string,
  wasRead: boolean,
  isRead: boolean,
): void {
  const keys = new Set<FolderKey>([...before, ...after]);
  for (const key of keys) {
    const wasPresent = before.has(key);
    const isPresent = after.has(key);
    const wasUnread = wasPresent && !wasRead;
    const isUnread = isPresent && !isRead;
    const messagesDelta = (isPresent ? 1 : 0) - (wasPresent ? 1 : 0);
    const unreadDelta = (isUnread ? 1 : 0) - (wasUnread ? 1 : 0);
    if (messagesDelta !== 0 || unreadDelta !== 0) bumpLabelCounts(sql, key, { messages: messagesDelta, unread: unreadDelta });
    if (key === '__total' || key === '__scheduled' || messagesDelta === 0) continue;
    const effect = bumpThreadLabelMatch(sql, key, threadKey, messagesDelta);
    if (effect === 'created') bumpLabelCounts(sql, key, { threads: 1 });
    else if (effect === 'removed') bumpLabelCounts(sql, key, { threads: -1 });
  }
}

// ---------------------------------------------------------------------------
// threads (whole-thread recompute, design §3.2 "At the end of the op")
// ---------------------------------------------------------------------------

function upsertThreadRow(sql: SqlStorage, threadKey: string, summary: ReturnType<typeof buildThreadSummary>, at: number): void {
  const first = summary.messages[0]!;
  const latest = summary.messages.at(-1)!;
  sql.exec(
    `INSERT INTO threads (
       thread_key, latest_at, latest_message_id, first_message_id, subject, preview, latest_from_json,
       participants_json, labels_json, message_count, unread_count, has_attachments, is_starred,
       scheduled_for, send_status, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_key) DO UPDATE SET
       latest_at = excluded.latest_at, latest_message_id = excluded.latest_message_id,
       first_message_id = excluded.first_message_id, subject = excluded.subject, preview = excluded.preview,
       latest_from_json = excluded.latest_from_json, participants_json = excluded.participants_json,
       labels_json = excluded.labels_json, message_count = excluded.message_count,
       unread_count = excluded.unread_count, has_attachments = excluded.has_attachments,
       is_starred = excluded.is_starred, scheduled_for = excluded.scheduled_for,
       send_status = excluded.send_status, updated_at = excluded.updated_at`,
    threadKey,
    toEpoch(summary.latestDate) ?? at,
    summary.latestMessageId,
    first.id,
    summary.subject,
    summary.preview,
    toJsonOrNull(latest.from),
    toJson(summary.participants),
    toJson(summary.labels),
    summary.messageCount,
    summary.unreadCount,
    toBit(summary.hasAttachments),
    toBit(summary.isStarred),
    toEpoch(summary.scheduledFor),
    summary.sendStatus,
    at,
  );
  sql.exec('UPDATE thread_labels SET latest_at = ? WHERE thread_key = ?', toEpoch(summary.latestDate) ?? at, threadKey);
}

/**
 * Recomputes the `threads` row (and `thread_labels.latest_at`) of one thread
 * from its live messages, or deletes it when none are left.
 *
 * `threads.updated_at` is the MAX of the thread's live messages' own
 * `updated_at` — not the calling op's `at` — so it depends only on
 * `messages` and is reproducible by `rebuildDerived` from any `at` it is
 * given. Every op that reaches here already set the message's own
 * `updated_at` to that same `at` (`changeMessage`'s
 * `updated_at = MAX(updated_at, ?)`, or `ingest`'s insert), so this produces
 * the identical value in the normal (non-rebuild) case too.
 */
function refreshThread(sql: SqlStorage, ref: Pick<MailboxRef, 'accountId'>, threadKey: string): void {
  const rows = loadLiveThreadMessages(sql, threadKey);
  if (rows.length === 0) {
    sql.exec('DELETE FROM threads WHERE thread_key = ?', threadKey);
    return;
  }
  const records = rows.map((r) => mapMessageRow(r, ref));
  const summary = buildThreadSummary({ accountId: ref.accountId, threadId: threadKey }, records);
  // `rows` is non-empty here, so this is always defined — not the calling
  // op's `at` (see the file comment above for why).
  const updatedAt = Math.max(...rows.map((r) => r.updated_at));
  upsertThreadRow(sql, threadKey, summary, updatedAt);
}

// ---------------------------------------------------------------------------
// The generic single-message mutation (design §3.2's `changeMessage`)
// ---------------------------------------------------------------------------

type ChangeOutcome =
  | { status: 'missing' }
  | { status: 'stale' }
  | { status: 'applied'; row: MessageRow };

/**
 * Loads message `id`, checks the LWW clocks of `groups` against `at`
 * (`at < existing clock` ⇒ stale), applies `mutate`'s patch, diffs
 * `message_labels` and folder-key membership, writes the row, and refreshes
 * its thread. `mutate` returning `null` means "no change needed" (e.g. a
 * toggle already in the desired state) — still `'applied'`, just a no-op.
 */
function changeMessage(
  sql: SqlStorage,
  ref: Pick<MailboxRef, 'accountId'>,
  id: string,
  groups: readonly ClockGroup[],
  at: number,
  mutate: (row: MessageRow) => Partial<MessageRow> | null,
): ChangeOutcome {
  const row = loadMessageRow(sql, id);
  if (!row) return { status: 'missing' };
  for (const group of groups) {
    if (at < clockValue(row, group)) return { status: 'stale' };
  }
  const patch = mutate(row);
  if (!patch || Object.keys(patch).length === 0) return { status: 'applied', row };

  const before = folderKeysOfRow(row);
  const merged: MessageRow = { ...row, ...patch };
  const after = folderKeysOfRow(merged);

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of Object.entries(patch)) {
    sets.push(`${column} = ?`);
    params.push(value);
  }
  sets.push('updated_at = MAX(updated_at, ?)');
  params.push(at);
  for (const group of groups) {
    sets.push(`clk_${group} = ?`);
    params.push(at);
  }
  params.push(id);
  sql.exec(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, ...(params as SqlStorageValue[]));

  diffMessageLabels(sql, id, parseJsonArray<string>(row.labels_json), parseJsonArray<string>(merged.labels_json));
  applyFolderKeyDiff(sql, before, after, row.thread_key, row.is_read === 1, merged.is_read === 1);
  refreshThread(sql, ref, row.thread_key);

  return { status: 'applied', row: loadMessageRow(sql, id)! };
}

interface MultiOutcome {
  applied: string[];
  missing: string[];
  stale: string[];
  lastRow: MessageRow | null;
}

function applyToEach(
  sql: SqlStorage,
  ref: Pick<MailboxRef, 'accountId'>,
  ids: readonly string[],
  groups: readonly ClockGroup[],
  at: number,
  mutate: (row: MessageRow) => Partial<MessageRow> | null,
): MultiOutcome {
  const applied: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  let lastRow: MessageRow | null = null;
  for (const id of ids) {
    const outcome = changeMessage(sql, ref, id, groups, at, mutate);
    if (outcome.status === 'missing') missing.push(id);
    else if (outcome.status === 'stale') stale.push(id);
    else {
      applied.push(id);
      lastRow = outcome.row;
    }
  }
  return { applied, missing, stale, lastRow };
}

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

function flagGroups(patch: FlagPatch, semantics: 'single' | 'bulk'): ClockGroup[] {
  const groups = new Set<ClockGroup>();
  if (patch.isRead !== undefined) groups.add('read');
  if (patch.isFlagged !== undefined) groups.add('flag');
  if (patch.isStarred !== undefined || patch.isImportant !== undefined) groups.add('labels');
  if (patch.isSpam !== undefined || patch.isTrash !== undefined) {
    groups.add('labels');
    if (semantics === 'bulk') groups.add('snooze');
  }
  return [...groups];
}

/**
 * `'single'` mirrors `updateMessage`'s `labelsForFlagPatch` (leaving a
 * location restores it unless archived). `'bulk'` mirrors
 * `bulkUpdateMessages`'s `trash`/`restore` (always through
 * `moveMessagesToLocation`, which also clears a pending snooze). Entering a
 * location (`isSpam`/`isTrash: true`) is identical either way — `addLabels`
 * already does the "clear other locations, add this one" that
 * `moveMessagesToLocation` does — so the two semantics only diverge on the
 * way out of a location.
 */
function computeFlagPatch(row: MessageRow, patch: FlagPatch, semantics: 'single' | 'bulk'): Partial<MessageRow> | null {
  const out: Partial<MessageRow> = {};
  if (patch.isRead !== undefined) out.is_read = toBit(patch.isRead);
  if (patch.isFlagged !== undefined) out.is_flagged = toBit(patch.isFlagged);

  let labels = parseJsonArray<string>(row.labels_json);
  let labelsChanged = false;
  let resetSnooze = false;

  if (patch.isStarred !== undefined) {
    labels = patch.isStarred ? addLabels(labels, SYSTEM_LABELS.STARRED) : removeLabels(labels, SYSTEM_LABELS.STARRED);
    labelsChanged = true;
  }
  if (patch.isImportant !== undefined) {
    labels = patch.isImportant ? addLabels(labels, SYSTEM_LABELS.IMPORTANT) : removeLabels(labels, SYSTEM_LABELS.IMPORTANT);
    labelsChanged = true;
  }
  if (patch.isSpam !== undefined) {
    if (patch.isSpam) {
      labels = moveLabels(labels, SYSTEM_LABELS.SPAM);
      if (semantics === 'bulk') resetSnooze = true;
    } else if (semantics === 'single') {
      labels = leaveLocation(labels, SYSTEM_LABELS.SPAM);
    } else {
      labels = moveLabels(labels, SYSTEM_LABELS.INBOX);
      resetSnooze = true;
    }
    labelsChanged = true;
  }
  if (patch.isTrash !== undefined) {
    if (patch.isTrash) {
      labels = moveLabels(labels, SYSTEM_LABELS.TRASH);
      if (semantics === 'bulk') resetSnooze = true;
    } else if (semantics === 'single') {
      labels = leaveLocation(labels, SYSTEM_LABELS.TRASH);
    } else {
      labels = moveLabels(labels, SYSTEM_LABELS.INBOX);
      resetSnooze = true;
    }
    labelsChanged = true;
  }

  if (labelsChanged) Object.assign(out, labelPatch(labels));
  if (resetSnooze) out.snoozed_until = null;
  return Object.keys(out).length ? out : null;
}

function applyFlags(
  sql: SqlStorage,
  ref: MailboxRef,
  ids: readonly string[],
  patch: FlagPatch,
  semantics: 'single' | 'bulk',
  at: number,
): OpResult {
  const groups = flagGroups(patch, semantics);
  const { applied, missing, stale, lastRow } = applyToEach(sql, ref, ids, groups, at, (row) =>
    computeFlagPatch(row, patch, semantics),
  );
  const message = ids.length === 1 && lastRow ? mapMessageRow(lastRow, ref) : undefined;
  return baseResult({ applied, missing, stale, message });
}

// ---------------------------------------------------------------------------
// labels.set / labels.add / labels.remove
// ---------------------------------------------------------------------------

/**
 * `'single'` and `'bulk'` are semantically IDENTICAL for add/remove (unlike
 * `flags`): Postgres's `addMessageLabels`/`removeMessageLabels` (single) and
 * `bulkAddLabelToMessages`/`bulkRemoveLabelFromMessages` (bulk) both reduce to
 * plain `addLabels`/`removeLabels` + the mirrored flags — `bulkAddLabelToMessages`'s
 * special-cased redirect to `moveMessagesToLocation` for a location label
 * produces the exact same labels array `addLabels` already would. Removing a
 * location label never restores INBOX in either semantics (that's `flags`'s
 * `leaveLocation`/`moveLabels` job, not a plain label removal's).
 */
function applyLabelsAddRemove(
  sql: SqlStorage,
  ref: MailboxRef,
  ids: readonly string[],
  rawLabels: readonly string[],
  action: 'add' | 'remove',
  at: number,
): OpResult {
  const labels = rawLabels.map(normalizeLabel);
  const { applied, missing, stale, lastRow } = applyToEach(sql, ref, ids, ['labels'], at, (row) => {
    const current = parseJsonArray<string>(row.labels_json);
    const next = action === 'add' ? addLabels(current, ...labels) : removeLabels(current, ...labels);
    return labelPatch(next);
  });
  const message = ids.length === 1 && lastRow ? mapMessageRow(lastRow, ref) : undefined;
  return baseResult({ applied, missing, stale, message });
}

function applyLabelsSet(sql: SqlStorage, ref: MailboxRef, id: string, rawLabels: readonly string[], at: number): OpResult {
  const next = [...new Set(rawLabels.map(normalizeLabel))];
  const { applied, missing, stale, lastRow } = applyToEach(sql, ref, [id], ['labels'], at, () => labelPatch(next));
  const message = lastRow ? mapMessageRow(lastRow, ref) : undefined;
  return baseResult({ applied, missing, stale, message });
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

function applyMove(sql: SqlStorage, ref: MailboxRef, ids: readonly string[], location: LocationLabel, at: number): OpResult {
  const { applied, missing, stale, lastRow } = applyToEach(sql, ref, ids, ['labels', 'snooze'], at, (row) => {
    const next = moveLabels(parseJsonArray<string>(row.labels_json), location);
    return { ...labelPatch(next), snoozed_until: null };
  });
  const message = ids.length === 1 && lastRow ? mapMessageRow(lastRow, ref) : undefined;
  return baseResult({ applied, missing, stale, message });
}

// ---------------------------------------------------------------------------
// thread.label / thread.read / thread.set
// ---------------------------------------------------------------------------

function liveThreadMessageIds(sql: SqlStorage, threadKey: string): string[] {
  return sql.exec<{ id: string }>('SELECT id FROM messages WHERE thread_key = ? AND deleted_at IS NULL', threadKey).toArray().map((r) => r.id);
}

function applyThreadLabel(
  sql: SqlStorage,
  ref: MailboxRef,
  threadKey: string,
  label: string,
  action: 'add' | 'remove',
  at: number,
): OpResult {
  const ids = liveThreadMessageIds(sql, threadKey);
  const norm = normalizeLabel(label);
  const { applied, missing, stale } = applyToEach(sql, ref, ids, ['labels'], at, (row) => {
    const current = parseJsonArray<string>(row.labels_json);
    const next = action === 'add' ? addLabels(current, norm) : removeLabels(current, norm);
    return labelPatch(next);
  });
  return baseResult({ applied, missing, stale, updatedIds: applied });
}

function applyThreadRead(sql: SqlStorage, ref: MailboxRef, threadKey: string, isRead: boolean, at: number): OpResult {
  const rows = sql
    .exec<{ id: string; is_read: number }>('SELECT id, is_read FROM messages WHERE thread_key = ? AND deleted_at IS NULL', threadKey)
    .toArray();
  // Gate on change, like `markThreadRead`'s own `isRead = !next` WHERE clause:
  // an already-matching row is left alone (and not counted as touched).
  const ids = rows.filter((r) => fromBit(r.is_read) !== isRead).map((r) => r.id);
  const { applied, missing, stale } = applyToEach(sql, ref, ids, ['read'], at, () => ({ is_read: toBit(isRead) }));
  return baseResult({ applied, missing, stale, updatedIds: applied });
}

function applyThreadSet(sql: SqlStorage, ref: MailboxRef, id: string, threadId: string, at: number): OpResult {
  const row = loadMessageRow(sql, id);
  if (!row) return baseResult({ missing: [id] });
  if (at < row.clk_meta) return baseResult({ stale: [id] });

  const oldThreadKey = row.thread_key;
  const newThreadKey = threadId;
  if (oldThreadKey === newThreadKey) {
    return baseResult({ applied: [id], message: mapMessageRow(row, ref) });
  }

  // The message's OWN folder-key membership is unchanged (its labels/flags
  // don't change) — only which thread's aggregates count it. So this moves
  // `thread_labels.match_count` from the old thread to the new one directly,
  // rather than going through `applyFolderKeyDiff` (which assumes one thread).
  const keys = [...folderKeysOfRow(row)].filter((k) => k !== '__total' && k !== '__scheduled');
  for (const key of keys) {
    const effect = bumpThreadLabelMatch(sql, key, oldThreadKey, -1);
    if (effect === 'removed') bumpLabelCounts(sql, key, { threads: -1 });
  }

  sql.exec(
    'UPDATE messages SET thread_id = ?, thread_key = ?, updated_at = MAX(updated_at, ?), clk_meta = ? WHERE id = ?',
    threadId,
    newThreadKey,
    at,
    at,
    id,
  );

  for (const key of keys) {
    const effect = bumpThreadLabelMatch(sql, key, newThreadKey, 1);
    if (effect === 'created') bumpLabelCounts(sql, key, { threads: 1 });
  }

  refreshThread(sql, ref, oldThreadKey);
  refreshThread(sql, ref, newThreadKey);

  const after = loadMessageRow(sql, id)!;
  return baseResult({ applied: [id], message: mapMessageRow(after, ref) });
}

// ---------------------------------------------------------------------------
// delete (soft + hard)
// ---------------------------------------------------------------------------

function applySoftDelete(sql: SqlStorage, ref: MailboxRef, ids: readonly string[], at: number): OpResult {
  const { applied, missing, stale } = applyToEach(sql, ref, ids, ['delete'], at, (row) =>
    row.deleted_at !== null ? null : { deleted_at: at },
  );
  return baseResult({ applied, missing, stale });
}

function applyHardDelete(sql: SqlStorage, ref: MailboxRef, ids: readonly string[], at: number): OpResult {
  const applied: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  const storagePaths: string[] = [];

  for (const id of ids) {
    const row = loadMessageRow(sql, id);
    if (!row) {
      missing.push(id);
      continue;
    }
    if (at < row.clk_delete) {
      stale.push(id);
      continue;
    }
    const rowid = sql.exec<{ rowid: number }>('SELECT rowid FROM messages WHERE id = ?', id).toArray()[0]?.rowid;

    const before = folderKeysOfRow(row);
    applyFolderKeyDiff(sql, before, new Set<FolderKey>(), row.thread_key, row.is_read === 1, false);

    const attachments = sql
      .exec<Pick<AttachmentRow, 'storage_path'>>('SELECT storage_path FROM attachments WHERE message_id = ?', id)
      .toArray();
    for (const a of attachments) if (a.storage_path) storagePaths.push(a.storage_path);
    storagePaths.push(...messageObjectKeys({ workspaceId: ref.workspaceId, accountId: ref.accountId, messageId: id }));

    sql.exec('DELETE FROM attachments WHERE message_id = ?', id);
    sql.exec('DELETE FROM message_addresses WHERE message_id = ?', id);
    sql.exec('DELETE FROM message_labels WHERE message_id = ?', id);
    if (rowid !== undefined) {
      sql.exec('DELETE FROM messages_fts_meta WHERE rowid = ?', rowid);
      sql.exec('DELETE FROM messages_fts_body WHERE rowid = ?', rowid);
    }
    sql.exec('DELETE FROM messages WHERE id = ?', id);

    refreshThread(sql, ref, row.thread_key);
    applied.push(id);
  }

  return baseResult({ applied, missing, stale, storagePaths });
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

interface AddressEntry {
  address: string;
  role: 'from' | 'to' | 'cc' | 'bcc';
  name: string | null;
}

function addressEntries(
  from: MailEmailAddress,
  to: readonly MailEmailAddress[],
  cc: readonly MailEmailAddress[] | null | undefined,
  bcc: readonly MailEmailAddress[] | null | undefined,
): AddressEntry[] {
  const out: AddressEntry[] = [];
  const push = (role: AddressEntry['role'], list: readonly MailEmailAddress[]) => {
    for (const a of list) if (a?.email) out.push({ address: a.email.toLowerCase(), role, name: a.name ?? null });
  };
  push('from', [from]);
  push('to', to);
  push('cc', cc ?? []);
  push('bcc', bcc ?? []);
  return out;
}

function insertMessageAddresses(sql: SqlStorage, messageId: string, sentAt: number, entries: readonly AddressEntry[]): void {
  for (const entry of entries) {
    sql.exec(
      'INSERT OR IGNORE INTO message_addresses (address, sent_at, message_id, role, name) VALUES (?, ?, ?, ?, ?)',
      entry.address,
      sentAt,
      messageId,
      entry.role,
      entry.name,
    );
  }
}

function insertAttachmentRow(sql: SqlStorage, messageId: string, att: IngestMessage['attachments'][number], at: number): void {
  sql.exec(
    `INSERT INTO attachments (
       id, message_id, file_name, content_type, size, is_inline, content_id, content_disposition,
       checksum, storage_path, download_url, external_attachment_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    att.id,
    messageId,
    att.fileName,
    att.contentType ?? null,
    att.size,
    toBit(att.isInline),
    att.contentId ?? null,
    att.contentDisposition ?? null,
    att.checksum ?? null,
    att.storagePath ?? null,
    att.downloadUrl ?? null,
    at,
    at,
  );
}

/** Mirrors `upsertMailSubscription`'s `ON CONFLICT` set exactly (COALESCE for name/listId, overwrite for the unsubscribe targets, increment the count, MAX the last-received date). */
function upsertSubscription(sql: SqlStorage, sub: NonNullable<IngestMessage['subscription']>, at: number): void {
  sql.exec(
    `INSERT INTO subscriptions (
       id, sender_email, sender_name, sender_domain, list_id, unsubscribe_url, unsubscribe_mailto,
       one_click, message_count, last_subject, first_received_at, last_received_at, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(sender_email) DO UPDATE SET
       sender_name = COALESCE(excluded.sender_name, subscriptions.sender_name),
       list_id = COALESCE(excluded.list_id, subscriptions.list_id),
       unsubscribe_url = excluded.unsubscribe_url,
       unsubscribe_mailto = excluded.unsubscribe_mailto,
       one_click = excluded.one_click,
       message_count = subscriptions.message_count + 1,
       last_subject = excluded.last_subject,
       last_received_at = MAX(subscriptions.last_received_at, excluded.last_received_at),
       updated_at = excluded.updated_at`,
    generateId('msub'),
    sub.senderEmail,
    sub.senderName ?? null,
    sub.senderDomain ?? null,
    sub.listId ?? null,
    sub.unsubscribeUrl ?? null,
    sub.unsubscribeMailto ?? null,
    toBit(sub.oneClick),
    sub.lastSubject ?? null,
    toEpoch(sub.firstReceivedAt),
    toEpoch(sub.lastReceivedAt),
    at,
    at,
  );
}

function insertFtsRows(
  sql: SqlStorage,
  messageId: string,
  subject: string | null,
  from: MailEmailAddress,
  to: readonly MailEmailAddress[],
  cc: readonly MailEmailAddress[] | null | undefined,
  searchText: string | undefined,
): void {
  const rowid = sql.exec<{ rowid: number }>('SELECT rowid FROM messages WHERE id = ?', messageId).toArray()[0]?.rowid;
  if (rowid === undefined) return;
  const nameAndEmail = (a: MailEmailAddress) => [a.name, a.email].filter(Boolean).join(' ');
  const sender = nameAndEmail(from);
  const recipients = [...to, ...(cc ?? [])].map(nameAndEmail).join(' ');
  sql.exec('INSERT INTO messages_fts_meta (rowid, subject, sender, recipients) VALUES (?, ?, ?, ?)', rowid, subject ?? '', sender, recipients);
  sql.exec('INSERT INTO messages_fts_body (rowid, body) VALUES (?, ?)', rowid, searchText ?? '');
}

function bodyBitsOf(bodies: IngestMessage['bodies']): number {
  if (!bodies) return 0;
  return (bodies.html ? 1 : 0) | (bodies.text ? 2 : 0) | (bodies.raw ? 4 : 0);
}

/** Every participant address of a message, deduped and lower-cased — the ledger `address_index`'s input. */
function allParticipantAddresses(message: IngestMessage): string[] {
  const entries = addressEntries(message.from, message.to, message.cc, message.bcc);
  return [...new Set(entries.map((e) => e.address))];
}

function insertOutbox(sql: SqlStorage, kind: string, payload: unknown, at: number): void {
  sql.exec(
    'INSERT INTO outbox (kind, payload, attempts, next_attempt_at, created_at) VALUES (?, ?, 0, ?, ?)',
    kind,
    toJson(payload),
    at,
    at,
  );
}

function insertIngestOutboxRows(sql: SqlStorage, ref: MailboxRef, message: IngestMessage, threadKey: string, at: number): void {
  const ledgerEntry: MailAddressBatchEntry = {
    messageId: message.id,
    accountId: ref.accountId,
    at: message.sentAt,
    from: message.source === 'sent' ? null : message.from.email,
    addresses: allParticipantAddresses(message),
  };
  insertOutbox(sql, 'ledger.mail', ledgerEntry, at);
  insertOutbox(
    sql,
    'entity_event',
    {
      entityType: 'email',
      action: 'created',
      entityId: message.id,
      data: {
        id: message.id,
        accountId: ref.accountId,
        threadKey,
        subject: message.subject,
        isRead: message.isRead,
        labels: message.labels,
        sentAt: message.sentAt,
      },
    },
    at,
  );
}

function applyIngest(sql: SqlStorage, ref: MailboxRef, message: IngestMessage, at: number): OpResult {
  const existingById = loadMessageRow(sql, message.id);
  if (existingById) {
    const ingest: IngestResult = { id: message.id, threadKey: existingById.thread_key, created: false };
    return baseResult({ applied: [message.id], ingest, message: mapMessageRow(existingById, ref) });
  }

  if (message.source !== 'sent') {
    const dup = sql
      .exec<{ id: string; thread_key: string }>('SELECT id, thread_key FROM messages WHERE rfc_message_id = ? AND deleted_at IS NULL LIMIT 1', message.rfcMessageId)
      .toArray()[0];
    if (dup) {
      const ingest: IngestResult = { id: message.id, threadKey: dup.thread_key, created: false, duplicateOf: dup.id };
      return baseResult({ ingest });
    }
  }
  if (message.idempotencyKey) {
    const dup = sql
      .exec<{ id: string; thread_key: string }>('SELECT id, thread_key FROM messages WHERE idempotency_key = ? LIMIT 1', message.idempotencyKey)
      .toArray()[0];
    if (dup) {
      const ingest: IngestResult = { id: message.id, threadKey: dup.thread_key, created: false, duplicateOf: dup.id };
      return baseResult({ ingest });
    }
  }

  const labels = [...new Set(message.labels.map(normalizeLabel))];
  if (message.isSpam && !labels.includes(SYSTEM_LABELS.SPAM)) labels.push(SYSTEM_LABELS.SPAM);
  const threadKey = message.threadId ?? message.id;
  const sortAt = message.receivedAt ?? message.sentAt ?? message.createdAt;
  const subjectNorm = bareSubject(message.subject).toLowerCase() || null;
  const extra = message.extra;

  sql.exec(
    `INSERT INTO messages (
       id, rfc_message_id, external_message_id, provider_message_id, thread_id, thread_key, conversation_id,
       from_email, from_name, from_json, to_json, cc_json, bcc_json, reply_to_json,
       subject, subject_norm, preview, sent_at, received_at, sort_at,
       is_read, is_flagged, is_draft, is_reply, is_forwarded,
       labels_json, categories_json, in_trash, in_spam, archived, starred, important,
       has_attachments, attachment_count, in_reply_to, references_json, priority, size_bytes,
       spf_status, dkim_status, dmarc_status, source,
       send_status, scheduled_for, trigger_run_id, idempotency_key,
       snoozed_until, snoozed_at, unsnoozed_at, unsnoozed_early, resnoozed_at,
       delivery_status, delivery_detail, delivery_updated_at,
       body_bits, extra_json, created_at, updated_at, deleted_at,
       clk_read, clk_labels, clk_flag, clk_delete, clk_snooze, clk_send, clk_delivery, clk_meta
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, 0, 0, ?, ?,
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       NULL, NULL, NULL, NULL, NULL,
       ?, ?, ?,
       ?, ?, ?, ?, NULL,
       ?, ?, ?, ?, ?, ?, ?, ?
     )`,
    message.id,
    message.rfcMessageId,
    message.externalMessageId ?? null,
    message.providerMessageId ?? null,
    message.threadId,
    threadKey,
    extra?.conversationId ?? null,
    message.from.email,
    message.from.name ?? null,
    toJson(message.from),
    toJson(message.to),
    toJsonOrNull(message.cc),
    toJsonOrNull(message.bcc),
    toJsonOrNull(message.replyTo),
    message.subject,
    subjectNorm,
    message.preview,
    message.sentAt,
    message.receivedAt,
    sortAt,
    toBit(message.isRead),
    toBit(message.isReply),
    toBit(message.isForwarded ?? false),
    toJson(labels),
    null,
    toBit(labels.includes(SYSTEM_LABELS.TRASH)),
    toBit(labels.includes(SYSTEM_LABELS.SPAM)),
    toBit(labels.includes(SYSTEM_LABELS.ARCHIVE)),
    toBit(labels.includes(SYSTEM_LABELS.STARRED)),
    toBit(labels.includes(SYSTEM_LABELS.IMPORTANT)),
    toBit(message.attachments.length > 0),
    message.attachments.length,
    message.inReplyTo ?? null,
    toJsonOrNull(message.references),
    message.priority ?? null,
    message.sizeBytes ?? null,
    message.spfStatus ?? null,
    message.dkimStatus ?? null,
    message.dmarcStatus ?? null,
    message.source,
    message.sendStatus ?? null,
    message.scheduledFor ?? null,
    message.triggerRunId ?? null,
    message.idempotencyKey ?? null,
    message.delivery?.status ?? null,
    message.delivery?.detail ?? null,
    message.delivery?.at ?? null,
    bodyBitsOf(message.bodies),
    toJsonOrNull(extra),
    message.createdAt,
    message.createdAt,
    at,
    at,
    at,
    at,
    at,
    at,
    at,
    at,
  );

  for (const label of labels) sql.exec('INSERT OR IGNORE INTO message_labels (label_key, message_id) VALUES (?, ?)', label.toLowerCase(), message.id);
  insertMessageAddresses(sql, message.id, message.sentAt, addressEntries(message.from, message.to, message.cc, message.bcc));
  for (const attachment of message.attachments) insertAttachmentRow(sql, message.id, attachment, at);
  insertFtsRows(sql, message.id, message.subject, message.from, message.to, message.cc, message.searchText);
  if (message.subscription && !message.isSpam) upsertSubscription(sql, message.subscription, at);

  const keys = folderKeys({
    deletedAt: null,
    labels,
    isTrash: labels.includes(SYSTEM_LABELS.TRASH),
    isSpam: labels.includes(SYSTEM_LABELS.SPAM),
    sendStatus: message.sendStatus ?? null,
  });
  for (const key of keys) {
    bumpLabelCounts(sql, key, { messages: 1, unread: message.isRead ? 0 : 1 });
    if (key === '__total' || key === '__scheduled') continue;
    const effect = bumpThreadLabelMatch(sql, key, threadKey, 1);
    if (effect === 'created') bumpLabelCounts(sql, key, { threads: 1 });
  }
  refreshThread(sql, ref, threadKey);
  insertIngestOutboxRows(sql, ref, message, threadKey, at);

  const ingest: IngestResult = { id: message.id, threadKey, created: true };
  return baseResult({ applied: [message.id], ingest, message: mapMessageRow(loadMessageRow(sql, message.id)!, ref) });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function dispatch(sql: SqlStorage, ref: MailboxRef, op: MailboxOp, at: number): OpResult {
  switch (op.kind) {
    case 'ingest':
      return applyIngest(sql, ref, op.message, at);
    case 'flags':
      return applyFlags(sql, ref, op.ids, op.patch, op.semantics, at);
    case 'labels.set':
      return applyLabelsSet(sql, ref, op.id, op.labels, at);
    case 'labels.add':
      return applyLabelsAddRemove(sql, ref, op.ids, op.labels, 'add', at);
    case 'labels.remove':
      return applyLabelsAddRemove(sql, ref, op.ids, op.labels, 'remove', at);
    case 'move':
      return applyMove(sql, ref, op.ids, op.location, at);
    case 'thread.label':
      return applyThreadLabel(sql, ref, op.threadKey, op.label, op.action, at);
    case 'thread.read':
      return applyThreadRead(sql, ref, op.threadKey, op.isRead, at);
    case 'thread.set':
      return applyThreadSet(sql, ref, op.id, op.threadId, at);
    case 'delete':
      return op.hard ? applyHardDelete(sql, ref, op.ids, at) : applySoftDelete(sql, ref, op.ids, at);
    default:
      throw new MailboxOpNotImplementedError(op.kind);
  }
}

/** Applies one `MailboxOp` inside its own `transactionSync` (design §3.5 `apply`). */
export function applyMailboxOp(storage: WritableStorage, ref: MailboxRef, op: MailboxOp, at: number = Date.now()): OpResult {
  return storage.transactionSync(() => dispatch(storage.sql, ref, op, at));
}

/** `op` applied one at a time, each in its own `transactionSync` (design §3.5 `applyBatch`). */
export function applyMailboxBatch(storage: WritableStorage, ref: MailboxRef, ops: readonly MailboxOp[], at: number = Date.now()): OpResult[] {
  return ops.map((op) => applyMailboxOp(storage, ref, op, at));
}

// ---------------------------------------------------------------------------
// rebuildDerived
// ---------------------------------------------------------------------------

/**
 * Recomputes `threads`, `thread_labels`, `label_counts` and `message_addresses`
 * from `messages` + `message_labels` (design §3.2's closing bullet). Used by
 * maintenance (task C4) and by this task's property test, which asserts the
 * incrementally maintained tables already equal what a full rebuild produces.
 *
 * `message_labels` itself is a rebuild SOURCE, not a target — it's assumed
 * correct (it only ever changes alongside `messages.labels_json`, which this
 * function also doesn't touch).
 */
export function rebuildDerived(storage: WritableStorage, ref: MailboxRef, at: number = Date.now()): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec('DELETE FROM threads');
    sql.exec('DELETE FROM thread_labels');
    sql.exec('DELETE FROM label_counts');
    sql.exec('DELETE FROM message_addresses');

    const rows = sql.exec<MessageRow>('SELECT * FROM messages ORDER BY sort_at ASC').toArray();
    const threadKeys = new Set<string>();
    for (const row of rows) {
      threadKeys.add(row.thread_key);
      const from = parseJsonOrNull<MailEmailAddress>(row.from_json) ?? { email: row.from_email, name: row.from_name ?? undefined };
      insertMessageAddresses(
        sql,
        row.id,
        row.sent_at,
        addressEntries(from, parseJsonArray<MailEmailAddress>(row.to_json), parseJsonOrNull<MailEmailAddress[]>(row.cc_json), parseJsonOrNull<MailEmailAddress[]>(row.bcc_json)),
      );
      if (row.deleted_at) continue;

      const keys = folderKeysOfRow(row);
      for (const key of keys) {
        bumpLabelCounts(sql, key, { messages: 1, unread: row.is_read === 1 ? 0 : 1 });
        if (key === '__total' || key === '__scheduled') continue;
        const effect = bumpThreadLabelMatch(sql, key, row.thread_key, 1);
        if (effect === 'created') bumpLabelCounts(sql, key, { threads: 1 });
      }
    }
    for (const threadKey of threadKeys) refreshThread(sql, ref, threadKey);
  });
}
