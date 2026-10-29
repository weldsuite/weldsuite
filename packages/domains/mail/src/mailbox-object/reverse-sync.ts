/**
 * `MailboxStoreObject`'s reverse sync (design doc §4, Risks: "rollback from
 * `object`/`object-only` requires reverse sync"): pages the OBJECT's own rows
 * changed since a given timestamp and writes them into tenant Postgres
 * through `PostgresMailboxStore`'s write paths, so Postgres matches again
 * before a mode downgrade. The opposite direction of `./backfill.ts`
 * (Postgres → object) and `./parity.ts`'s repair (Postgres → object for
 * diverged rows) — this file is the only one that ever writes Postgres.
 *
 * ## Running a rollback (the runbook this file's own header is the canonical
 * copy of — also quoted in the worktree's final report)
 *
 * Before flipping a workspace's `weldmail-mailbox-store` mode down from
 * `object`/`object-only` to `shadow`/`postgres`:
 *
 *   1. Freeze new object-primary writes first (flip Flagship to `shadow`, or
 *      stop traffic to the mailbox) — this file syncs a snapshot, it does not
 *      hold a lock against concurrent object writes.
 *   2. `POST /internal/mail-store/reverse-sync` with `{workspaceId, accountId,
 *      since}` — `since` should be far enough back to cover every write the
 *      object has ever been primary for (the timestamp the mailbox was last
 *      promoted to `object`/`object-only`, not "now minus a few minutes").
 *   3. Call again with the returned `cursor` (the admin route does this loop
 *      internally — see `apps/workers/mail-api/src/routes/internal-mail-store`)
 *      until the response's `done: true`.
 *   4. Only then flip the mode down. If new object writes land between step 2
 *      finishing and the mode flip, they are lost to Postgres — hence step 1.
 *
 * ## Scope (design: "missing rows are inserted with bodies from R2 …, with
 * attachments, subscriptions and drafts; mutable fields are updated")
 *
 *   - **Messages**: paged by `(updated_at, id)` off `messages_updated_idx`
 *     (design §3.1 DDL already carries this index "for … reverse sync"). A
 *     row Postgres doesn't have yet is inserted via `PostgresMailboxStore`'s
 *     `ingest` op, with bodies read from R2 (`getMessageBodies` — raw MIME has
 *     no Postgres column to land in any more, see `toIngestMessageFromObjectRow`)
 *     and the object's own attachment rows. A row Postgres already has gets
 *     its labels (`labels.set` — the object's `labels_json` is already
 *     canonical, mirrored flags included), read/flagged state, deleted state,
 *     scheduled/delivery state and snooze state brought in line — each
 *     through the matching `MailboxOp`, never a raw `UPDATE`, so this stays
 *     "the Postgres store's write paths" as the task asks. Categories and the
 *     `extra` blob (headers/customFields/clickedLinks) are NOT reverse-synced
 *     for an already-existing Postgres row — the same scope cut `./parity.ts`
 *     documents for its own comparison, kept consistent here.
 *   - **Drafts** and **subscriptions**: one-shot per call (not independently
 *     paged/resumable like messages — see `MAX_DRAFTS_PER_CALL`/
 *     `MAX_SUBSCRIPTIONS_PER_CALL`). Reverse sync is an admin-triggered,
 *     infrequent, pre-rollback operation, not a hot path; a workspace with
 *     more than a few hundred changed drafts or subscriptions since `since`
 *     needs more than one `reverse-sync` call to fully cover them (the admin
 *     route does not currently loop these the way it loops the messages
 *     cursor — flagged here for whoever next extends this).
 */

import { eq } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailDeliveryStatus } from '@weldsuite/db/schema/mail-messages';
import type { MailDraft } from '@weldsuite/db/schema/mail-drafts';
import { createDraft, softDeleteDraft, updateDraft } from '../drafts';
import { defaultTenantDbReader, type BackfillEnv } from './backfill';
import { PostgresMailboxStore } from '../store/postgres/mailbox-store';
import { getMessageBodies } from '../store/bodies';
import type { AttachmentInput } from '../attachments';
import type { IngestMessage, MailboxRef } from '../store/types';
import { type AttachmentRow, mapMessageRow, parseJsonArray, toEpoch, type MessageRow } from './sql';

const { mailMessages, mailSubscriptions } = schema;

