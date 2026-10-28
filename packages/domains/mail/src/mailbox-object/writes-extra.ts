/**
 * `MailboxObject`'s remaining write ops (design §9 task B2, depends on B1's
 * `./writes`): snooze/resnooze/unsnooze/`snooze.wake`, `scheduled`,
 * `delivery.match`, `inbound.finalize`, `categories`, `label.rename`/
 * `label.delete`, `folder.read`, standalone `attachment.*`, `subscription.*`
 * and `draft.*`. Dispatched from `./writes`'s `dispatch()` via `applyExtraOp`
 * — see that file's header comment for the split rationale.
 *
 * Every op here reuses `./writes`'s mutation core (`changeMessage`,
 * `applyToEach`, `refreshThread`, `folderKeysOfRow`, `bumpLabelCounts`,
 * `bumpThreadLabelMatch`, `labelPatch`, `insertAttachmentRow`, `baseResult`)
 * instead of re-deriving label/folder semantics — those stay B1's one
 * implementation of docs/plans/weldmail-mailbox-store-design.md §3.2.
 *
 * Judgment calls made in this file (flagged for later tasks):
 *   - `inbound.finalize`'s `isRead`/`isFlagged`/`isSpam`/`deleted` fields are
 *     written as plain columns, exactly like the Postgres rule actions they
 *     come from (`SIMPLE_RULE_ACTIONS`, `markMessageAsSpam` in
 *     mail-inbound-worker's email-storage.ts) — independent of whatever ends
 *     up in `labels`. `starred`/`important`/`in_trash`/`archived` are instead
 *     re-derived from the final `labels` array (`labelPatch`), because unlike
 *     Postgres's `label_counts`/`thread_labels` equivalent (computed live at
 *     read time, with an OR-the-column fallback for exactly this kind of
 *     drift — `labelCondition` in `../labels.ts`), this object's `folderKeys`
 *     has no such fallback: a column that drifts from `labels_json` would
 *     silently stop showing up in its own folder. Columns that Postgres also
 *     derives from `labels_json` stay derived here; `isSpam` doesn't (matches
 *     Postgres's `markMessageAsSpam`, which always adds the `SPAM` label in
 *     the same write, so the two never actually diverge in practice).
 *   - `categories`'s optional `important` flag: `persistClassification`
 *     (mail-api's ai.ts) sets only the `isImportant` *column*, never the
 *     `IMPORTANT` label. For the same reason as above, this op instead adds
 *     or removes the `IMPORTANT` label (which also mirrors the column via
 *     `labelPatch`) — the one deliberate behaviour difference from Postgres
 *     in this file: an AI-marked-important message also gains the visible
 *     `IMPORTANT` folder membership here (today it only flips the column on
 *     Postgres, relying on that same OR-the-column fallback for `/important`
 *     to notice it at all).
 *   - `folder.read`'s `scope` only supports `labelSlug` plus `from`/
 *     `subject`/`hasAttachment`/`search` (search as a plain substring over
 *     subject+preview, not FTS). `to` and `excludeWords` are accepted by the
 *     type but not filtered on — no caller passes them today (`markFolderRead`
 *     is only ever invoked with `{labelSlug, accountId}`, per every route and
 *     test in mail-api's mail-threads route). Extend
 *     `liveUnreadIdsInScope` if a caller starts needing them.
 *   - `folder.read`'s `keepIds` is accepted on the op type but not used here:
 *     `OpResult.updatedIds` must stay the COMPLETE list (design: "every id,
 *     for the secondary"), so trimming to the newest N for a push belongs to
 *     the caller (`WorkspaceMailStore.markFolderRead`, task C2/C3), not to
 *     this op.
 *   - `label.rename`/`label.delete` recompute `label_counts`/`thread_labels`
 *     for just the touched key(s) from scratch (`rebuildFolderKeyAggregates`)
 *     rather than diffing incrementally. A rename's `to` name is assumed not
 *     to already be a label on the account (Postgres enforces that before
 *     calling this op: `updateMailLabel`'s `assertLabelNameAvailable`), but a
 *     full-rescan stays correct even if that assumption is ever violated,
 *     unlike incremental add/subtract arithmetic would.
 *   - `scheduled`'s patch never touches `sort_at`: B1's `applyIngest` is the
 *     only place that ever sets it (`COALESCE(receivedAt, sentAt, createdAt)`
 *     at ingest time), and nothing in B1 recomputes it afterwards either —
 *     `scheduled`'s `sentAt` patch follows that existing invariant rather than
 *     introducing a new one. A scheduled mail that transitions to sent keeps
 *     its original thread-list position until something else touches it; this
 *     is carried over from B1, not introduced here.
 */

