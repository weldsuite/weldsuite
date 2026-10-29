/**
 * `MailboxStoreObject`'s backfill (design doc §4, task C4): the object pulls
 * its own data from tenant Postgres, in its alarm, the same pattern
 * `MailIndex` uses for `ensureCorrespondentsSeeded` (`../mail-index/mail-index.ts`
 * + `../mail-index/correspondents-reader.ts`): a `TenantDbReader` is injected
 * through `BackfillEnv.tenantDbReader`, with a production default
 * (`defaultTenantDbReader`) that opens the tenant DB via
 * `getTenantDbForWorkspace`. Tests inject a reader that resolves a pglite
 * handle instead — this file never mocks Postgres itself, it mocks how the
 * tenant DB is reached.
 *
 * Phases, oldest to newest, each resumable from `meta.backfill` (survives an
 * eviction: the object is recreated, re-reads `meta.backfill`, and the next
 * alarm tick picks up exactly where the last one left off):
 *
 *   1. `subscriptions` — every `mail_subscriptions` row of the account (one
 *      page; Postgres's own `listSubscriptions` already caps at 1000, so this
 *      phase is not expected to need more than one tick for any real mailbox).
 *   2. `drafts` — live `mail_drafts`, cursor-paged by `listDrafts`'s own
 *      `(updatedAt, id)` keyset.
 *   3. `messages` — pages of `MESSAGES_PAGE_SIZE`, oldest to newest by
 *      `(createdAt, id)`, each message's attachments, bodies copied into R2
 *      (`putMessageBodies`/`putRawMime`) when not already there, then one
 *      `applyPgRow` (insert-if-absent via `ingest`, or an LWW merge against an
 *      already-live-ingested row — see that function's own comment for why
 *      BOTH cases are expected even on a first pass).
 *   4. `catchup` — once the watermark captured at the start of phase 3 is
 *      reached, re-scan rows whose Postgres `updatedAt` is after
 *      `pgWatermark - CATCHUP_LOOKBACK_MS`, merged the same way, until
 *      exhausted; then `done`.
 *
 * `ready` (design: `OpResult.ready`) is derived by `mailbox-object.ts`'s
 * `isReady()` straight from this file's own `meta.backfill` shape
 * (`{state: 'done'}` ⇒ ready) — that method was written ahead of this task
 * precisely so landing a real `BackfillState` here is enough, no edit needed
 * there.
 *
 * Scope notes (flagged for whoever next touches this):
 *   - `messages`/`catchup` skip attachment-ROW reconciliation (only the
 *     message's own mutable fields are merged on catch-up) — full parity
 *     (`./parity.ts`) does not diff attachments either (design §4 lists
 *     labels/flags/folder membership/thread key/deleted state only), so this
 *     is a deliberate, matching scope cut, not an oversight.
 *   - A Postgres row whose `source` predates the `'inbound'|'sent'` store
 *     convention (legacy `'inbox'`/`'composed'` values, pre-dating this
 *     design) is treated as `'inbound'` unless it is literally `'sent'`.
 *   - `rawMessage` (legacy inline raw MIME) is copied to R2 only when a
 *     Postgres row still has one; new rows already write `raw.eml` to R2
 *     directly (decision 4) and leave the column null, so this is a
 *     migration-tail path, not the common case.
 */

import { and, asc, eq, gt, gte, inArray, isNull, or } from 'drizzle-orm';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import type { MailAttachment } from '@weldsuite/db/schema/mail-attachments';
import type { MailMessage } from '@weldsuite/db/schema/mail-messages';
import type { MailDraft } from '@weldsuite/db/schema/mail-drafts';
import type { MailSubscription } from '@weldsuite/db/schema/mail-subscriptions';
import type { AttachmentInput } from '../attachments';
import type { DraftInput } from '../drafts';
import { listSubscriptions as listSubscriptionsRows } from '../store/postgres/subscriptions';
import { listDrafts as listDraftRows } from '../drafts';
import { normalizeLegacy, SYSTEM_LABELS } from '../store/model';
import { bareSubject } from '../store/thread-match';
import { bodyHtmlKey, bodyTextKey, putMessageBodies, putRawMime, rawMimeKey } from '../store/bodies';
import { plainTextBody } from '../text';
import { mailIndexFor, type MailIndexBindingEnv } from '../mail-index/client';
import type { IngestMessage, MailboxRef, SubscriptionValues } from '../store/types';
import { applyMailboxOp, changeMessage, labelPatch, type WritableStorage } from './writes';
import { CLOCK_GROUPS, loadMessageRow, toBit, toJson, type MessageRow } from './sql';