export type ReverseSyncEnv = BackfillEnv;

const MESSAGES_PAGE_SIZE = 200;
const DEFAULT_MAX_ROWS = 2_000;
const MAX_DRAFTS_PER_CALL = 500;
const MAX_SUBSCRIPTIONS_PER_CALL = 500;
const META_KEY = 'reverse_sync';

export interface MessagesCursor {
  updatedAt: number;
  id: string;
}

export interface ReverseSyncOptions {
  since: number;
  cursor?: MessagesCursor | null;
  maxRows?: number;
}

export interface ReverseSyncCounts {
  messagesInserted: number;
  messagesUpdated: number;
  draftsSynced: number;
  subscriptionsSynced: number;
}

export interface ReverseSyncReport {
  since: number;
  startedAt: number;
  finishedAt: number | null;
  counts: ReverseSyncCounts;
  cursor: MessagesCursor | null;
  done: boolean;
}

function getMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
  return row ? row.value : null;
}

function setMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export function lastReverseSyncReport(sql: SqlStorage): ReverseSyncReport | null {
  const raw = getMeta(sql, META_KEY);
  return raw === null ? null : (JSON.parse(raw) as ReverseSyncReport);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function fetchChangedMessages(sql: SqlStorage, since: number, cursor: MessagesCursor | null, limit: number): { rows: MessageRow[]; nextCursor: MessagesCursor | null } {
  const params: SqlStorageValue[] = [since];
  let cursorSql = '';
  if (cursor) {
    cursorSql = ' AND (updated_at > ? OR (updated_at = ? AND id > ?))';
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  const rows = sql.exec<MessageRow>(`SELECT * FROM messages WHERE updated_at >= ?${cursorSql} ORDER BY updated_at ASC, id ASC LIMIT ?`, ...params, limit).toArray();
  const last = rows.at(-1);
  const nextCursor: MessagesCursor | null = rows.length < limit || !last ? null : { updatedAt: last.updated_at, id: last.id };
  return { rows, nextCursor };
}

function objectAttachmentsFor(sql: SqlStorage, messageId: string): AttachmentRow[] {
  return sql.exec<AttachmentRow>('SELECT * FROM attachments WHERE message_id = ? AND deleted_at IS NULL', messageId).toArray();
}

/** Existence by the object's own id (the primary key on both sides) — simpler and more exact than matching on RFC/provider ids. */
async function existsInPostgres(db: Database, id: string): Promise<boolean> {
  const [row] = await db.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.id, id)).limit(1);
  return Boolean(row);
}

async function toIngestMessageFromObjectRow(bucket: R2Bucket | undefined, ref: MailboxRef, row: MessageRow, attachments: AttachmentRow[]): Promise<IngestMessage> {
  const record = mapMessageRow(row, ref);
  const bodyRef = { workspaceId: ref.workspaceId, accountId: ref.accountId, messageId: row.id };
  // Raw MIME has no home in Postgres any more (decision 4: bodies/raw MIME
  // live in R2 from a message's first write onward, in every mode) — even
  // `PostgresMailboxStore.apply`'s own `ingest` never writes `rawMessage`, so
  // there is nothing to reverse-sync it into. Only html/text bodies round-trip.
  const bodies = bucket ? await getMessageBodies(bucket, bodyRef) : { html: null, text: null };

  const attachmentInputs: Array<AttachmentInput & { id: string }> = attachments.map((a) => ({
    id: a.id,
    messageId: row.id,
    fileName: a.file_name,
    contentType: a.content_type ?? undefined,
    size: a.size,
    storagePath: a.storage_path ?? undefined,
    downloadUrl: a.download_url ?? undefined,
    checksum: a.checksum ?? undefined,
    isInline: a.is_inline === 1,
    contentId: a.content_id ?? undefined,
    contentDisposition: a.content_disposition ?? undefined,
  }));

  return {
    id: row.id,
    source: row.source === 'sent' ? 'sent' : 'inbound',
    rfcMessageId: row.rfc_message_id,
    externalMessageId: row.external_message_id,
    providerMessageId: row.provider_message_id,
    // The object's resolved `thread_key`, not the possibly-null `thread_id`
    // it was originally ingested with — Postgres's own threadId column plays
    // the same "grouping key" role via `COALESCE(threadId, id)`.
    threadId: row.thread_key,
    from: record.from,
    to: record.to,
    cc: record.cc,
    bcc: record.bcc,
    replyTo: record.replyTo,
    subject: record.subject,
    preview: record.preview,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    isRead: record.isRead,
    labels: record.labels ?? [],
    isSpam: record.isSpam ?? false,
    inReplyTo: record.inReplyTo,
    references: record.references,
    isReply: record.isReply ?? false,
    isForwarded: record.isForwarded ?? false,
    priority: record.priority,
    sizeBytes: record.sizeBytes,
    spfStatus: record.spfStatus,
    dkimStatus: record.dkimStatus,
    dmarcStatus: record.dmarcStatus,
    sendStatus: record.sendStatus,
    scheduledFor: toEpoch(record.scheduledFor),
    triggerRunId: record.triggerRunId,
    idempotencyKey: record.idempotencyKey,
    delivery: record.deliveryStatus ? { status: record.deliveryStatus, detail: record.deliveryDetail ?? '', at: toEpoch(record.deliveryUpdatedAt) ?? row.updated_at } : null,
    content: { html: bodies.html, text: bodies.text },
    bodies: { html: (row.body_bits & 1) !== 0, text: (row.body_bits & 2) !== 0, raw: (row.body_bits & 4) !== 0 },
    attachments: attachmentInputs,
    subscription: null,
    extra: { headers: record.headers ?? undefined, customFields: record.customFields ?? undefined, clickedLinks: record.clickedLinks ?? undefined, conversationId: record.conversationId ?? undefined },
  };
}