import { generateId } from '@weldsuite/worker-kit/id';
import type { MailDeliveryStatus } from '@weldsuite/db/schema/mail-messages';
import { addLabels, normalizeLabel, removeLabels, SYSTEM_LABELS, toSystemLabel } from '../store/model';
import type { MailboxOp, MailboxRef, OpResult, ThreadFilter } from '../store/types';
import {
  type AttachmentRow,
  chunk,
  type ClockGroup,
  mapMessageRow,
  type MessageRow,
  parseJsonArray,
  placeholders,
  toBit,
  toEpoch,
  toJson,
  toJsonOrNull,
} from './sql';
import {
  applyToEach,
  baseResult,
  bumpLabelCounts,
  bumpThreadLabelMatch,
  changeMessage,
  folderKeysOfRow,
  insertAttachmentRow,
  labelPatch,
  MailboxOpNotImplementedError,
  refreshThread,
} from './writes';

// ---------------------------------------------------------------------------
// snooze / resnooze / unsnooze / snooze.wake
// ---------------------------------------------------------------------------

function applySnooze(sql: SqlStorage, ref: MailboxRef, id: string, until: number, at: number): OpResult {
  const outcome = changeMessage(sql, ref, id, ['labels', 'read', 'snooze'], at, (row) => {
    const labels = addLabels(removeLabels(parseJsonArray<string>(row.labels_json), SYSTEM_LABELS.INBOX), SYSTEM_LABELS.SNOOZED);
    return { ...labelPatch(labels), is_read: 1, snoozed_until: until, snoozed_at: at };
  });
  if (outcome.status === 'missing') return baseResult({ missing: [id] });
  if (outcome.status === 'stale') return baseResult({ stale: [id] });
  return baseResult({ applied: [id], message: mapMessageRow(outcome.row, ref) });
}

function applyResnooze(sql: SqlStorage, ref: MailboxRef, id: string, until: number, at: number): OpResult {
  const outcome = changeMessage(sql, ref, id, ['snooze'], at, () => ({ snoozed_until: until, resnoozed_at: at }));
  if (outcome.status === 'missing') return baseResult({ missing: [id] });
  if (outcome.status === 'stale') return baseResult({ stale: [id] });
  return baseResult({ applied: [id], message: mapMessageRow(outcome.row, ref) });
}

function applyUnsnooze(sql: SqlStorage, ref: MailboxRef, id: string, at: number): OpResult {
  const outcome = changeMessage(sql, ref, id, ['labels', 'read', 'snooze'], at, (row) => {
    const labels = addLabels(removeLabels(parseJsonArray<string>(row.labels_json), SYSTEM_LABELS.SNOOZED), SYSTEM_LABELS.INBOX);
    return { ...labelPatch(labels), is_read: 0, snoozed_until: null, unsnoozed_at: at, unsnoozed_early: 1 };
  });
  if (outcome.status === 'missing') return baseResult({ missing: [id] });
  if (outcome.status === 'stale') return baseResult({ stale: [id] });
  return baseResult({ applied: [id], message: mapMessageRow(outcome.row, ref) });
}

/** The next `snoozed_until` still pending in this mailbox (mirrors `snooze.ts`'s `nextSnoozeDueAt`, scoped to one mailbox). */
function nextSnoozeDueAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ next: number | null }>(
      `SELECT MIN(m.snoozed_until) AS next FROM messages m
       JOIN message_labels ml ON ml.message_id = m.id AND ml.label_key = 'snoozed'
       WHERE m.deleted_at IS NULL AND m.snoozed_until IS NOT NULL`,
    )
    .toArray()[0];
  return row?.next ?? null;
}

/** Wake every snoozed message in this mailbox whose time has come (design §3.2, §3.6). */
function applySnoozeWake(sql: SqlStorage, ref: MailboxRef, now: number, at: number): OpResult {
  const ids = sql
    .exec<{ id: string }>(
      `SELECT m.id FROM messages m
       JOIN message_labels ml ON ml.message_id = m.id AND ml.label_key = 'snoozed'
       WHERE m.deleted_at IS NULL AND m.snoozed_until IS NOT NULL AND m.snoozed_until <= ?`,
      now,
    )
    .toArray()
    .map((r) => r.id);

  const { applied, missing, stale } = applyToEach(sql, ref, ids, ['labels', 'read', 'snooze'], at, (row) => {
    const labels = addLabels(
      removeLabels(parseJsonArray<string>(row.labels_json), SYSTEM_LABELS.SNOOZED, SYSTEM_LABELS.INBOX),
      SYSTEM_LABELS.INBOX,
    );
    return { ...labelPatch(labels), is_read: 0, snoozed_until: null, unsnoozed_at: at, unsnoozed_early: 0 };
  });
  return baseResult({ applied, missing, stale, updatedIds: applied, nextSnoozeDueAt: nextSnoozeDueAt(sql) });
}

// ---------------------------------------------------------------------------
// scheduled
// ---------------------------------------------------------------------------