const { mailAttachments, mailMessages } = schema;

// ---------------------------------------------------------------------------
// Tenant DB access (injected, mirrors mail-index/correspondents-reader.ts)
// ---------------------------------------------------------------------------

export type TenantDbReader = (workspaceId: string) => Promise<Database>;

/** Opens the tenant DB directly, the same "the object's alarm reads Postgres itself" pattern as `MailIndex`'s `defaultCorrespondentsReader`. */
export function defaultTenantDbReader(env: DbEnv): TenantDbReader {
  return (workspaceId: string) => getTenantDbForWorkspace(env, workspaceId);
}

export interface BackfillEnv extends DbEnv, MailIndexBindingEnv {
  /** Test-only override; see this file's header comment. */
  tenantDbReader?: TenantDbReader;
  MAIL_STORAGE?: R2Bucket;
}

// ---------------------------------------------------------------------------
// State (meta.backfill)
// ---------------------------------------------------------------------------

export type BackfillRunState = 'idle' | 'running' | 'catchup' | 'done' | 'failed';
export type BackfillPhase = 'subscriptions' | 'drafts' | 'messages' | 'catchup' | 'done';

export interface MessagesCursor {
  createdAt: number;
  id: string;
}

export interface BackfillCounts {
  subscriptions: number;
  drafts: number;
  messages: number;
  catchup: number;
}

export interface BackfillState {
  state: BackfillRunState;
  phase: BackfillPhase;
  draftsCursor: string | null;
  messagesCursor: MessagesCursor | null;
  catchupCursor: MessagesCursor | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Captured once the `messages` phase starts; catch-up rescans rows updated since `pgWatermark - CATCHUP_LOOKBACK_MS`. */
  pgWatermark: number | null;
  copied: BackfillCounts;
  attempts: number;
  lastError: string | null;
  /** Caller-supplied label (`'router'`, `'admin'`, `'account-create'`), logged, not interpreted. */
  source: string | null;
  /** Set on a failed tick; the next tick (and `nextBackfillAlarmAt`, alarm.ts) waits until this time. */
  nextAttemptAt: number | null;
}

const IDLE_STATE: BackfillState = {
  state: 'idle',
  phase: 'subscriptions',
  draftsCursor: null,
  messagesCursor: null,
  catchupCursor: null,
  startedAt: null,
  finishedAt: null,
  pgWatermark: null,
  copied: { subscriptions: 0, drafts: 0, messages: 0, catchup: 0 },
  attempts: 0,
  lastError: null,
  source: null,
  nextAttemptAt: null,
};

const META_KEY = 'backfill';
/** design §4: "backoff 1 / 5 / 30 min; after 10 attempts the state is failed". */
const BACKOFF_TIERS_MS = [60_000, 300_000, 1_800_000];
const MAX_ATTEMPTS = 10;
/** design §4 step 4: rescan rows updated since `pgWatermark - 5 min`. */
const CATCHUP_LOOKBACK_MS = 5 * 60_000;

const SUBSCRIPTIONS_PAGE_SIZE = 1000;
const DRAFTS_PAGE_SIZE = 100;
/** design §4 step 3: "pages of 200". */
const MESSAGES_PAGE_SIZE = 200;

function getMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
  return row ? row.value : null;
}

function setMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