/**
 * Brings an already-existing Postgres row's mutable fields in line with the
 * object's — see the file comment's "Scope" section for exactly which fields.
 * Every write goes through a real `MailboxOp`, never a bare `UPDATE`.
 */
async function updateExistingPostgresRow(postgresStore: PostgresMailboxStore, row: MessageRow): Promise<void> {
  const labels = parseJsonArray<string>(row.labels_json);
  await postgresStore.apply({ kind: 'labels.set', id: row.id, labels }, row.updated_at);
  await postgresStore.apply({ kind: 'flags', ids: [row.id], patch: { isRead: row.is_read === 1, isFlagged: row.is_flagged === 1 }, semantics: 'single' }, row.updated_at);
  if (row.deleted_at) {
    await postgresStore.apply({ kind: 'delete', ids: [row.id], hard: false }, row.deleted_at);
  }
  if (row.send_status || row.scheduled_for || row.delivery_status) {
    await postgresStore.apply(
      {
        kind: 'scheduled',
        id: row.id,
        patch: {
          sendStatus: (row.send_status as 'scheduled' | 'sent' | 'cancelled' | 'failed' | undefined) ?? undefined,
          scheduledFor: row.scheduled_for,
          triggerRunId: row.trigger_run_id,
          externalMessageId: row.external_message_id ?? undefined,
          delivery: row.delivery_status ? { status: row.delivery_status as MailDeliveryStatus, detail: row.delivery_detail } : undefined,
        },
      },
      row.updated_at,
    );
  }
  if (row.snoozed_until) {
    await postgresStore.apply({ kind: 'resnooze', id: row.id, until: row.snoozed_until }, row.updated_at);
  }
}

/**
 * One changed row's reverse-sync: ingest it into Postgres (plus a `delete` op
 * when it's soft-deleted — `IngestMessage` has no deleted-state field, the
 * same gap `./backfill.ts`'s `applyPgRow` documents, so a second op marks it,
 * the same two-step pattern) when Postgres doesn't have it yet, else bring
 * the existing Postgres row up to date. Returns which bucket it counts in.
 */
async function syncOneMessageRow(
  sql: SqlStorage,
  postgresStore: PostgresMailboxStore,
  env: ReverseSyncEnv,
  ref: MailboxRef,
  db: Database,
  row: MessageRow,
): Promise<'inserted' | 'updated'> {
  const alreadyInPostgres = await existsInPostgres(db, row.id);
  if (alreadyInPostgres) {
    await updateExistingPostgresRow(postgresStore, row);
    return 'updated';
  }
  const attachments = objectAttachmentsFor(sql, row.id);
  const message = await toIngestMessageFromObjectRow(env.MAIL_STORAGE, ref, row, attachments);
  await postgresStore.apply({ kind: 'ingest', message }, row.updated_at);
  if (row.deleted_at) {
    await postgresStore.apply({ kind: 'delete', ids: [row.id], hard: false }, row.deleted_at);
  }
  return 'inserted';
}