type ScheduledOp = Extract<MailboxOp, { kind: 'scheduled' }>;

function applyScheduled(sql: SqlStorage, ref: MailboxRef, op: ScheduledOp, at: number): OpResult {
  const { patch } = op;
  const groups = new Set<ClockGroup>();
  if (
    patch.sendStatus !== undefined ||
    patch.scheduledFor !== undefined ||
    patch.triggerRunId !== undefined ||
    patch.sentAt !== undefined ||
    patch.externalMessageId !== undefined
  ) {
    groups.add('send');
  }
  if (patch.dropScheduledLabel) groups.add('labels');
  if (patch.softDelete) groups.add('delete');
  if (patch.delivery) groups.add('delivery');
  if (groups.size === 0) groups.add('send'); // an empty patch still needs a group to gate on

  const outcome = changeMessage(sql, ref, op.id, [...groups], at, (row) => {
    const next: Partial<MessageRow> = {};
    if (patch.sendStatus !== undefined) next.send_status = patch.sendStatus;
    if (patch.scheduledFor !== undefined) next.scheduled_for = patch.scheduledFor;
    if (patch.triggerRunId !== undefined) next.trigger_run_id = patch.triggerRunId;
    if (patch.sentAt !== undefined) next.sent_at = patch.sentAt;
    if (patch.externalMessageId !== undefined) next.external_message_id = patch.externalMessageId;
    if (patch.dropScheduledLabel) {
      const labels = removeLabels(parseJsonArray<string>(row.labels_json), SYSTEM_LABELS.SCHEDULED);
      Object.assign(next, labelPatch(labels));
    }
    if (patch.softDelete && row.deleted_at === null) next.deleted_at = at;
    if (patch.delivery) {
      next.delivery_status = patch.delivery.status;
      next.delivery_detail = patch.delivery.detail;
      next.delivery_updated_at = at;
    }
    return Object.keys(next).length ? next : null;
  });
  if (outcome.status === 'missing') return baseResult({ missing: [op.id] });
  if (outcome.status === 'stale') return baseResult({ stale: [op.id] });
  return baseResult({ applied: [op.id], message: mapMessageRow(outcome.row, ref) });
}

// ---------------------------------------------------------------------------
// delivery.match
// ---------------------------------------------------------------------------

/** A later event may only replace an equal or weaker status (mirrors `delivery-events.ts`'s `STATUS_RANK`). */
const STATUS_RANK: Record<MailDeliveryStatus, number> = {
  deferred: 0,
  delivered: 1,
  failed: 2,
  rejected: 2,
  bounced: 3,
  complained: 4,
};

type DeliveryMatchOp = Extract<MailboxOp, { kind: 'delivery.match' }>;

/**
 * Finds the latest SENT copy to `recipient` in the window
 * `[eventAt - 3d, eventAt + 1h]` (design §3.2, mirrors `markSentCopy`
 * exactly) and applies the delivery status, content-ranked so a complaint
 * can't be overwritten by an earlier "delivered".
 */
function applyDeliveryMatch(sql: SqlStorage, ref: MailboxRef, op: DeliveryMatchOp, at: number): OpResult {
  const windowStart = op.eventAt - 3 * 86_400_000;
  const windowEnd = op.eventAt + 3_600_000;
  const match = sql
    .exec<{ message_id: string }>(
      `SELECT ma.message_id FROM message_addresses ma
       JOIN messages m ON m.id = ma.message_id
       WHERE ma.address = ? AND ma.role IN ('to', 'cc', 'bcc')
         AND m.source = 'sent' AND m.sent_at BETWEEN ? AND ?
       ORDER BY m.sent_at DESC LIMIT 1`,
      op.recipient.toLowerCase(),
      windowStart,
      windowEnd,
    )
    .toArray()[0];
  if (!match) return baseResult();

  const outcome = changeMessage(sql, ref, match.message_id, ['delivery'], at, (row) => {
    const current = row.delivery_status as MailDeliveryStatus | null;
    if (current && STATUS_RANK[current] > STATUS_RANK[op.status]) return null;
    return { delivery_status: op.status, delivery_detail: op.detail, delivery_updated_at: op.eventAt };
  });
  if (outcome.status === 'missing') return baseResult();
  if (outcome.status === 'stale') return baseResult({ stale: [match.message_id] });
  return baseResult({ applied: [match.message_id], message: mapMessageRow(outcome.row, ref) });
}

// ---------------------------------------------------------------------------
// inbound.finalize
// ---------------------------------------------------------------------------

type InboundFinalizeOp = Extract<MailboxOp, { kind: 'inbound.finalize' }>;