/** Read-only; also used by `alarm.ts`'s `runContinuation` to decide whether to keep ticking. */
export function getBackfillState(sql: SqlStorage): BackfillState {
  const raw = getMeta(sql, META_KEY);
  return raw === null ? IDLE_STATE : (JSON.parse(raw) as BackfillState);
}

function setBackfillState(sql: SqlStorage, state: BackfillState): void {
  setMeta(sql, META_KEY, JSON.stringify(state));
}

function backoffMs(attempts: number): number {
  return BACKOFF_TIERS_MS[Math.min(attempts - 1, BACKOFF_TIERS_MS.length - 1)] ?? BACKOFF_TIERS_MS[BACKOFF_TIERS_MS.length - 1]!;
}

// ---------------------------------------------------------------------------
// startBackfill / backfillStatus (RPC-facing)
// ---------------------------------------------------------------------------

export interface StartBackfillOptions {
  force?: boolean;
  source?: string;
}

/**
 * Cheap and idempotent: a mailbox already `running`/`catchup`, or already
 * `done` without `force`, returns the existing state untouched — no write, no
 * transaction. The router (task C3) calls this on every first single-mailbox
 * read in shadow-or-above mode, so this path must stay fast for the
 * overwhelmingly common "already backfilled" case (design §4, task notes).
 */
export function startBackfill(sql: SqlStorage, now: number, options: StartBackfillOptions = {}): BackfillState {
  const current = getBackfillState(sql);
  if (current.state === 'running' || current.state === 'catchup') return current;
  if (current.state === 'done' && !options.force) return current;

  const next: BackfillState = {
    ...IDLE_STATE,
    state: 'running',
    phase: 'subscriptions',
    startedAt: now,
    source: options.source ?? 'router',
  };
  setBackfillState(sql, next);
  return next;
}

export function backfillStatus(sql: SqlStorage): BackfillState {
  return getBackfillState(sql);
}

// ---------------------------------------------------------------------------
// Row → op mapping
// ---------------------------------------------------------------------------

const MAX_SEARCH_TEXT_BYTES = 8192;

/** Byte-safe truncation (same algorithm as `store/object/mailbox-store.ts`'s private `truncateUtf8`, duplicated here: that file is owned by a parallel task in this worktree). */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(encoded.subarray(0, end));
}

function computeSearchText(text: string | null, html: string | null): string | undefined {
  const plain = plainTextBody(text ?? undefined, html ?? undefined);
  return plain ? truncateUtf8(plain, MAX_SEARCH_TEXT_BYTES) : undefined;
}

export interface BodyBits {
  html: boolean;
  text: boolean;
  raw: boolean;
}

/**
 * Copies whichever of body.html/body.txt/raw.eml are missing from R2, from
 * the Postgres row's own columns. Never overwrites an object that already
 * exists (design task description: "when the R2 objects don't exist yet").
 * Exported for `./parity.ts`'s repair path, which re-applies a Postgres row
 * the same way a backfill tick would.
 */
export async function ensureBodiesInR2(bucket: R2Bucket | undefined, ref: MailboxRef, row: MailMessage): Promise<BodyBits> {
  if (!bucket) return { html: false, text: false, raw: false };
  const bodyRef = { workspaceId: ref.workspaceId, accountId: ref.accountId, messageId: row.id };

  const [htmlHead, textHead, rawHead] = await Promise.all([
    row.htmlBody ? bucket.head(bodyHtmlKey(bodyRef)) : Promise.resolve(null),
    row.textBody ? bucket.head(bodyTextKey(bodyRef)) : Promise.resolve(null),
    row.rawMessage ? bucket.head(rawMimeKey(bodyRef)) : Promise.resolve(null),
  ]);

  const toWrite: { html?: string | null; text?: string | null } = {};
  if (row.htmlBody && !htmlHead) toWrite.html = row.htmlBody;
  if (row.textBody && !textHead) toWrite.text = row.textBody;
  if (toWrite.html !== undefined || toWrite.text !== undefined) {
    await putMessageBodies(bucket, bodyRef, toWrite);
  }
  if (row.rawMessage && !rawHead) {
    await putRawMime(bucket, bodyRef, new TextEncoder().encode(row.rawMessage));
  }

  return {
    html: Boolean(row.htmlBody),
    text: Boolean(row.textBody),
    raw: Boolean(row.rawMessage),
  };
}

