/**
 * Small typed helpers over `SqlStorage`: row shapes for every table in
 * `./schema`, JSON/bit/epoch conversions between the SQLite columns and the
 * domain types in `../store/types`, and chunking for `IN (…)` lists (task B1).
 *
 * No business rules here — label/folder/move semantics stay in
 * `../store/model`; this file only knows how to get values in and out of
 * SQLite in the right shape.
 */

import type { MailClickedLink, MailDeliveryStatus, MailEmailAddress, MailMessage } from '@weldsuite/db/schema/mail-messages';
import type { MailAttachment } from '@weldsuite/db/schema/mail-attachments';
import type { MailboxRef, MailMessageRecord } from '../store/types';

// ---------------------------------------------------------------------------
// Chunking (SQLite's bound-parameter limit)
// ---------------------------------------------------------------------------

/**
 * A conservative chunk size for `IN (?, ?, …)` lists. SQLite's own limit
 * (`SQLITE_MAX_VARIABLE_NUMBER`) defaults to 32766 on modern builds (999
 * before 3.32.0); workerd's compiled limit isn't published, so this stays
 * well under either to leave room for the statement's other bindings too.
 */
export const MAX_BOUND_PARAMS = 500;

/** Splits `items` into chunks of at most `size` (default `MAX_BOUND_PARAMS`). Empty input yields no chunks. */
export function chunk<T>(items: readonly T[], size: number = MAX_BOUND_PARAMS): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `?, ?, ?` for `n` bindings — build an `IN (${placeholders(ids.length)})` clause. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

// ---------------------------------------------------------------------------
// Bit / bool / epoch conversions
// ---------------------------------------------------------------------------

/** JS boolean (or nullish, treated as `false`) to the `0`/`1` SQLite stores. */
export function toBit(value: boolean | null | undefined): 0 | 1 {
  return value ? 1 : 0;
}

/** The `0`/`1` (or any other SQLite truthy/falsy number) SQLite returns, as a JS boolean. */
export function fromBit(value: number | null | undefined): boolean {
  return Boolean(value);
}

/** `Date | epoch millis | null | undefined` to epoch millis, or `null`. */
export function toEpoch(value: Date | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : value;
}

/** Epoch millis (or `null`) to a `Date`, or `null`. */
export function epochToDate(value: number | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

/** Like `epochToDate`, but for the handful of `MailMessage` columns that are `NOT NULL` `Date`s. */
export function epochToDateRequired(value: number): Date {
  return new Date(value);
}

// ---------------------------------------------------------------------------
// JSON conversions
// ---------------------------------------------------------------------------

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function toJsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Parses a JSON array column, defaulting to `[]` for `null`/absent (never throws on a stored value — writes.ts controls what gets written). */
export function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  return JSON.parse(raw) as T[];
}

export function parseJsonOrNull<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/** The last-write-wins clock groups a mutation can touch (design §3.2's `clk_*` columns, minus the `_` prefix). */
export type ClockGroup = 'read' | 'labels' | 'flag' | 'delete' | 'snooze' | 'send' | 'delivery' | 'meta';

export const CLOCK_GROUPS: readonly ClockGroup[] = ['read', 'labels', 'flag', 'delete', 'snooze', 'send', 'delivery', 'meta'];

function clockColumn(group: ClockGroup): string {
  return `clk_${group}`;
}

// These row shapes are `type` aliases, not `interface`s, on purpose: only an
// object-literal `type` gets TypeScript's "implicit index signature"
// treatment, which `SqlStorage.exec<T extends Record<string, SqlStorageValue>>`
// needs — an `interface` with the exact same members does not satisfy that
// constraint (a `interface`/`type` quirk, not a semantic difference here).

/** The raw `messages` row exactly as SQLite stores it: snake_case, JSON-as-text, booleans as 0/1, dates as epoch ms. */
export type MessageRow = {
  id: string;
  rfc_message_id: string;
  external_message_id: string | null;
  provider_message_id: string | null;
  thread_id: string | null;
  thread_key: string;
  conversation_id: string | null;
  from_email: string;
  from_name: string | null;
  from_json: string;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null;
  reply_to_json: string | null;
  subject: string | null;
  subject_norm: string | null;
  preview: string | null;
  sent_at: number;
  received_at: number | null;
  sort_at: number;
  is_read: number;
  is_flagged: number;
  is_draft: number;
  is_reply: number;
  is_forwarded: number;
  labels_json: string;
  categories_json: string | null;
  in_trash: number;
  in_spam: number;
  archived: number;
  starred: number;
  important: number;
  has_attachments: number;
  attachment_count: number;
  in_reply_to: string | null;
  references_json: string | null;
  priority: string | null;
  size_bytes: number | null;
  spf_status: string | null;
  dkim_status: string | null;
  dmarc_status: string | null;
  source: string | null;
  send_status: string | null;
  scheduled_for: number | null;
  trigger_run_id: string | null;
  idempotency_key: string | null;
  snoozed_until: number | null;
  snoozed_at: number | null;
  unsnoozed_at: number | null;
  unsnoozed_early: number | null;
  resnoozed_at: number | null;
  delivery_status: string | null;
  delivery_detail: string | null;
  delivery_updated_at: number | null;
  body_bits: number;
  extra_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  clk_read: number;
  clk_labels: number;
  clk_flag: number;
  clk_delete: number;
  clk_snooze: number;
  clk_send: number;
  clk_delivery: number;
  clk_meta: number;
}