function applyInboundFinalize(sql: SqlStorage, ref: MailboxRef, op: InboundFinalizeOp, at: number): OpResult {
  const groups: ClockGroup[] = ['labels', 'read', 'flag'];
  if (op.deleted) groups.push('delete');

  const outcome = changeMessage(sql, ref, op.id, groups, at, (row) => {
    const labels = [...new Set(op.labels.map(normalizeLabel))];
    const next: Partial<MessageRow> = {
      ...labelPatch(labels),
      in_spam: toBit(op.isSpam), // plain column, independent of `labels` — see the file comment above
      is_read: toBit(op.isRead),
      is_flagged: toBit(op.isFlagged),
    };
    if (op.deleted && row.deleted_at === null) next.deleted_at = at;
    return next;
  });
  if (outcome.status === 'missing') return baseResult({ missing: [op.id] });
  if (outcome.status === 'stale') return baseResult({ stale: [op.id] });
  return baseResult({ applied: [op.id], message: mapMessageRow(outcome.row, ref) });
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

type CategoriesOp = Extract<MailboxOp, { kind: 'categories' }>;

function applyCategories(sql: SqlStorage, ref: MailboxRef, op: CategoriesOp, at: number): OpResult {
  const groups: ClockGroup[] = ['meta'];
  if (op.important !== undefined) groups.push('labels');

  const outcome = changeMessage(sql, ref, op.id, groups, at, (row) => {
    const next: Partial<MessageRow> = { categories_json: toJson(op.categories) };
    if (op.important !== undefined) {
      const current = parseJsonArray<string>(row.labels_json);
      const labels = op.important ? addLabels(current, SYSTEM_LABELS.IMPORTANT) : removeLabels(current, SYSTEM_LABELS.IMPORTANT);
      Object.assign(next, labelPatch(labels));
    }
    return next;
  });
  if (outcome.status === 'missing') return baseResult({ missing: [op.id] });
  if (outcome.status === 'stale') return baseResult({ stale: [op.id] });
  return baseResult({ applied: [op.id], message: mapMessageRow(outcome.row, ref) });
}

// ---------------------------------------------------------------------------
// label.rename / label.delete
// ---------------------------------------------------------------------------

/**
 * Recomputes `label_counts`/`thread_labels` for exactly `keys` from the live
 * `messages`/`message_labels` rows (a full rescan of this mailbox, not an
 * incremental diff — see the file comment above for why).
 */
function rebuildFolderKeyAggregates(sql: SqlStorage, keys: readonly string[]): void {
  for (const key of keys) {
    sql.exec('DELETE FROM label_counts WHERE label_key = ?', key);
    sql.exec('DELETE FROM thread_labels WHERE label_key = ?', key);
  }
  const rows = sql.exec<MessageRow>('SELECT * FROM messages WHERE deleted_at IS NULL').toArray();
  for (const row of rows) {
    const rowKeys = folderKeysOfRow(row);
    for (const key of keys) {
      if (!rowKeys.has(key)) continue;
      bumpLabelCounts(sql, key, { messages: 1, unread: row.is_read === 1 ? 0 : 1 });
      const effect = bumpThreadLabelMatch(sql, key, row.thread_key, 1);
      if (effect === 'created') bumpLabelCounts(sql, key, { threads: 1 });
    }
  }
}

type LabelRenameOp = Extract<MailboxOp, { kind: 'label.rename' }>;

function applyLabelRename(sql: SqlStorage, ref: MailboxRef, op: LabelRenameOp, at: number): OpResult {
  const fromKey = op.from.toLowerCase();
  const toKey = op.to.toLowerCase();
  if (fromKey === toKey) return baseResult();

  const rows = sql
    .exec<{ id: string; labels_json: string; thread_key: string }>(
      `SELECT m.id, m.labels_json, m.thread_key FROM messages m
       JOIN message_labels ml ON ml.message_id = m.id AND ml.label_key = ?
       WHERE m.deleted_at IS NULL`,
      fromKey,
    )
    .toArray();

  const applied: string[] = [];
  const threadKeys = new Set<string>();
  for (const row of rows) {
    const labels = parseJsonArray<string>(row.labels_json).map((l) => (l.toLowerCase() === fromKey ? op.to : l));
    sql.exec('UPDATE messages SET labels_json = ?, updated_at = MAX(updated_at, ?) WHERE id = ?', toJson(labels), at, row.id);
    applied.push(row.id);
    threadKeys.add(row.thread_key);
  }

  sql.exec('INSERT OR IGNORE INTO message_labels (label_key, message_id) SELECT ?, message_id FROM message_labels WHERE label_key = ?', toKey, fromKey);
  sql.exec('DELETE FROM message_labels WHERE label_key = ?', fromKey);

  rebuildFolderKeyAggregates(sql, [fromKey, toKey]);
  for (const threadKey of threadKeys) refreshThread(sql, ref, threadKey);

  return baseResult({ applied });
}

type LabelDeleteOp = Extract<MailboxOp, { kind: 'label.delete' }>;

function applyLabelDelete(sql: SqlStorage, ref: MailboxRef, op: LabelDeleteOp, at: number): OpResult {
  const key = op.name.toLowerCase();
  const rows = sql
    .exec<{ id: string; labels_json: string; thread_key: string }>(
      `SELECT m.id, m.labels_json, m.thread_key FROM messages m
       JOIN message_labels ml ON ml.message_id = m.id AND ml.label_key = ?
       WHERE m.deleted_at IS NULL`,
      key,
    )
    .toArray();

  const applied: string[] = [];
  const threadKeys = new Set<string>();
  for (const row of rows) {
    const labels = parseJsonArray<string>(row.labels_json).filter((l) => l.toLowerCase() !== key);
    sql.exec('UPDATE messages SET labels_json = ?, updated_at = MAX(updated_at, ?) WHERE id = ?', toJson(labels), at, row.id);
    applied.push(row.id);
    threadKeys.add(row.thread_key);
  }

  sql.exec('DELETE FROM message_labels WHERE label_key = ?', key);
  rebuildFolderKeyAggregates(sql, [key]);
  for (const threadKey of threadKeys) refreshThread(sql, ref, threadKey);

  return baseResult({ applied });
}

// ---------------------------------------------------------------------------
// folder.read
// ---------------------------------------------------------------------------

/**
 * Unread, live message ids matching `scope`, newest first — see the file
 * comment above for which `ThreadFilter` fields this supports.
 */
function liveUnreadIdsInScope(sql: SqlStorage, scope: ThreadFilter, limit: number): string[] {
  const conditions: string[] = ['m.deleted_at IS NULL', 'm.is_read = 0'];
  const params: (string | number)[] = [];
  let join = '';

  const slug = scope.labelSlug.toLowerCase();
  if (slug === 'all' || slug === '__all') {
    conditions.push('m.in_trash = 0', 'm.in_spam = 0');
  } else {
    const system = toSystemLabel(scope.labelSlug);
    const key = system ? system.toLowerCase() : slug;
    join = 'JOIN message_labels ml ON ml.message_id = m.id AND ml.label_key = ?';
    params.push(key);
    if (key !== 'trash' && key !== 'spam') {
      conditions.push('m.in_trash = 0', 'm.in_spam = 0');
      if (!system) conditions.push('m.archived = 0'); // a custom label's folder hides archived mail, like `labelFolderHidesArchived`
    }
  }

  if (scope.from) {
    conditions.push("(LOWER(m.from_email) LIKE ? OR LOWER(COALESCE(m.from_name, '')) LIKE ?)");
    const p = `%${scope.from.toLowerCase()}%`;
    params.push(p, p);
  }
  if (scope.subject) {
    conditions.push("LOWER(COALESCE(m.subject, '')) LIKE ?");
    params.push(`%${scope.subject.toLowerCase()}%`);
  }
  if (scope.hasAttachment) conditions.push('m.has_attachments = 1');
  if (scope.search) {
    conditions.push("(LOWER(COALESCE(m.subject, '')) LIKE ? OR LOWER(COALESCE(m.preview, '')) LIKE ?)");
    const p = `%${scope.search.toLowerCase()}%`;
    params.push(p, p);
  }

  const sqlText = `SELECT m.id FROM messages m ${join} WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(m.received_at, m.sent_at) DESC LIMIT ?`;
  params.push(limit);
  return sql
    .exec<{ id: string }>(sqlText, ...(params as SqlStorageValue[]))
    .toArray()
    .map((r) => r.id);
}

type FolderReadOp = Extract<MailboxOp, { kind: 'folder.read' }>;

/**
 * Marks every unread message matching `op.scope` as read, in bounded,
 * resumable batches (design §3.2, §3.6; task description's "folder.read on a
 * huge folder doesn't hold the object for long"). Each batch re-queries the
 * unread set — marked rows drop out of it — so no cursor is needed: `more`
 * tells the caller whether to call this op again.
 */
function applyFolderRead(sql: SqlStorage, ref: MailboxRef, op: FolderReadOp, at: number): OpResult {
  const batchSize = op.batchSize ?? 1000;
  const maxBatches = op.maxBatches ?? 50;
  const updatedIds: string[] = [];
  let more = false;

  for (let i = 0; i < maxBatches; i++) {
    const ids = liveUnreadIdsInScope(sql, op.scope, batchSize);
    if (ids.length === 0) {
      more = false;
      break;
    }
    const { applied } = applyToEach(sql, ref, ids, ['read'], at, () => ({ is_read: 1 }));
    updatedIds.push(...applied);
    more = ids.length >= batchSize;
    if (!more) break;
  }

  return baseResult({ applied: updatedIds, updatedIds, more });
}

// ---------------------------------------------------------------------------
// attachment.create / attachment.update / attachment.delete / attachment.associate
// ---------------------------------------------------------------------------

function loadAttachmentRow(sql: SqlStorage, id: string): AttachmentRow | null {
  return sql.exec<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id).toArray()[0] ?? null;
}