function toAttachmentInput(row: MailAttachment, messageId: string): AttachmentInput & { id: string } {
  return {
    id: row.id,
    messageId,
    fileName: row.fileName,
    contentType: row.contentType ?? undefined,
    size: row.size,
    storagePath: row.storagePath ?? undefined,
    downloadUrl: row.downloadUrl ?? undefined,
    checksum: row.checksum ?? undefined,
    isInline: row.isInline ?? undefined,
    contentId: row.contentId ?? undefined,
    contentDisposition: row.contentDisposition ?? undefined,
  };
}

function toIngestMessage(row: MailMessage, attachments: MailAttachment[], bodies: BodyBits): IngestMessage {
  const labels = normalizeLegacy({
    labels: row.labels,
    isStarred: row.isStarred,
    isImportant: row.isImportant,
    isTrash: row.isTrash,
    isSpam: row.isSpam,
  });
  return {
    id: row.id,
    // Legacy `source` values (pre-dating the `'inbound'|'sent'` store
    // convention) fold to `'inbound'` — see this file's header comment.
    source: row.source === 'sent' ? 'sent' : 'inbound',
    rfcMessageId: row.messageId,
    externalMessageId: row.externalMessageId,
    providerMessageId: row.providerMessageId,
    threadId: row.threadId ?? row.id,
    from: row.from,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    replyTo: row.replyTo,
    subject: row.subject,
    preview: row.preview,
    sentAt: row.sentDate.getTime(),
    receivedAt: row.receivedDate ? row.receivedDate.getTime() : null,
    createdAt: row.createdAt.getTime(),
    isRead: row.isRead,
    labels,
    isSpam: labels.includes(SYSTEM_LABELS.SPAM),
    inReplyTo: row.inReplyTo,
    references: row.references,
    isReply: row.isReply ?? false,
    isForwarded: row.isForwarded ?? false,
    priority: row.priority,
    sizeBytes: row.sizeBytes,
    spfStatus: row.spfStatus,
    dkimStatus: row.dkimStatus,
    dmarcStatus: row.dmarcStatus,
    sendStatus: row.sendStatus,
    scheduledFor: row.scheduledFor ? row.scheduledFor.getTime() : null,
    triggerRunId: row.triggerRunId,
    idempotencyKey: row.idempotencyKey,
    delivery: row.deliveryStatus
      ? { status: row.deliveryStatus, detail: row.deliveryDetail ?? '', at: (row.deliveryUpdatedAt ?? row.updatedAt).getTime() }
      : null,
    bodies,
    searchText: computeSearchText(row.textBody, row.htmlBody),
    attachments: attachments.map((a) => toAttachmentInput(a, row.id)),
    subscription: null, // subscriptions are copied in their own phase, not folded into ingest here
    extra: {
      headers: row.headers ?? undefined,
      customFields: row.customFields ?? undefined,
      clickedLinks: row.clickedLinks ?? undefined,
      conversationId: row.conversationId ?? undefined,
    },
  };
}