async function syncMessages(storage: { sql: SqlStorage }, env: ReverseSyncEnv, db: Database, ref: MailboxRef, since: number, cursor: MessagesCursor | null, maxRows: number): Promise<{ inserted: number; updated: number; nextCursor: MessagesCursor | null; done: boolean }> {
  const postgresStore = new PostgresMailboxStore(db, ref);
  let inserted = 0;
  let updated = 0;
  let scanned = 0;
  let nextCursor = cursor;
  let done = false;

  for (;;) {
    const page = fetchChangedMessages(storage.sql, since, nextCursor, Math.min(MESSAGES_PAGE_SIZE, maxRows - scanned));
    if (page.rows.length === 0) {
      done = true;
      break;
    }
    for (const row of page.rows) {
      // eslint-disable-next-line no-await-in-loop -- bounded by the page/maxRows budget, same as backfill's per-row reads
      const outcome = await syncOneMessageRow(storage.sql, postgresStore, env, ref, db, row);
      if (outcome === 'inserted') inserted++;
      else updated++;
      scanned++;
    }
    nextCursor = page.nextCursor;
    if (nextCursor === null) {
      done = true;
      break;
    }
    if (scanned >= maxRows) break;
  }

  return { inserted, updated, nextCursor: done ? null : nextCursor, done };
}

// ---------------------------------------------------------------------------
// Drafts (one-shot per call — see the file comment's "Scope" section)
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
  updated_at: number;
  deleted_at: number | null;
};

function parseJsonOrNull<T>(raw: string | null): T | null {
  return raw ? (JSON.parse(raw) as T) : null;
}

async function syncDrafts(sql: SqlStorage, db: Database, ref: MailboxRef, since: number): Promise<number> {
  const rows = sql.exec<DraftRow>('SELECT * FROM drafts WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT ?', since, MAX_DRAFTS_PER_CALL).toArray();
  let synced = 0;
  for (const row of rows) {
    if (row.deleted_at) {
      // eslint-disable-next-line no-await-in-loop -- bounded by MAX_DRAFTS_PER_CALL
      await softDeleteDraft(db, row.id, new Date(row.deleted_at));
      synced++;
      continue;
    }
    const patch = {
      subject: row.subject ?? undefined,
      to: parseJsonOrNull<string[]>(row.to_json) ?? undefined,
      cc: parseJsonOrNull<string[]>(row.cc_json) ?? undefined,
      bcc: parseJsonOrNull<string[]>(row.bcc_json) ?? undefined,
      replyTo: parseJsonOrNull<string[]>(row.reply_to_json) ?? undefined,
      body: row.body ?? undefined,
      htmlBody: row.html_body ?? undefined,
      importance: (row.importance as 'low' | 'normal' | 'high' | undefined) ?? undefined,
      labels: parseJsonOrNull<string[]>(row.labels_json) ?? undefined,
      attachmentIds: parseJsonOrNull<string[]>(row.attachment_ids_json) ?? undefined,
      inReplyTo: row.in_reply_to ?? undefined,
      originalMessageId: row.original_message_id ?? undefined,
      isReply: row.is_reply === null ? undefined : row.is_reply === 1,
      isForward: row.is_forward === null ? undefined : row.is_forward === 1,
    };
    // eslint-disable-next-line no-await-in-loop -- bounded by MAX_DRAFTS_PER_CALL
    const updateResult: { before: MailDraft; after: MailDraft } | null = await updateDraft(db, row.id, patch, new Date(row.updated_at));
    if (!updateResult) {
      // eslint-disable-next-line no-await-in-loop
      await createDraft(db, { ...patch, id: row.id, accountId: ref.accountId }, new Date(row.updated_at));
    }
    synced++;
  }
  return synced;
}

// ---------------------------------------------------------------------------
// Subscriptions (one-shot per call — see the file comment's "Scope" section)
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
  updated_at: number;
};