/** `{attachment_count, has_attachments}` from the parent message's live attachment rows (mirrors `refreshMessageAttachmentCount`). */
function attachmentCountPatch(sql: SqlStorage, messageId: string): Partial<MessageRow> {
  const row = sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM attachments WHERE message_id = ? AND deleted_at IS NULL', messageId).toArray()[0];
  const count = row?.c ?? 0;
  return { attachment_count: count, has_attachments: toBit(count > 0) };
}

/** Refreshes a message's attachment-count mirror; a no-op (not an error) when the message doesn't exist. */
function refreshAttachmentCount(sql: SqlStorage, ref: MailboxRef, messageId: string, at: number): void {
  changeMessage(sql, ref, messageId, ['meta'], at, () => attachmentCountPatch(sql, messageId));
}

type AttachmentCreateOp = Extract<MailboxOp, { kind: 'attachment.create' }>;

function applyAttachmentCreate(sql: SqlStorage, ref: MailboxRef, op: AttachmentCreateOp, at: number): OpResult {
  const existing = loadAttachmentRow(sql, op.attachment.id);
  if (existing) return baseResult({ applied: [op.attachment.id] }); // idempotent replay, like `ingest`
  insertAttachmentRow(sql, op.attachment.messageId, op.attachment, at);
  refreshAttachmentCount(sql, ref, op.attachment.messageId, at);
  return baseResult({ applied: [op.attachment.id] });
}