/** The full set of mutable fields a Postgres row carries, as an object-row patch — used by the LWW merge below and importable by `./parity.ts`'s repair. */
export function legacyRowPatch(row: MailMessage): Partial<MessageRow> {
  const labels = normalizeLegacy({
    labels: row.labels,
    isStarred: row.isStarred,
    isImportant: row.isImportant,
    isTrash: row.isTrash,
    isSpam: row.isSpam,
  });
  return {
    ...labelPatch(labels),
    is_read: toBit(row.isRead),
    is_flagged: toBit(row.isFlagged ?? false),
    subject: row.subject,
    subject_norm: bareSubject(row.subject ?? '').toLowerCase() || null,
    preview: row.preview,
    categories_json: row.categories ? toJson(row.categories) : null,
    send_status: row.sendStatus,
    scheduled_for: row.scheduledFor ? row.scheduledFor.getTime() : null,
    trigger_run_id: row.triggerRunId,
    delivery_status: row.deliveryStatus,
    delivery_detail: row.deliveryDetail,
    delivery_updated_at: row.deliveryUpdatedAt ? row.deliveryUpdatedAt.getTime() : null,
    snoozed_until: row.snoozedUntil ? row.snoozedUntil.getTime() : null,
    snoozed_at: row.snoozedAt ? row.snoozedAt.getTime() : null,
    unsnoozed_at: row.unsnoozedAt ? row.unsnoozedAt.getTime() : null,
    unsnoozed_early: row.unsnoozedEarly === null || row.unsnoozedEarly === undefined ? null : toBit(row.unsnoozedEarly),
    resnoozed_at: row.resnoozedAt ? row.resnoozedAt.getTime() : null,
    deleted_at: row.deletedAt ? row.deletedAt.getTime() : null,
    extra_json: toJson({
      headers: row.headers ?? null,
      customFields: row.customFields ?? null,
      clickedLinks: row.clickedLinks ?? null,
      conversationId: row.conversationId ?? null,
    }),
  };
}

/**
 * Insert-if-absent (via the public `ingest` op, idempotent on replay) or an
 * LWW merge against an already-live row, gated by `row.updatedAt` versus
 * EVERY clock group (design §4: "overwrite the mutable groups when
 * pg.updated_at ≥ max(clk_*)"). Both branches are expected even on the very
 * first `messages` pass, not just on resume: a message dual-written live
 * (shadow mode) while backfill is still working through older pages reaches
 * this function's cursor already ingested by the router, and must be merged,
 * not re-inserted.
 *
 * A Postgres-side soft delete is applied as a second op right after the
 * insert, at the row's own `deletedAt` (not `at`), so a trashed-and-forgotten
 * historical message still ends up correctly `deleted_at`-marked in the
 * object — full parity (§4) compares deleted state, so backfill must not
 * silently skip it.
 */
export function applyPgRow(
  storage: WritableStorage,
  ref: MailboxRef,
  row: MailMessage,
  attachments: MailAttachment[],
  bodies: BodyBits,
  now: number,
): void {
  const existing = loadMessageRow(storage.sql, row.id);
  if (!existing) {
    const message = toIngestMessage(row, attachments, bodies);
    const result = applyMailboxOp(storage, ref, { kind: 'ingest', message }, now);
    if (row.deletedAt && result.ingest?.created) {
      applyMailboxOp(storage, ref, { kind: 'delete', ids: [row.id], hard: false }, row.deletedAt.getTime());
    }
    return;
  }
  const mergeAt = row.updatedAt.getTime();
  storage.transactionSync(() => changeMessage(storage.sql, ref, row.id, CLOCK_GROUPS, mergeAt, () => legacyRowPatch(row)));
}

// ---------------------------------------------------------------------------
// Subscriptions / drafts (one-shot and cursor-paged copies — design §4 steps 1-2)
// ---------------------------------------------------------------------------

function toSubscriptionValues(row: MailSubscription): SubscriptionValues {
  return {
    senderEmail: row.senderEmail,
    senderName: row.senderName,
    senderDomain: row.senderDomain,
    listId: row.listId,
    unsubscribeUrl: row.unsubscribeUrl,
    unsubscribeMailto: row.unsubscribeMailto,
    oneClick: row.oneClick,
    messageCount: row.messageCount,
    lastSubject: row.lastSubject,
    firstReceivedAt: row.firstReceivedAt,
    lastReceivedAt: row.lastReceivedAt,
  };
}