/** `row[clk_<group>]` without a dynamic-index cast at every call site. */
export function clockValue(row: MessageRow, group: ClockGroup): number {
  return row[clockColumn(group) as keyof MessageRow] as number;
}

export function loadMessageRow(sql: SqlStorage, id: string): MessageRow | null {
  return sql.exec<MessageRow>('SELECT * FROM messages WHERE id = ?', id).toArray()[0] ?? null;
}

export function loadMessageRows(sql: SqlStorage, ids: readonly string[]): MessageRow[] {
  if (ids.length === 0) return [];
  const rows: MessageRow[] = [];
  for (const part of chunk(ids)) {
    rows.push(
      ...sql.exec<MessageRow>(`SELECT * FROM messages WHERE id IN (${placeholders(part.length)})`, ...part).toArray(),
    );
  }
  return rows;
}

/** Every live (not deleted) message of one thread, for `refreshThread` (capped at 1000 per design §3.2). */
export function loadLiveThreadMessages(sql: SqlStorage, threadKey: string, limit = 1000): MessageRow[] {
  return sql
    .exec<MessageRow>(
      'SELECT * FROM messages WHERE thread_key = ? AND deleted_at IS NULL ORDER BY sort_at ASC LIMIT ?',
      threadKey,
      limit,
    )
    .toArray();
}

interface ExtraJson {
  headers?: Record<string, string> | null;
  customFields?: Record<string, unknown> | null;
  clickedLinks?: MailClickedLink[] | null;
  conversationId?: string | null;
}

/**
 * The row as a `MailMessageRecord` (the store contract's shape, `store/
 * types.ts`). `ref` supplies `accountId`, which every row in this mailbox
 * shares and which is therefore not stored per-row. Columns `MailMessage` has
 * but this object's schema doesn't (`readReceipt`, `deliveryReceipt`,
 * `openedAt`, `isEncrypted`, `isSigned`, `sendProvider`, `mailgunMessageId`,
 * `mailcowMessageId`, `unsnoozeTriggerRunId`) are legacy `custom_fields`-blob
 * extractions nothing in the new ingest/op surface ever sets (design §3.1's
 * DDL omits them too) — they come back at their column default. Bodies are
 * never read from R2 here: `textBody`/`htmlBody`/`rawMessage` are always
 * `null`, per the contract's "fields the object does not keep come back
 * null" (a caller wanting bodies reads R2 itself, `store/bodies.ts`).
 */