const ATTACHMENT_PATCH_COLUMNS: Record<string, string> = {
  messageId: 'message_id',
  fileName: 'file_name',
  contentType: 'content_type',
  size: 'size',
  storagePath: 'storage_path',
  downloadUrl: 'download_url',
  checksum: 'checksum',
  isInline: 'is_inline',
  contentId: 'content_id',
  contentDisposition: 'content_disposition',
};

type AttachmentUpdateOp = Extract<MailboxOp, { kind: 'attachment.update' }>;

function applyAttachmentUpdate(sql: SqlStorage, ref: MailboxRef, op: AttachmentUpdateOp, at: number): OpResult {
  const existing = loadAttachmentRow(sql, op.id);
  if (!existing) return baseResult({ missing: [op.id] });

  const sets: string[] = [];
  const params: SqlStorageValue[] = [];
  for (const [key, value] of Object.entries(op.patch)) {
    if (value === undefined) continue;
    const column = ATTACHMENT_PATCH_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    params.push(key === 'isInline' ? toBit(value as boolean) : (value as SqlStorageValue));
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    params.push(at);
    params.push(op.id);
    sql.exec(`UPDATE attachments SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }

  const nextMessageId = op.patch.messageId;
  if (nextMessageId && nextMessageId !== existing.message_id) {
    refreshAttachmentCount(sql, ref, existing.message_id, at);
    refreshAttachmentCount(sql, ref, nextMessageId, at);
  }
  return baseResult({ applied: [op.id] });
}

type AttachmentDeleteOp = Extract<MailboxOp, { kind: 'attachment.delete' }>;

function applyAttachmentDelete(sql: SqlStorage, ref: MailboxRef, op: AttachmentDeleteOp, at: number): OpResult {
  const existing = loadAttachmentRow(sql, op.id);
  if (!existing || existing.deleted_at !== null) return baseResult({ missing: [op.id] });
  sql.exec('UPDATE attachments SET deleted_at = ?, updated_at = ? WHERE id = ?', at, at, op.id);
  refreshAttachmentCount(sql, ref, existing.message_id, at);
  return baseResult({ applied: [op.id], storagePaths: existing.storage_path ? [existing.storage_path] : [] });
}

type AttachmentAssociateOp = Extract<MailboxOp, { kind: 'attachment.associate' }>;

function applyAttachmentAssociate(sql: SqlStorage, ref: MailboxRef, op: AttachmentAssociateOp, at: number): OpResult {
  if (op.attachmentIds.length === 0) return baseResult();
  for (const part of chunk(op.attachmentIds)) {
    sql.exec(
      `UPDATE attachments SET message_id = ?, updated_at = ? WHERE id IN (${placeholders(part.length)}) AND deleted_at IS NULL`,
      op.messageId,
      at,
      ...part,
    );
  }
  refreshAttachmentCount(sql, ref, op.messageId, at);
  return baseResult({ applied: [op.messageId] });
}

// ---------------------------------------------------------------------------
// subscription.upsert / subscription.status
// ---------------------------------------------------------------------------

type SubscriptionUpsertOp = Extract<MailboxOp, { kind: 'subscription.upsert' }>;

/**
 * Mirrors `scanSubscriptions`'s backfill upsert exactly — NOT `upsertSubscription`
 * (B1's per-ingest bump): `messageCount`/`firstReceivedAt` take the
 * GREATEST/LEAST of the existing row and the aggregate, every other field is
 * left alone on conflict (only an insert sets them).
 */
function applySubscriptionsUpsert(sql: SqlStorage, _ref: MailboxRef, op: SubscriptionUpsertOp, at: number): OpResult {
  const applied: string[] = [];
  for (const agg of op.values) {
    const existing = sql
      .exec<{ id: string; message_count: number; first_received_at: number }>(
        'SELECT id, message_count, first_received_at FROM subscriptions WHERE sender_email = ?',
        agg.senderEmail,
      )
      .toArray()[0];
    if (existing) {
      const messageCount = Math.max(existing.message_count, agg.messageCount);
      const firstReceivedAt = Math.min(existing.first_received_at, agg.firstReceivedAt.getTime());
      sql.exec(
        'UPDATE subscriptions SET message_count = ?, first_received_at = ?, updated_at = ? WHERE id = ?',
        messageCount,
        firstReceivedAt,
        at,
        existing.id,
      );
      applied.push(existing.id);
    } else {
      const id = generateId('msub');
      sql.exec(
        `INSERT INTO subscriptions (
           id, sender_email, sender_name, sender_domain, list_id, unsubscribe_url, unsubscribe_mailto,
           one_click, message_count, last_subject, first_received_at, last_received_at, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        id,
        agg.senderEmail,
        agg.senderName ?? null,
        agg.senderDomain ?? null,
        agg.listId ?? null,
        agg.unsubscribeUrl ?? null,
        agg.unsubscribeMailto ?? null,
        toBit(agg.oneClick),
        agg.messageCount,
        agg.lastSubject ?? null,
        toEpoch(agg.firstReceivedAt),
        toEpoch(agg.lastReceivedAt),
        at,
        at,
      );
      applied.push(id);
    }
  }
  return baseResult({ applied });
}