async function tickSubscriptions(storage: WritableStorage, db: Database, ref: MailboxRef, state: BackfillState, now: number): Promise<BackfillState> {
  const rows = await listSubscriptionsRows(db, ref.accountId);
  if (rows.length > 0) {
    const results = applyMailboxOp(storage, ref, { kind: 'subscription.upsert', values: rows.map(toSubscriptionValues) }, now).applied;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const objectId = results[i];
      if (objectId && row.status === 'unsubscribed') {
        applyMailboxOp(
          storage,
          ref,
          {
            kind: 'subscription.status',
            id: objectId,
            patch: {
              status: 'unsubscribed',
              method: row.unsubscribeMethod ?? 'link',
              at: (row.unsubscribedAt ?? row.updatedAt).getTime(),
              by: row.unsubscribedBy ?? 'backfill',
            },
          },
          now,
        );
      }
    }
  }
  return {
    ...state,
    phase: 'drafts',
    copied: { ...state.copied, subscriptions: state.copied.subscriptions + rows.length },
  };
}

function toDraftInput(row: MailDraft): DraftInput & { id: string } {
  return {
    id: row.id,
    accountId: row.accountId,
    subject: row.subject ?? undefined,
    to: row.to ?? undefined,
    cc: row.cc ?? undefined,
    bcc: row.bcc ?? undefined,
    replyTo: row.replyTo ?? undefined,
    body: row.body ?? undefined,
    htmlBody: row.htmlBody ?? undefined,
    importance: (row.importance as DraftInput['importance']) ?? undefined,
    labels: row.labels ?? undefined,
    attachmentIds: row.attachmentIds ?? undefined,
    inReplyTo: row.inReplyTo ?? undefined,
    originalMessageId: row.originalMessageId ?? undefined,
    isReply: row.isReply ?? undefined,
    isForward: row.isForward ?? undefined,
  };
}

async function tickDrafts(storage: WritableStorage, db: Database, ref: MailboxRef, state: BackfillState, now: number): Promise<BackfillState> {
  const page = await listDraftRows(db, { accountId: ref.accountId, limit: DRAFTS_PAGE_SIZE, cursor: state.draftsCursor ?? undefined });
  for (const row of page.data) {
    applyMailboxOp(storage, ref, { kind: 'draft.create', draft: toDraftInput(row) }, row.updatedAt.getTime());
  }
  const copied = { ...state.copied, drafts: state.copied.drafts + page.data.length };
  if (page.cursor === null) {
    return { ...state, phase: 'messages', draftsCursor: null, copied, pgWatermark: now };
  }
  return { ...state, draftsCursor: page.cursor, copied };
}

// ---------------------------------------------------------------------------
// Messages (paged by createdAt,id — design §4 step 3)
// ---------------------------------------------------------------------------

interface MessagesPage {
  rows: MailMessage[];
  attachmentsByMessage: Map<string, MailAttachment[]>;
  nextCursor: MessagesCursor | null;
}

async function fetchAttachmentsFor(db: Database, messageIds: string[]): Promise<Map<string, MailAttachment[]>> {
  const byMessage = new Map<string, MailAttachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select()
    .from(mailAttachments)
    .where(and(inArray(mailAttachments.messageId, messageIds), isNull(mailAttachments.deletedAt)));
  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push(row);
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}

async function fetchMessagesPage(db: Database, accountId: string, cursor: MessagesCursor | null, limit: number): Promise<MessagesPage> {
  const conditions = [eq(mailMessages.accountId, accountId)];
  if (cursor) {
    const cursorDate = new Date(cursor.createdAt);
    conditions.push(or(gt(mailMessages.createdAt, cursorDate), and(eq(mailMessages.createdAt, cursorDate), gt(mailMessages.id, cursor.id)))!);
  }
  const rows = await db
    .select()
    .from(mailMessages)
    .where(and(...conditions))
    .orderBy(asc(mailMessages.createdAt), asc(mailMessages.id))
    .limit(limit);
  const attachmentsByMessage = await fetchAttachmentsFor(db, rows.map((r) => r.id));
  const last = rows.at(-1);
  const nextCursor: MessagesCursor | null = rows.length < limit || !last ? null : { createdAt: last.createdAt.getTime(), id: last.id };
  return { rows, attachmentsByMessage, nextCursor };
}