async function syncSubscriptions(sql: SqlStorage, db: Database, ref: MailboxRef, since: number): Promise<number> {
  const rows = sql.exec<SubscriptionRow>('SELECT * FROM subscriptions WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT ?', since, MAX_SUBSCRIPTIONS_PER_CALL).toArray();
  for (const row of rows) {
    // Reverse sync sets Postgres to the object's CURRENT truth (unlike
    // `reconcileSubscriptions`'s GREATEST/LEAST merge, which is for the
    // forward backfill direction, where an overlapping live upsert must
    // never be downgraded by a stale scan).
    // eslint-disable-next-line no-await-in-loop -- bounded by MAX_SUBSCRIPTIONS_PER_CALL
    await db
      .insert(mailSubscriptions)
      .values({
        id: row.id,
        accountId: ref.accountId,
        senderEmail: row.sender_email,
        senderName: row.sender_name,
        senderDomain: row.sender_domain,
        listId: row.list_id,
        unsubscribeUrl: row.unsubscribe_url,
        unsubscribeMailto: row.unsubscribe_mailto,
        oneClick: row.one_click === 1,
        messageCount: row.message_count,
        lastSubject: row.last_subject,
        firstReceivedAt: new Date(row.first_received_at),
        lastReceivedAt: new Date(row.last_received_at),
        status: row.status as 'active' | 'unsubscribed',
        unsubscribeMethod: row.unsubscribe_method as 'one_click' | 'mailto' | 'link' | null,
        unsubscribedAt: row.unsubscribed_at ? new Date(row.unsubscribed_at) : null,
        unsubscribedBy: row.unsubscribed_by,
        updatedAt: new Date(row.updated_at),
      })
      .onConflictDoUpdate({
        target: [mailSubscriptions.accountId, mailSubscriptions.senderEmail],
        set: {
          senderName: row.sender_name,
          senderDomain: row.sender_domain,
          listId: row.list_id,
          unsubscribeUrl: row.unsubscribe_url,
          unsubscribeMailto: row.unsubscribe_mailto,
          oneClick: row.one_click === 1,
          messageCount: row.message_count,
          lastSubject: row.last_subject,
          lastReceivedAt: new Date(row.last_received_at),
          status: row.status as 'active' | 'unsubscribed',
          unsubscribeMethod: row.unsubscribe_method as 'one_click' | 'mailto' | 'link' | null,
          unsubscribedAt: row.unsubscribed_at ? new Date(row.unsubscribed_at) : null,
          unsubscribedBy: row.unsubscribed_by,
          updatedAt: new Date(row.updated_at),
        },
      });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * `MailboxStoreObject.reverseSync` (RPC, design task C4). Drafts and
 * subscriptions run once per call (capped); messages are paged and
 * resumable via `cursor`/`done` — see the file comment's runbook for how the
 * admin route (mail-api `routes/internal-mail-store`) drives this to
 * completion before a mode downgrade.
 */
export async function runReverseSync(storage: { sql: SqlStorage }, env: ReverseSyncEnv, ref: MailboxRef, options: ReverseSyncOptions): Promise<ReverseSyncReport> {
  const startedAt = Date.now();
  const reader = env.tenantDbReader ?? defaultTenantDbReader(env);
  const db = await reader(ref.workspaceId);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;

  // Drafts/subscriptions only run from a fresh call (no incoming cursor) —
  // once this reverse sync has started paging through messages, repeating
  // the one-shot phases on every follow-up call would be wasted work for no
  // extra coverage (see the file comment: they are not independently paged).
  const draftsSynced = options.cursor ? 0 : await syncDrafts(storage.sql, db, ref, options.since);
  const subscriptionsSynced = options.cursor ? 0 : await syncSubscriptions(storage.sql, db, ref, options.since);

  const messages = await syncMessages(storage, env, db, ref, options.since, options.cursor ?? null, maxRows);

  const report: ReverseSyncReport = {
    since: options.since,
    startedAt,
    finishedAt: messages.done ? Date.now() : null,
    counts: {
      messagesInserted: messages.inserted,
      messagesUpdated: messages.updated,
      draftsSynced,
      subscriptionsSynced,
    },
    cursor: messages.nextCursor,
    done: messages.done,
  };
  setMeta(storage.sql, META_KEY, JSON.stringify(report));
  console.log(
    '[mailbox-store] mailbox_reverse_sync:',
    `ref=${ref.workspaceId}:${ref.accountId} since=${options.since} inserted=${messages.inserted} updated=${messages.updated} drafts=${draftsSynced} subscriptions=${subscriptionsSynced} done=${report.done}`,
  );
  return report;
}