type SubscriptionStatusOp = Extract<MailboxOp, { kind: 'subscription.status' }>;

function applySubscriptionStatus(sql: SqlStorage, _ref: MailboxRef, op: SubscriptionStatusOp, at: number): OpResult {
  const existing = sql.exec<{ id: string }>('SELECT id FROM subscriptions WHERE id = ?', op.id).toArray()[0];
  if (!existing) return baseResult({ missing: [op.id] });
  sql.exec(
    'UPDATE subscriptions SET status = ?, unsubscribe_method = ?, unsubscribed_at = ?, unsubscribed_by = ?, updated_at = ? WHERE id = ?',
    op.patch.status,
    op.patch.method,
    op.patch.at,
    op.patch.by,
    at,
    op.id,
  );
  return baseResult({ applied: [op.id] });
}

// ---------------------------------------------------------------------------
// draft.create / draft.update / draft.delete
// ---------------------------------------------------------------------------

type DraftCreateOp = Extract<MailboxOp, { kind: 'draft.create' }>;

function applyDraftCreate(sql: SqlStorage, _ref: MailboxRef, op: DraftCreateOp, at: number): OpResult {
  const existing = sql.exec<{ id: string }>('SELECT id FROM drafts WHERE id = ?', op.draft.id).toArray()[0];
  if (existing) return baseResult({ applied: [op.draft.id] }); // idempotent replay, like `ingest`

  const d = op.draft;
  const attachmentIds = d.attachmentIds ?? [];
  sql.exec(
    `INSERT INTO drafts (
       id, subject, to_json, cc_json, bcc_json, reply_to_json, body, html_body, importance,
       labels_json, attachment_ids_json, in_reply_to, original_message_id, is_reply, is_forward,
       has_attachments, attachment_count, last_auto_saved_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.id,
    d.subject ?? null,
    toJsonOrNull(d.to),
    toJsonOrNull(d.cc),
    toJsonOrNull(d.bcc),
    toJsonOrNull(d.replyTo),
    d.body ?? null,
    d.htmlBody ?? null,
    d.importance ?? null,
    toJsonOrNull(d.labels),
    toJsonOrNull(attachmentIds),
    d.inReplyTo ?? null,
    d.originalMessageId ?? null,
    d.isReply === undefined ? null : toBit(d.isReply),
    d.isForward === undefined ? null : toBit(d.isForward),
    toBit(attachmentIds.length > 0),
    attachmentIds.length,
    at,
    at,
    at,
  );
  return baseResult({ applied: [d.id] });
}

const DRAFT_PATCH_COLUMNS: Record<string, string> = {
  subject: 'subject',
  body: 'body',
  htmlBody: 'html_body',
  importance: 'importance',
  inReplyTo: 'in_reply_to',
  originalMessageId: 'original_message_id',
};
const DRAFT_PATCH_JSON_COLUMNS: Record<string, string> = {
  to: 'to_json',
  cc: 'cc_json',
  bcc: 'bcc_json',
  replyTo: 'reply_to_json',
  labels: 'labels_json',
};
const DRAFT_PATCH_BIT_COLUMNS: Record<string, string> = {
  isReply: 'is_reply',
  isForward: 'is_forward',
};

type DraftUpdateOp = Extract<MailboxOp, { kind: 'draft.update' }>;

function applyDraftUpdate(sql: SqlStorage, _ref: MailboxRef, op: DraftUpdateOp, at: number): OpResult {
  const existing = sql.exec<{ id: string; deleted_at: number | null }>('SELECT id, deleted_at FROM drafts WHERE id = ?', op.id).toArray()[0];
  if (!existing || existing.deleted_at !== null) return baseResult({ missing: [op.id] });

  const sets: string[] = ['last_auto_saved_at = ?'];
  const params: SqlStorageValue[] = [at];
  for (const [key, value] of Object.entries(op.patch)) {
    if (value === undefined) continue;
    if (DRAFT_PATCH_COLUMNS[key]) {
      sets.push(`${DRAFT_PATCH_COLUMNS[key]} = ?`);
      params.push(value as SqlStorageValue);
    } else if (DRAFT_PATCH_JSON_COLUMNS[key]) {
      sets.push(`${DRAFT_PATCH_JSON_COLUMNS[key]} = ?`);
      params.push(toJsonOrNull(value));
    } else if (DRAFT_PATCH_BIT_COLUMNS[key]) {
      sets.push(`${DRAFT_PATCH_BIT_COLUMNS[key]} = ?`);
      params.push(toBit(value as boolean));
    }
  }
  if (op.patch.attachmentIds !== undefined) {
    sets.push('has_attachments = ?', 'attachment_count = ?');
    params.push(toBit(op.patch.attachmentIds.length > 0), op.patch.attachmentIds.length);
  }
  sets.push('updated_at = ?');
  params.push(at, op.id);
  sql.exec(`UPDATE drafts SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return baseResult({ applied: [op.id] });
}

type DraftDeleteOp = Extract<MailboxOp, { kind: 'draft.delete' }>;

function applyDraftDelete(sql: SqlStorage, _ref: MailboxRef, op: DraftDeleteOp, at: number): OpResult {
  const existing = sql.exec<{ id: string; deleted_at: number | null }>('SELECT id, deleted_at FROM drafts WHERE id = ?', op.id).toArray()[0];
  if (!existing || existing.deleted_at !== null) return baseResult({ missing: [op.id] });
  sql.exec('UPDATE drafts SET deleted_at = ?, updated_at = ? WHERE id = ?', at, at, op.id);
  return baseResult({ applied: [op.id] });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Every op kind `./writes`'s `dispatch()` doesn't handle itself (task B2). */
export function applyExtraOp(sql: SqlStorage, ref: MailboxRef, op: MailboxOp, at: number): OpResult {
  switch (op.kind) {
    case 'snooze':
      return applySnooze(sql, ref, op.id, op.until, at);
    case 'resnooze':
      return applyResnooze(sql, ref, op.id, op.until, at);
    case 'unsnooze':
      return applyUnsnooze(sql, ref, op.id, at);
    case 'snooze.wake':
      return applySnoozeWake(sql, ref, op.now, at);
    case 'scheduled':
      return applyScheduled(sql, ref, op, at);
    case 'delivery.match':
      return applyDeliveryMatch(sql, ref, op, at);
    case 'inbound.finalize':
      return applyInboundFinalize(sql, ref, op, at);
    case 'categories':
      return applyCategories(sql, ref, op, at);
    case 'label.rename':
      return applyLabelRename(sql, ref, op, at);
    case 'label.delete':
      return applyLabelDelete(sql, ref, op, at);
    case 'folder.read':
      return applyFolderRead(sql, ref, op, at);
    case 'attachment.create':
      return applyAttachmentCreate(sql, ref, op, at);
    case 'attachment.update':
      return applyAttachmentUpdate(sql, ref, op, at);
    case 'attachment.delete':
      return applyAttachmentDelete(sql, ref, op, at);
    case 'attachment.associate':
      return applyAttachmentAssociate(sql, ref, op, at);
    case 'subscription.upsert':
      return applySubscriptionsUpsert(sql, ref, op, at);
    case 'subscription.status':
      return applySubscriptionStatus(sql, ref, op, at);
    case 'draft.create':
      return applyDraftCreate(sql, ref, op, at);
    case 'draft.update':
      return applyDraftUpdate(sql, ref, op, at);
    case 'draft.delete':
      return applyDraftDelete(sql, ref, op, at);
    default:
      throw new MailboxOpNotImplementedError((op as { kind: string }).kind);
  }
}