async function tickMessages(storage: WritableStorage, env: BackfillEnv, db: Database, ref: MailboxRef, state: BackfillState, now: number): Promise<BackfillState> {
  const page = await fetchMessagesPage(db, ref.accountId, state.messagesCursor, MESSAGES_PAGE_SIZE);
  for (const row of page.rows) {
    const attachments = page.attachmentsByMessage.get(row.id) ?? [];
    // eslint-disable-next-line no-await-in-loop -- bounded by MESSAGES_PAGE_SIZE; each row's R2 check must complete before the row's ingest op decides its `bodies` bits
    const bodies = await ensureBodiesInR2(env.MAIL_STORAGE, ref, row);
    applyPgRow(storage, ref, row, attachments, bodies, now);
  }
  const copied = { ...state.copied, messages: state.copied.messages + page.rows.length };
  if (page.nextCursor === null) {
    return { ...state, phase: 'catchup', state: 'catchup', messagesCursor: null, copied, pgWatermark: state.pgWatermark ?? now };
  }
  return { ...state, messagesCursor: page.nextCursor, copied };
}

// ---------------------------------------------------------------------------
// Catch-up (design §4 step 4)
// ---------------------------------------------------------------------------

async function fetchCatchupPage(db: Database, accountId: string, since: number, cursor: MessagesCursor | null, limit: number): Promise<MessagesPage> {
  const conditions = [eq(mailMessages.accountId, accountId), gte(mailMessages.updatedAt, new Date(since))];
  if (cursor) {
    const cursorDate = new Date(cursor.createdAt);
    conditions.push(or(gt(mailMessages.updatedAt, cursorDate), and(eq(mailMessages.updatedAt, cursorDate), gt(mailMessages.id, cursor.id)))!);
  }
  const rows = await db
    .select()
    .from(mailMessages)
    .where(and(...conditions))
    .orderBy(asc(mailMessages.updatedAt), asc(mailMessages.id))
    .limit(limit);
  const attachmentsByMessage = await fetchAttachmentsFor(db, rows.map((r) => r.id));
  const last = rows.at(-1);
  const nextCursor: MessagesCursor | null = rows.length < limit || !last ? null : { createdAt: last.updatedAt.getTime(), id: last.id };
  return { rows, attachmentsByMessage, nextCursor };
}

async function tickCatchup(storage: WritableStorage, env: BackfillEnv, db: Database, ref: MailboxRef, state: BackfillState, now: number): Promise<BackfillState> {
  const since = (state.pgWatermark ?? state.startedAt ?? now) - CATCHUP_LOOKBACK_MS;
  const page = await fetchCatchupPage(db, ref.accountId, since, state.catchupCursor, MESSAGES_PAGE_SIZE);
  for (const row of page.rows) {
    const attachments = page.attachmentsByMessage.get(row.id) ?? [];
    // eslint-disable-next-line no-await-in-loop -- see tickMessages
    const bodies = await ensureBodiesInR2(env.MAIL_STORAGE, ref, row);
    applyPgRow(storage, ref, row, attachments, bodies, now);
  }
  const copied = { ...state.copied, catchup: state.copied.catchup + page.rows.length };
  if (page.nextCursor === null) {
    const stub = mailIndexFor(env, ref.workspaceId);
    if (stub) {
      try {
        await stub.ensureCorrespondentsSeeded(ref.workspaceId, 'mailbox-backfill');
      } catch (err) {
        // Best-effort: the mail index catches up on its own schedule too; a
        // failure here must not keep this mailbox's backfill from completing.
        console.warn('[mailbox-store] backfill: ensureCorrespondentsSeeded failed:', err instanceof Error ? err.message : err);
      }
    }
    return { ...state, phase: 'done', state: 'done', catchupCursor: null, copied, finishedAt: now };
  }
  return { ...state, catchupCursor: page.nextCursor, copied };
}