export function mapMessageRow(row: MessageRow, ref: Pick<MailboxRef, 'accountId'>): MailMessageRecord {
  const extra = parseJsonOrNull<ExtraJson>(row.extra_json) ?? {};
  return {
    id: row.id,
    accountId: ref.accountId,
    messageId: row.rfc_message_id,
    threadId: row.thread_id,
    threadKey: row.thread_key,
    conversationId: extra.conversationId ?? null,
    from: parseJsonOrNull<MailEmailAddress>(row.from_json) ?? { email: row.from_email, name: row.from_name ?? undefined },
    to: parseJsonArray<MailEmailAddress>(row.to_json),
    cc: parseJsonOrNull<MailEmailAddress[]>(row.cc_json),
    bcc: parseJsonOrNull<MailEmailAddress[]>(row.bcc_json),
    replyTo: parseJsonOrNull<MailEmailAddress>(row.reply_to_json),
    subject: row.subject,
    preview: row.preview,
    textBody: null,
    htmlBody: null,
    rawMessage: null,
    sentDate: epochToDateRequired(row.sent_at),
    receivedDate: epochToDate(row.received_at),
    isRead: fromBit(row.is_read),
    isStarred: fromBit(row.starred),
    isFlagged: fromBit(row.is_flagged),
    isImportant: fromBit(row.important),
    isDraft: fromBit(row.is_draft),
    isSpam: fromBit(row.in_spam),
    isTrash: fromBit(row.in_trash),
    hasAttachments: fromBit(row.has_attachments),
    attachmentCount: row.attachment_count,
    inReplyTo: row.in_reply_to,
    references: parseJsonOrNull<string[]>(row.references_json),
    isReply: fromBit(row.is_reply),
    isForwarded: fromBit(row.is_forwarded),
    labels: parseJsonArray<string>(row.labels_json),
    categories: parseJsonOrNull<string[]>(row.categories_json),
    priority: row.priority as MailMessage['priority'],
    readReceipt: false,
    deliveryReceipt: false,
    openedAt: null,
    clickedLinks: extra.clickedLinks ?? null,
    isEncrypted: false,
    isSigned: false,
    spfStatus: row.spf_status as MailMessage['spfStatus'],
    dkimStatus: row.dkim_status as MailMessage['dkimStatus'],
    dmarcStatus: row.dmarc_status as MailMessage['dmarcStatus'],
    scheduledFor: epochToDate(row.scheduled_for),
    sendStatus: row.send_status,
    triggerRunId: row.trigger_run_id,
    sendProvider: null,
    providerMessageId: row.provider_message_id,
    mailgunMessageId: null,
    snoozedUntil: epochToDate(row.snoozed_until),
    snoozedAt: epochToDate(row.snoozed_at),
    unsnoozedAt: epochToDate(row.unsnoozed_at),
    unsnoozedEarly: row.unsnoozed_early === null ? null : fromBit(row.unsnoozed_early),
    resnoozedAt: epochToDate(row.resnoozed_at),
    unsnoozeTriggerRunId: null,
    deliveryStatus: row.delivery_status as MailDeliveryStatus | null,
    deliveryUpdatedAt: epochToDate(row.delivery_updated_at),
    deliveryDetail: row.delivery_detail,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    externalMessageId: row.external_message_id,
    mailcowMessageId: null,
    headers: extra.headers ?? null,
    customFields: extra.customFields ?? null,
    sizeBytes: row.size_bytes,
    createdAt: epochToDateRequired(row.created_at),
    updatedAt: epochToDateRequired(row.updated_at),
    deletedAt: epochToDate(row.deleted_at),
  };
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

export type AttachmentRow = {
  id: string;
  message_id: string;
  file_name: string;
  content_type: string | null;
  size: number;
  is_inline: number;
  content_id: string | null;
  content_disposition: string | null;
  checksum: string | null;
  storage_path: string | null;
  download_url: string | null;
  external_attachment_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export function mapAttachmentRow(row: AttachmentRow): MailAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    fileName: row.file_name,
    contentType: row.content_type,
    size: row.size,
    isInline: fromBit(row.is_inline),
    contentId: row.content_id,
    contentDisposition: row.content_disposition,
    checksum: row.checksum,
    downloadUrl: row.download_url,
    storagePath: row.storage_path,
    externalAttachmentId: row.external_attachment_id,
    createdAt: epochToDateRequired(row.created_at),
    updatedAt: epochToDateRequired(row.updated_at),
    deletedAt: epochToDate(row.deleted_at),
  };
}

// ---------------------------------------------------------------------------
// threads / thread_labels / label_counts (internal row shapes `writes.ts` uses)
// ---------------------------------------------------------------------------

export type ThreadRow = {
  thread_key: string;
  latest_at: number;
  latest_message_id: string;
  first_message_id: string;
  subject: string | null;
  preview: string | null;
  latest_from_json: string | null;
  participants_json: string;
  labels_json: string;
  message_count: number;
  unread_count: number;
  has_attachments: number;
  is_starred: number;
  scheduled_for: number | null;
  send_status: string | null;
  updated_at: number;
};

export type ThreadLabelRow = {
  label_key: string;
  thread_key: string;
  latest_at: number;
  match_count: number;
};

export type LabelCountRow = {
  label_key: string;
  messages: number;
  unread: number;
  threads: number;
};

export function loadLabelCounts(sql: SqlStorage, keys: readonly string[]): Map<string, LabelCountRow> {
  const out = new Map<string, LabelCountRow>();
  if (keys.length === 0) return out;
  for (const part of chunk(keys)) {
    for (const row of sql
      .exec<LabelCountRow>(`SELECT * FROM label_counts WHERE label_key IN (${placeholders(part.length)})`, ...part)
      .toArray()) {
      out.set(row.label_key, row);
    }
  }
  return out;
}