// ---------------------------------------------------------------------------
// One alarm tick (called from alarm.ts's runContinuation)
// ---------------------------------------------------------------------------

/**
 * Does one bounded unit of backfill work and persists the result to
 * `meta.backfill`. Never throws: a failure is recorded on the state
 * (`attempts`, `lastError`, `nextAttemptAt` per the backoff tiers above) so
 * the object's own alarm scheduling (`alarm.ts`'s `nextBackfillAlarmAt`) waits
 * before retrying, exactly like `MailIndex.alarm()`'s seeding retry.
 */
export async function tickBackfill(storage: WritableStorage, env: BackfillEnv, ref: MailboxRef, now: number): Promise<void> {
  const state = getBackfillState(storage.sql);
  if (state.state !== 'running' && state.state !== 'catchup') return;
  if (state.nextAttemptAt && now < state.nextAttemptAt) return;

  try {
    const reader = env.tenantDbReader ?? defaultTenantDbReader(env);
    const db = await reader(ref.workspaceId);
    let next: BackfillState;
    switch (state.phase) {
      case 'subscriptions':
        next = await tickSubscriptions(storage, db, ref, state, now);
        break;
      case 'drafts':
        next = await tickDrafts(storage, db, ref, state, now);
        break;
      case 'messages':
        next = await tickMessages(storage, env, db, ref, state, now);
        break;
      case 'catchup':
      case 'done':
        next = await tickCatchup(storage, env, db, ref, state, now);
        break;
      default: {
        const exhaustive: never = state.phase;
        throw new Error(`tickBackfill: unhandled phase: ${JSON.stringify(exhaustive)}`);
      }
    }
    setBackfillState(storage.sql, { ...next, attempts: 0, lastError: null, nextAttemptAt: null });
  } catch (err) {
    const attempts = state.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (attempts >= MAX_ATTEMPTS) {
      setBackfillState(storage.sql, { ...state, state: 'failed', attempts, lastError: message, nextAttemptAt: null });
      console.error('[mailbox-store] backfill failed permanently:', `${ref.workspaceId}:${ref.accountId}:`, message);
    } else {
      setBackfillState(storage.sql, { ...state, attempts, lastError: message, nextAttemptAt: now + backoffMs(attempts) });
    }
  }
}

// ---------------------------------------------------------------------------
// rebuild (admin only — design §9 task C4: "wipe the object's tables and re-run backfill")
// ---------------------------------------------------------------------------

/** Every table a rebuild wipes, in an order that respects no foreign keys (SQLite here has none, but this keeps the list legible as "data tables, derived tables, then bookkeeping"). */
const REBUILD_TABLES = [
  'message_labels',
  'message_addresses',
  'thread_labels',
  'label_counts',
  'threads',
  'attachments',
  'subscriptions',
  'drafts',
  'messages_fts_meta',
  'messages_fts_body',
  'outbox',
  'pg_drift',
  'messages',
] as const;

/**
 * Wipes every data table this object owns (keeping `meta`'s own bookkeeping
 * keys — `schema_version`, `workspace_id`, `account_id`, `clerk_org_id` — so
 * the object stays bound to the same mailbox) and restarts backfill from
 * scratch. Unlike `startBackfill({force: true})` (which only resets the
 * backfill cursors and re-ingests/merges over whatever is already there),
 * this actually deletes the object's rows first — the admin-only "something
 * is badly wrong, start over" button.
 */
export function rebuildMailbox(storage: WritableStorage, now: number): BackfillState {
  storage.transactionSync(() => {
    for (const table of REBUILD_TABLES) storage.sql.exec(`DELETE FROM ${table}`);
  });
  const next: BackfillState = { ...IDLE_STATE, state: 'running', phase: 'subscriptions', startedAt: now, source: 'rebuild-admin' };
  setBackfillState(storage.sql, next);
  return next;
}
