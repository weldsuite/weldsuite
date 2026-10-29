/**
 * Shared "send + persist" helper for outbound mail.
 *
 * Both `POST /api/mail-accounts/:id/send` (compose) and `POST
 * /api/mail-messages/:id/reply` end up doing the same work: validate
 * recipients, resolve R2-uploaded attachments, hand the envelope to the
 * Cloudflare `send_email` binding, persist a `SENT` copy on the account,
 * stitch threading, bump the daily counter, and upsert recipients into the
 * shared `people` table.
 *
 * Keeping this in one place means a fix to the send path (e.g. a new
 * header, a different attachment cap) lands in one file rather than two.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ExecutionContext } from 'hono';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { getStoredObject } from '@weldsuite/worker-kit/storage';
import { getRawMime, type MailBodyRef } from './store/bodies';
import type { IngestMessage, MailboxStore, MailStoreMode } from './store/types';
import * as cfEmail from '@weldsuite/worker-email';
import { sanitizeEmailHtml } from '@weldsuite/email/sanitize';
import { buildRfc5322 } from '@weldsuite/email/core/mime';
import { ProviderRefusedError, TransientProviderError } from '@weldsuite/email';
import type { MailDeliveryStatus } from '@weldsuite/db/schema/mail-messages';
import type {
  OutboundDenialCode,
  OutboundKind,
  OutboundSource,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { escapeHtml, htmlToText, looksLikeHtml, plainTextBody } from './text';
import { validateRecipients, type RecipientValidationEnv } from './recipient-validation';
import { upsertMailContacts, type MailContactsEnv } from './contacts';
import { principalHasAccess, principalIsAdmin, toPrincipal, type MailCaller } from './access';
import { isSenderDomainVerified } from './accounts';
import { getDraft, softDeleteDraft } from './drafts';
import {
  OutboundDeniedError,
  checkOutbound,
  commitOutbound,
  releaseOutbound,
  tripPlatformBreaker,
  type OutboundGuardEnv,
  type OutboundReservation,
} from './outbound/guard';

/**
 * The bindings the send helpers read: the Cloudflare send binding
 * (@weldsuite/worker-email), the MX-lookup cache, the R2 bucket for
 * attachments and contact avatars, and the outbound guard's Durable Objects
 * (docs/plans/weldmail-outbound-abuse.md). Any worker Env with them fits.
 */
export interface MailSendEnv
  extends cfEmail.WorkerEmailEnv,
    RecipientValidationEnv,
    MailContactsEnv,
    OutboundGuardEnv {
  /** Private uploads (compose attachments); read with the public bucket as fallback. */
  PRIVATE_STORAGE?: R2Bucket;
  /** EU-jurisdiction bucket holding raw MIME and bodies (store/bodies.ts). */
  MAIL_STORAGE?: R2Bucket;
}

const { mailAccounts, mailAttachments, mailMessages } = schema;

/** 5 MiB total — body + attachments. Matches the client-side guard. */
export const MAX_EMAIL_SIZE_BYTES = 5 * 1024 * 1024;

export class MailSendError extends Error {
  constructor(
    public readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'FORBIDDEN'
      | 'INVALID_RECIPIENTS'
      | 'ATTACHMENT_NOT_IN_WORKSPACE'
      | 'ATTACHMENT_NOT_IN_STORAGE'
      | 'EMAIL_TOO_LARGE'
      | 'STORAGE_BINDING_MISSING'
      | 'SEND_BINDING_MISSING'
      | 'DAILY_LIMIT_REACHED'
      | 'SENDER_DOMAIN_NOT_VERIFIED'
      | 'DRAFT_NOT_FOUND'
      // The outbound guard refused (details: OutboundDenialDetails).
      | OutboundDenialCode
      // Cloudflare refused: its rate limit (retry in a minute), its daily quota.
      | 'PROVIDER_RATE_LIMITED'
      | 'PROVIDER_DAILY_LIMIT'
      // Some recipients got it before the send failed (details: { sent, failed, messageId }).
      | 'PARTIALLY_SENT',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

export interface SendAttachmentInput {
  filename: string;
  contentType?: string;
  size: number;
  /** R2 object key returned by `POST /api/storage/generate-upload-url`. */
  fileKey: string;
}

export interface SendComposeInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  importance?: 'low' | 'normal' | 'high';
  attachments?: SendAttachmentInput[];
  /**
   * Client-generated idempotency key. When present, a replayed send with the
   * same key (offline-queue flush, or a retry after a dropped response) returns
   * the already-sent message instead of sending again.
   */
  idempotencyKey?: string;
}

export interface SendResult {
  messageId: string;
  smtpMessageId: string;
  externalMessageId: string;
  /** Account the message was sent from — handy for entity event payloads. */
  accountId: string;
  /** Final subject the caller can echo back without re-deriving Re: prefixes. */
  subject: string;
  pendingVerification: boolean;
}

/**
 * Send a composed message from an account, persist the SENT copy, return
 * the new internal `messageId`. Used by the account-level compose endpoint.
 *
 * `opts.waitUntil` is passed explicitly (rather than reading from a Hono context)
 * so this helper can also be called from a workflow or queue consumer.
 * When `waitUntil` is unavailable the contact upsert runs inline — slower
 * but correct.
 */
/**
 * Options for the send helpers.
 *
 * `dryRun` is a TEST-ONLY escape hatch: it skips the live MX lookup and the
 * Cloudflare `send_email` transmit, but runs every other step for real
 * (recipient format validation, R2 attachment resolution + size cap, SENT
 * message + attachment-row persistence, threading, counters). It exists so the
 * `/test-fixtures/mail/*` endpoints can exercise the genuine send+persist path
 * in an environment without a verified sending domain or real delivery. The
 * production routes (`/api/mail-accounts/:id/send`, reply, forward) never pass
 * it, so prod behaviour is unchanged.
 */
export interface SendOptions {
  dryRun?: boolean;
  /**
   * Runs the recipient-contact upsert in the background. Without it the
   * upsert runs inline, which is slower but still correct.
   */
  waitUntil?: ExecutionContext['waitUntil'];
  /**
   * Attachments the server supplies itself (a forwarded message's files, a
   * generated `.eml`) rather than ones the client uploaded. They are sent,
   * count towards the size cap, and are stored as the sent copy's own objects.
   */
  extraAttachments?: InlineAttachment[];
  /**
   * Refuse the send once the account has sent `dailySendLimit` messages since
   * UTC midnight (`DAILY_LIMIT_REACHED`). The public API sets it; the WeldMail
   * UI does not. Counted live from the SENT copies, because `sentToday` has no
   * daily reset job. Deleting a sent message does not give the send back.
   */
  enforceDailyLimit?: boolean;
  /**
   * Refuse to send from an address whose domain is not a verified WeldMail
   * domain of the workspace (`SENDER_DOMAIN_NOT_VERIFIED`). Cloudflare sends as
   * `account.email` whatever the provider, so mail "from" `@gmail.com` or an
   * unverified domain fails SPF/DMARC. The public API sets it.
   */
  requireVerifiedDomain?: boolean;
  /**
   * How the outbound guard labels this send. `source` defaults to `compose`
   * (`reply` / `forward` for those helpers); `kind` is worked out from the
   * thread when left out. `workspaceId` (master id) saves a lookup.
   */
  outbound?: { source?: OutboundSource; kind?: OutboundKind; workspaceId?: string | null };
  /**
   * The sending account's mailbox store
   * (docs/plans/weldmail-mailbox-store-design.md, task D1). When supplied,
   * the SENT copy (and its attachments) is persisted through `store.apply`
   * (an `ingest` op, source `sent`) instead of a direct Postgres insert, and
   * the idempotency lookup, the daily-limit count and thread stitching also
   * go through it — so the same code runs in every mailbox-store mode.
   * Optional so a caller that cannot resolve a store yet (external-api, until
   * task D5 lands) keeps working on today's direct-Postgres path unchanged.
   * `forwardAndPersist`/`replyAndPersist` also use it to load the original
   * message and its attachments, so forwarding/replying still works once a
   * workspace's Postgres row for that message is stale or absent.
   */
  store?: MailboxStore;
  /**
   * The workspace's resolved mailbox-store mode, handed straight to the
   * outbound guard's `checkOutbound` (design §0.1/§9) so its `MailIndex` can
   * answer "first contact" authoritatively once a workspace is `object-only`.
   * Left unset, the guard treats it as `postgres` — today's behaviour.
   */
  mailStoreMode?: MailStoreMode;
}

export interface InlineAttachment {
  filename: string;
  contentType?: string;
  content: ArrayBuffer;
}

/**
 * Look up a previously-sent message by its client idempotency key and rebuild
 * the SendResult from it, so a replayed send returns the original outcome
 * without re-transmitting. Returns null when the key hasn't been seen.
 */
export async function findSentByIdempotencyKey(
  db: Database,
  accountId: string,
  idempotencyKey: string,
): Promise<SendResult | null> {
  const [existing] = await db
    .select({
      id: mailMessages.id,
      messageId: mailMessages.messageId,
      externalMessageId: mailMessages.externalMessageId,
      subject: mailMessages.subject,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (!existing) return null;
  return {
    messageId: existing.id,
    smtpMessageId: existing.messageId,
    externalMessageId: existing.externalMessageId ?? '',
    accountId,
    subject: existing.subject ?? '(No subject)',
    pendingVerification: false,
  };
}

/**
 * {@link findSentByIdempotencyKey}, through the store when one is supplied
 * (`MailboxStore.findSentByIdempotencyKey`), else the direct-Postgres
 * function above, unchanged.
 */
async function findExistingSent(
  db: Database,
  store: MailboxStore | undefined,
  accountId: string,
  idempotencyKey: string,
): Promise<SendResult | null> {
  if (!store) return findSentByIdempotencyKey(db, accountId, idempotencyKey);
  const existing = await store.findSentByIdempotencyKey(idempotencyKey);
  if (!existing) return null;
  return {
    messageId: existing.id,
    smtpMessageId: existing.rfcMessageId,
    externalMessageId: existing.externalMessageId ?? '',
    accountId,
    subject: existing.subject ?? '(No subject)',
    pendingVerification: false,
  };
}

type ResolvedAttachment = { filename: string; contentType?: string; content: ArrayBuffer; fileKey: string };
type MailAccountRow = typeof mailAccounts.$inferSelect;
type TransmitResult = Awaited<ReturnType<typeof cfEmail.sendEmail>>;

/** Load the account and make sure the caller may send from it (otherwise it looks like it doesn't exist). */
async function loadSendableAccount(db: Database, caller: MailCaller, accountId: string): Promise<MailAccountRow> {
  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) throw new MailSendError('ACCOUNT_NOT_FOUND', 'Mail account not found');

  const principal = toPrincipal(caller);
  if (!principalHasAccess(account, principal, await principalIsAdmin(db, principal))) {
    throw new MailSendError('ACCOUNT_NOT_FOUND', 'Mail account not found');
  }
  return account;
}

/** Start of the current UTC day: the window the daily send limit counts over. */
export function utcDayStart(now = new Date()): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/**
 * Messages the account sent since UTC midnight, deleted ones included.
 * Scheduled rows are stored as SENT copies up front; they count once they
 * actually went out (`sendStatus` 'sent'), not while scheduled, cancelled or failed.
 */
export async function countSentToday(db: Database, accountId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        eq(mailMessages.source, 'sent'),
        or(isNull(mailMessages.sendStatus), eq(mailMessages.sendStatus, 'sent')),
        sql`${mailMessages.sentDate} >= ${utcDayStart(now)}`,
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * The opt-in send policies (see {@link SendOptions}). Runs after the
 * idempotency short-circuit, so replaying a send that already went out never
 * fails on the limit.
 */
async function assertSendPolicy(db: Database, store: MailboxStore | undefined, account: MailAccountRow, opts: SendOptions | undefined): Promise<void> {
  if (opts?.requireVerifiedDomain && !(await isSenderDomainVerified(db, account.email))) {
    throw new MailSendError(
      'SENDER_DOMAIN_NOT_VERIFIED',
      `This account's address (${account.email}) is not on a verified WeldMail domain, so it can't send through the API.`,
    );
  }
  if (opts?.enforceDailyLimit) {
    const limit = account.dailySendLimit ?? 500;
    // Through the store (`countSentSince`) when one is supplied, so the count
    // comes from the object in object modes; otherwise the direct Postgres
    // query, byte-identical to before.
    const sent = store ? await store.countSentSince(utcDayStart().getTime()) : await countSentToday(db, account.id);
    if (sent >= limit) {
      throw new MailSendError('DAILY_LIMIT_REACHED', `This account reached its daily send limit of ${limit}.`, {
        limit,
        sent,
        resetsAt: new Date(utcDayStart().getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
    }
  }
}

/**
 * `reply` only when answering a message someone sent to this mailbox. A
 * follow-up on the mailbox's own sent mail ("just bumping this") starts no
 * new relationship but isn't a reply either: it counts as a new conversation.
 */
async function outboundKindOf(db: Database, accountId: string, data: SendComposeInput): Promise<OutboundKind> {
  if (!data.inReplyTo) return 'new_thread';
  const [parent] = await db
    .select({ source: mailMessages.source })
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.messageId, data.inReplyTo)))
    .limit(1);
  return parent && parent.source !== 'sent' ? 'reply' : 'new_thread';
}

/** Run the outbound guard; its refusals become MailSendErrors with the same code. */
async function reserveOutbound(
  env: MailSendEnv,
  db: Database,
  orgId: string,
  account: MailAccountRow,
  data: SendComposeInput,
  body: { html: string | undefined; text: string | undefined },
  opts: SendOptions | undefined,
): Promise<OutboundReservation> {
  try {
    return await checkOutbound(env, db, {
      subject: { kind: 'workspace', clerkOrgId: orgId, workspaceId: opts?.outbound?.workspaceId ?? null },
      source: opts?.outbound?.source ?? 'compose',
      kind: opts?.outbound?.kind ?? (await outboundKindOf(db, account.id, data)),
      from: account.email,
      to: data.to,
      cc: data.cc,
      bcc: data.bcc,
      subjectLine: data.subject,
      text: body.text,
      html: body.html,
      attachments: data.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType })),
      senderDailyCap: account.dailySendLimit,
      mailStoreMode: opts?.mailStoreMode,
    });
  } catch (err) {
    if (err instanceof OutboundDeniedError) throw new MailSendError(err.code, err.message, err.details);
    throw err;
  }
}

/** Cloudflare's named refusals as MailSendErrors; anything else is rethrown as it is. */
async function transmitFailure(env: MailSendEnv, err: unknown): Promise<unknown> {
  if (!(err instanceof ProviderRefusedError)) return err;
  switch (err.refusal) {
    case 'rate_limited':
      return new MailSendError('PROVIDER_RATE_LIMITED', 'Outbound mail is being rate-limited. Try again in a minute.', {
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
      });
    case 'daily_limit':
      await tripPlatformBreaker(env, 'Cloudflare refused a send with E_DAILY_LIMIT_EXCEEDED.');
      return new MailSendError('PROVIDER_DAILY_LIMIT', 'Outbound mail is unavailable for the rest of the day. Try again later.');
    case 'sender_not_allowed':
      return new MailSendError(
        'SENDER_DOMAIN_NOT_VERIFIED',
        "This account's domain is not set up for sending.",
      );
    case 'recipient_suppressed':
      return new MailSendError('RECIPIENT_SUPPRESSED', 'A recipient cannot be emailed: earlier mail to it bounced or was reported as spam.', {
        code: 'RECIPIENT_SUPPRESSED',
        recipients: [err.recipient],
      });
  }
}

function buildExtraHeaders(data: SendComposeInput): Record<string, string> | undefined {
  const extraHeaders: Record<string, string> = {};
  if (data.inReplyTo) extraHeaders['In-Reply-To'] = data.inReplyTo;
  if (data.references?.length) extraHeaders['References'] = data.references.join(' ');
  return Object.keys(extraHeaders).length ? extraHeaders : undefined;
}

/** Hand the envelope to the Cloudflare `send_email` binding (or fake it under dry-run). */
function transmitEmail(
  env: MailSendEnv,
  account: MailAccountRow,
  data: SendComposeInput,
  body: { html: string | undefined; text: string | undefined },
  attachments: InlineAttachment[],
  dryRun: boolean | undefined,
): Promise<TransmitResult> {
  if (dryRun) {
    return Promise.resolve({ messageId: `<dryrun-${generateId('msg')}@e2e.test>`, pendingVerification: false });
  }
  const fromAddress = account.displayName ? `${account.displayName} <${account.email}>` : account.email;
  return cfEmail.sendEmail(env, {
    from: fromAddress,
    to: data.to,
    subject: data.subject || '(No subject)',
    html: body.html,
    text: body.text,
    cc: data.cc,
    bcc: data.bcc,
    replyTo: data.replyTo,
    headers: buildExtraHeaders(data),
    attachments: attachments.length
      ? attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: a.content,
        }))
      : undefined,
  });
}

/**
 * Thread stitching: replies inherit the parent's thread, anything else starts
 * its own. Through the store's `findByRfcIds` when one is supplied — which,
 * unlike this function's own direct-Postgres fallback, does not look at the
 * legacy `mailcowMessageId` column (store/postgres/inbound.ts's own doc
 * comment: a deliberate, already-accepted gap for that Mailcow-sync-only
 * column, same as the mailbox object and its parity checks treat it).
 */
async function resolveThreadId(
  db: Database,
  store: MailboxStore | undefined,
  accountId: string,
  data: SendComposeInput,
  fallbackThreadId: string,
): Promise<string> {
  const lookupIds = [...(data.inReplyTo ? [data.inReplyTo] : []), ...(data.references ?? [])];
  if (lookupIds.length === 0) return fallbackThreadId;

  const providerIds = lookupIds
    .map((id) => id.replace(/^</, '').replace(/@[\s\S]*/, ''))
    .filter(Boolean);

  if (store) {
    const matches = await store.findByRfcIds(lookupIds, providerIds);
    return matches[0]?.threadId || fallbackThreadId;
  }

  const [parent] = await db
    .select({ threadId: mailMessages.threadId })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        or(
          inArray(mailMessages.messageId, lookupIds),
          inArray(mailMessages.mailcowMessageId, providerIds),
        ),
      ),
    )
    .limit(1);
  return parent?.threadId || fallbackThreadId;
}

interface SentCopyInput {
  messageId: string;
  smtpMessageId: string;
  externalMessageId: string;
  threadId: string;
  htmlBody: string | undefined;
  textBody: string | undefined;
  /** Every attachment the sent copy owns — the server-supplied ones too. */
  attachments: ResolvedAttachment[];
  now: Date;
  /** Known at send time: a partial send, or recipients Cloudflare skipped. */
  delivery?: { status: MailDeliveryStatus; detail: string };
}

/** `ResolvedAttachment` → the `IngestMessage.attachments` row shape, same fields {@link persistAttachmentPointers} writes. */
function toAttachmentInput(
  messageId: string,
  att: ResolvedAttachment,
): IngestMessage['attachments'][number] {
  return {
    id: generateId('attach'),
    messageId,
    fileName: att.filename,
    contentType: att.contentType || 'application/octet-stream',
    size: att.content.byteLength,
    storagePath: att.fileKey,
    isInline: false,
  };
}

/**
 * Persist the SENT copy and its attachments. Returns the already-persisted
 * result when a concurrent send with the same idempotency key won the
 * unique-index race, otherwise null.
 *
 * Through `store.apply` (an `ingest` op, source `sent`) when a store is
 * supplied — the message row and its attachments land in one op, same as an
 * inbound ingest (design docs/plans/weldmail-mailbox-store-design.md, task
 * D1). Without one (external-api until task D5 lands), the direct-Postgres
 * path below is unchanged: the message row, then
 * {@link persistAttachmentPointers}'s best-effort attachment inserts.
 */
/** `persistSentCopy`'s mailbox-store path: ingest through the store, same idempotency-key race recovery as the direct-Postgres path. */
async function persistSentCopyViaStore(
  db: Database,
  store: MailboxStore,
  account: MailAccountRow,
  data: SendComposeInput,
  copy: SentCopyInput,
  textPreview: string,
): Promise<SendResult | null> {
  const { messageId, smtpMessageId, externalMessageId, threadId, htmlBody, textBody, attachments, now, delivery } = copy;
  const message: IngestMessage = {
    id: messageId,
    source: 'sent',
    rfcMessageId: smtpMessageId,
    externalMessageId,
    threadId,
    from: { email: account.email, name: account.displayName || undefined },
    to: data.to.map((email) => ({ email })),
    cc: data.cc?.map((email) => ({ email })) ?? null,
    bcc: data.bcc?.map((email) => ({ email })) ?? null,
    subject: data.subject || '(No subject)',
    preview: textPreview,
    sentAt: now.getTime(),
    receivedAt: null,
    createdAt: now.getTime(),
    isRead: true,
    labels: ['SENT'],
    isSpam: false,
    inReplyTo: data.inReplyTo ?? null,
    references: data.references ?? null,
    isReply: !!data.inReplyTo,
    idempotencyKey: data.idempotencyKey ?? null,
    delivery: delivery ? { status: delivery.status, detail: delivery.detail.slice(0, 500), at: now.getTime() } : null,
    // Worker-side only (never sent over RPC): the Postgres store writes
    // these straight to `textBody`/`htmlBody`; the object store puts them
    // to `MAIL_STORAGE` itself and derives `searchText` from them.
    content: { html: htmlBody, text: textBody },
    attachments: attachments.map((att) => toAttachmentInput(messageId, att)),
    subscription: null,
  };
  try {
    await store.apply({ kind: 'ingest', message }, now.getTime());
    return null;
  } catch (insertErr) {
    // Same race as the direct-Postgres path below: a concurrent send with
    // the same idempotency key won the unique index inside the store's own
    // insert (which only de-dupes on `id`, generated fresh per attempt).
    if (!data.idempotencyKey) throw insertErr;
    const existing = await findExistingSent(db, store, account.id, data.idempotencyKey);
    if (!existing) throw insertErr;
    return existing;
  }
}

/** `persistSentCopy`'s direct-Postgres path. */
async function persistSentCopyViaPostgres(
  db: Database,
  account: MailAccountRow,
  data: SendComposeInput,
  copy: SentCopyInput,
  textPreview: string,
): Promise<SendResult | null> {
  const { messageId, smtpMessageId, externalMessageId, threadId, htmlBody, textBody, attachments, now, delivery } = copy;
  try {
    await db.insert(mailMessages).values({
      id: messageId,
      accountId: account.id,
      labels: ['SENT'],
      messageId: smtpMessageId,
      threadId,
      from: { email: account.email, name: account.displayName || undefined },
      to: data.to.map((email) => ({ email })),
      cc: data.cc?.map((email) => ({ email })),
      bcc: data.bcc?.map((email) => ({ email })),
      subject: data.subject || '(No subject)',
      preview: textPreview,
      textBody,
      htmlBody,
      sentDate: now,
      isRead: true,
      source: 'sent',
      inReplyTo: data.inReplyTo,
      references: data.references,
      isReply: !!data.inReplyTo,
      externalMessageId,
      idempotencyKey: data.idempotencyKey,
      hasAttachments: attachments.length > 0,
      attachmentCount: attachments.length,
      ...(delivery
        ? { deliveryStatus: delivery.status, deliveryDetail: delivery.detail.slice(0, 500), deliveryUpdatedAt: now }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
  } catch (insertErr) {
    // A concurrent send with the same idempotency key won the unique-index
    // race: return its persisted row instead of double-recording. (The provider
    // send already happened above; a true concurrent double-send is a narrow,
    // documented edge — sequential offline replay is guarded by the pre-check.)
    if (!data.idempotencyKey) throw insertErr;
    const existing = await findSentByIdempotencyKey(db, account.id, data.idempotencyKey);
    if (!existing) throw insertErr;
    return existing;
  }
  await persistAttachmentPointers(db, messageId, attachments, now);
  return null;
}

async function persistSentCopy(
  db: Database,
  store: MailboxStore | undefined,
  account: MailAccountRow,
  data: SendComposeInput,
  copy: SentCopyInput,
): Promise<SendResult | null> {
  const textPreview = (copy.textBody ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (store) return persistSentCopyViaStore(db, store, account, data, copy, textPreview);
  return persistSentCopyViaPostgres(db, account, data, copy, textPreview);
}

/** Persist attachment pointers (best-effort). */
async function persistAttachmentPointers(
  db: Database,
  messageId: string,
  attachments: ResolvedAttachment[],
  now: Date,
): Promise<void> {
  await Promise.all(
    attachments.map(async (att) => {
      try {
        await db.insert(mailAttachments).values({
          id: generateId('attach'),
          messageId,
          fileName: att.filename,
          contentType: att.contentType || 'application/octet-stream',
          size: att.content.byteLength,
          storagePath: att.fileKey,
          isInline: false,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        console.error(
          `[mail-send] Failed to persist attachment ${att.filename} for message ${messageId}:`,
          err,
        );
      }
    }),
  );
}

/** Upsert recipients into contacts in the background (inline when there is no `waitUntil`). */
async function upsertRecipientContacts(
  env: MailSendEnv,
  db: Database,
  orgId: string,
  data: SendComposeInput,
  waitUntil: ExecutionContext['waitUntil'] | undefined,
): Promise<void> {
  const upsertJob = upsertMailContacts(env, db, orgId, {
    to: data.to.map((email) => ({ email })),
    cc: data.cc?.map((email) => ({ email })),
    bcc: data.bcc?.map((email) => ({ email })),
  });
  if (waitUntil) {
    waitUntil(upsertJob);
    return;
  }
  // Falls back to inline await — slower send response but correct.
  await upsertJob;
}

/**
 * Store server-supplied attachments as objects of the sent message, so its
 * copy keeps working when the message they came from is deleted. Best-effort:
 * the mail has already gone out, a failed copy only loses the Sent-folder chip.
 */
async function storeExtraAttachments(
  env: MailSendEnv,
  orgId: string,
  messageId: string,
  extras: InlineAttachment[],
): Promise<ResolvedAttachment[]> {
  if (extras.length === 0 || !env.STORAGE) return [];
  const storage = env.STORAGE;
  // Every attachment lands under its own key, so the copies run together; order is kept.
  const stored = await Promise.all(
    extras.map(async (att, index): Promise<ResolvedAttachment | null> => {
      const safeName = att.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'attachment';
      const fileKey = `workspaces/${orgId}/mail/attachments/${messageId}/${index + 1}_${safeName}`;
      try {
        await storage.put(fileKey, att.content, {
          httpMetadata: { contentType: att.contentType || 'application/octet-stream' },
        });
        return { ...att, fileKey };
      } catch (err) {
        console.error(`[mail-send] Failed to store attachment ${att.filename} for message ${messageId}:`, err);
        return null;
      }
    }),
  );
  return stored.filter((att): att is ResolvedAttachment => att !== null);
}

function toSmtpMessageId(externalMessageId: string): string {
  const raw = externalMessageId.replace(/^<|>$/g, '');
  return raw.startsWith('<') ? raw : `<${raw}>`;
}

export async function sendAndPersist(
  env: MailSendEnv,
  db: Database,
  orgId: string,
  caller: MailCaller,
  accountId: string,
  data: SendComposeInput,
  opts?: SendOptions,
): Promise<SendResult> {
  if (!opts?.dryRun && !env.SEND_EMAIL) {
    throw new MailSendError(
      'SEND_BINDING_MISSING',
      'Outbound mail is not configured for this environment (SEND_EMAIL binding missing).',
    );
  }

  // ---- Account + access check ------------------------------------------
  const account = await loadSendableAccount(db, caller, accountId);
  const store = opts?.store;

  // ---- Idempotency: short-circuit a replayed send ----------------------
  // If this key already produced a SENT message, return it without sending
  // again. This covers the offline-queue flush and the retry-after-dropped-
  // response case (the response was lost but the message was already sent).
  if (data.idempotencyKey) {
    const existing = await findExistingSent(db, store, accountId, data.idempotencyKey);
    if (existing) return existing;
  }

  // ---- Opt-in policies (public API): verified sender, daily limit ------
  await assertSendPolicy(db, store, account, opts);

  const body = prepareBody(data);
  await assertValidRecipients(env, data, opts?.dryRun);

  // ---- Outbound guard: sender, limits, cold-email screening ------------
  // (docs/plans/weldmail-outbound-abuse.md). Dry-run sends never reach
  // Cloudflare, so they are not counted.
  const reservation = opts?.dryRun ? null : await reserveOutbound(env, db, orgId, account, data, body, opts);

  // ---- Attachment resolution (R2) --------------------------------------
  const extraAttachments = opts?.extraAttachments ?? [];
  const resolvedAttachments = await resolveAttachmentsFor(env, orgId, data, extraAttachments, reservation);

  // ---- Send via Cloudflare ---------------------------------------------
  const { result: sendResult, partial } = await transmitGuarded(
    env,
    account,
    data,
    body,
    [...resolvedAttachments, ...extraAttachments],
    opts?.dryRun,
    reservation,
  );
  if (reservation) {
    await commitOutbound(env, db, reservation, { sentRecipients: partial?.sent, waitUntil: opts?.waitUntil });
  }

  const externalMessageId = sendResult.messageId;
  const smtpMessageId = toSmtpMessageId(externalMessageId);
  const messageId = generateId('msg');
  const now = new Date();

  // ---- Thread stitching (replies inherit parent thread) ----------------
  const threadId = await resolveThreadId(db, store, accountId, data, smtpMessageId);

  // ---- Server-supplied attachments (forward's originals, a generated .eml)
  // go to R2 before the sent copy is persisted, so an `ingest` op can own
  // every attachment atomically, same as the direct-Postgres path's own
  // ordering (today's `persistAttachmentPointers` ran after the insert, but
  // the R2 put itself never depended on the row existing).
  const storedExtras = await storeExtraAttachments(env, orgId, messageId, extraAttachments);
  const allAttachments = [...resolvedAttachments, ...storedExtras];

  // ---- Persist SENT copy (+ attachments) --------------------------------
  const replayed = await persistSentCopy(db, store, account, data, {
    messageId,
    smtpMessageId,
    externalMessageId,
    threadId,
    htmlBody: body.html,
    textBody: body.text,
    attachments: allAttachments,
    now,
    delivery: deliveryNote(partial, sendResult.suppressedRecipients ?? []),
  });
  if (replayed) return replayed;

  // ---- Bump daily counter ----------------------------------------------
  await db
    .update(mailAccounts)
    .set({ sentToday: sql`${mailAccounts.sentToday} + 1`, updatedAt: now })
    .where(eq(mailAccounts.id, accountId));

  // ---- Background: upsert recipients into contacts ---------------------
  // Skipped under dry-run so test sends don't create real `people` rows that
  // /reset can't find (they carry no test marker).
  if (!opts?.dryRun) await upsertRecipientContacts(env, db, orgId, data, opts?.waitUntil);

  if (partial) {
    throw new MailSendError(
      'PARTIALLY_SENT',
      `Sent to ${partial.sent.length} of ${partial.sent.length + partial.failed.length} recipients.`,
      { sent: partial.sent, failed: partial.failed, messageId },
    );
  }

  return {
    messageId,
    smtpMessageId,
    externalMessageId,
    accountId,
    subject: data.subject || '(No subject)',
    pendingVerification: sendResult.pendingVerification ?? false,
  };
}

/**
 * Sanitize the HTML once for both the transmitted and stored copies. Covers
 * reply/forward too (they funnel through here), so a forwarded message can't
 * re-emit script from quoted inbound HTML, and shared-mailbox composers can't
 * store XSS for the next reader. Inbound mail is also sanitized at ingest.
 * A client that put its editor HTML in `body` still gets a real HTML part,
 * and the text/plain part is always tag-free (see ./text).
 */
function prepareBody(data: SendComposeInput): { html: string | undefined; text: string | undefined } {
  const rawHtml = data.htmlBody ?? (data.body && looksLikeHtml(data.body) ? data.body : undefined);
  const html = sanitizeEmailHtml(rawHtml) || undefined;
  return { html, text: plainTextBody(data.body, data.htmlBody) };
}

/** Recipient validation (format + MX). Dry-run keeps the format check but skips the network MX lookup. */
async function assertValidRecipients(env: MailSendEnv, data: SendComposeInput, dryRun: boolean | undefined): Promise<void> {
  const check = await validateRecipients(data.to, data.cc, data.bcc, env, { skipMx: dryRun });
  if (check.ok) return;
  throw new MailSendError('INVALID_RECIPIENTS', 'One or more recipient addresses are invalid', {
    invalidFormat: check.invalidFormat,
    unreachableDomains: check.unreachableDomains,
  });
}

/** Resolve the uploaded attachments; give the reservation back when that fails. */
async function resolveAttachmentsFor(
  env: MailSendEnv,
  orgId: string,
  data: SendComposeInput,
  extraAttachments: InlineAttachment[],
  reservation: OutboundReservation | null,
): Promise<ResolvedAttachment[]> {
  try {
    return await resolveAttachments(
      env,
      orgId,
      data,
      extraAttachments.reduce((total, att) => total + att.content.byteLength, 0),
    );
  } catch (err) {
    if (reservation) await releaseOutbound(env, reservation);
    throw err;
  }
}

interface PartialSend {
  sent: string[];
  failed: string[];
}

/**
 * Hand the message to Cloudflare. A send that failed halfway (some recipients
 * already have it) comes back as `partial` so its copy is recorded; any other
 * failure gives the reservation back and becomes a MailSendError where
 * Cloudflare named the reason.
 */
async function transmitGuarded(
  env: MailSendEnv,
  account: MailAccountRow,
  data: SendComposeInput,
  body: { html: string | undefined; text: string | undefined },
  attachments: InlineAttachment[],
  dryRun: boolean | undefined,
  reservation: OutboundReservation | null,
): Promise<{ result: TransmitResult; partial: PartialSend | null }> {
  try {
    return { result: await transmitEmail(env, account, data, body, attachments, dryRun), partial: null };
  } catch (err) {
    const sent = err instanceof TransientProviderError ? err.sentRecipients : [];
    if (!(err instanceof TransientProviderError) || sent.length === 0 || !err.messageId) {
      if (reservation) await releaseOutbound(env, reservation);
      throw await transmitFailure(env, err);
    }
    if (err instanceof ProviderRefusedError && err.refusal === 'daily_limit') {
      await tripPlatformBreaker(env, 'Cloudflare refused a send with E_DAILY_LIMIT_EXCEEDED.');
    }
    const sentSet = new Set(sent.map((r) => r.toLowerCase()));
    const everyone = [...data.to, ...(data.cc ?? []), ...(data.bcc ?? [])];
    return {
      result: { messageId: err.messageId, pendingVerification: false },
      partial: { sent, failed: everyone.filter((r) => !sentSet.has(r.toLowerCase())) },
    };
  }
}

/** What the SENT copy should say about delivery when it is known at send time. */
function deliveryNote(partial: PartialSend | null, suppressed: string[]): SentCopyInput['delivery'] {
  if (partial) return { status: 'failed', detail: `Not sent to: ${partial.failed.join(', ')}` };
  if (suppressed.length > 0) {
    return { status: 'rejected', detail: `Skipped, on the suppression list: ${suppressed.join(', ')}` };
  }
  return undefined;
}

function tooLarge(): MailSendError {
  return new MailSendError(
    'EMAIL_TOO_LARGE',
    `Email exceeds the ${MAX_EMAIL_SIZE_BYTES / (1024 * 1024)} MB limit (body + attachments).`,
  );
}

async function resolveAttachments(
  env: MailSendEnv,
  orgId: string,
  data: SendComposeInput,
  extraBytes = 0,
): Promise<{ filename: string; contentType?: string; content: ArrayBuffer; fileKey: string }[]> {
  let totalBytes =
    extraBytes +
    (data.body ? new TextEncoder().encode(data.body).byteLength : 0) +
    (data.htmlBody ? new TextEncoder().encode(data.htmlBody).byteLength : 0);
  if (extraBytes > 0 && totalBytes > MAX_EMAIL_SIZE_BYTES) throw tooLarge();

  if (!data.attachments?.length) return [];
  if (!env.STORAGE && !env.PRIVATE_STORAGE) {
    throw new MailSendError('STORAGE_BINDING_MISSING', 'Storage binding not configured');
  }

  const workspacePrefix = `workspaces/${orgId}/`;

  const resolved: { filename: string; contentType?: string; content: ArrayBuffer; fileKey: string }[] = [];
  for (const att of data.attachments) {
    if (!att.fileKey.startsWith(workspacePrefix)) {
      throw new MailSendError(
        'ATTACHMENT_NOT_IN_WORKSPACE',
        `Attachment ${att.filename} is not in this workspace`,
      );
    }
    const obj = await getStoredObject(env, att.fileKey);
    if (!obj) {
      throw new MailSendError(
        'ATTACHMENT_NOT_IN_STORAGE',
        `Attachment ${att.filename} not found in storage`,
      );
    }
    const buf = await obj.arrayBuffer();
    totalBytes += buf.byteLength;
    if (totalBytes > MAX_EMAIL_SIZE_BYTES) throw tooLarge();
    resolved.push({
      filename: att.filename,
      contentType: att.contentType || obj.httpMetadata?.contentType,
      content: buf,
      fileKey: att.fileKey,
    });
  }
  return resolved;
}

export interface ForwardInput {
  to: string[];
  body?: string;
  htmlBody?: string;
  attachments?: SendAttachmentInput[];
  /** Ids of the original's attachments the sender removed from the forward. */
  excludeAttachmentIds?: string[];
  /** Attach the original as an `.eml` file instead of quoting it inline. */
  asAttachment?: boolean;
  /** The sender's IANA time zone and locale, for the quoted `Date:` line. */
  timeZone?: string;
  locale?: string;
  /** Same replay guard as {@link SendComposeInput.idempotencyKey}. */
  idempotencyKey?: string;
}

export interface ReplyInput {
  body?: string;
  htmlBody?: string;
  replyAll?: boolean;
  attachments?: SendAttachmentInput[];
  /** Same replay guard as {@link SendComposeInput.idempotencyKey}. */
  idempotencyKey?: string;
}

/**
 * The fields `forwardAndPersist`/`replyAndPersist`/`buildEmlAttachment` read
 * off the original message — a narrower shape than the Postgres row so a
 * `MailboxStore.getMessage` record (which never carries `rawMessage`, and
 * leaves bodies off unless asked for) satisfies it exactly as well as the
 * direct-Postgres row does.
 */
interface OriginalMessage {
  id: string;
  accountId: string;
  subject: string | null;
  from: unknown;
  to: unknown;
  cc: unknown;
  messageId: string;
  references: unknown;
  inReplyTo: string | null;
  source: string | null;
  sentDate: Date | null;
  receivedDate: Date | null;
  createdAt: Date;
  textBody: string | null;
  htmlBody: string | null;
  rawMessage: string | null;
}

/**
 * Load the message a reply/forward answers. Through `store.getMessage(id,
 * {bodies: true})` when a store is supplied (design task D1) — so forwarding
 * or replying still works once a workspace's Postgres row for that message is
 * stale (shadow/object) or was never written (object-only). Without one
 * (external-api until task D5 lands), the direct-Postgres row, unchanged.
 */
async function loadOriginal(
  db: Database,
  store: MailboxStore | undefined,
  originalMessageId: string,
): Promise<OriginalMessage | null> {
  if (store) {
    const row = await store.getMessage(originalMessageId, { bodies: true });
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.accountId,
      subject: row.subject,
      from: row.from,
      to: row.to,
      cc: row.cc,
      messageId: row.messageId,
      references: row.references,
      inReplyTo: row.inReplyTo,
      source: row.source,
      sentDate: row.sentDate,
      receivedDate: row.receivedDate,
      createdAt: row.createdAt,
      textBody: row.textBody ?? null,
      htmlBody: row.htmlBody ?? null,
      rawMessage: null,
    };
  }
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, originalMessageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  return row ?? null;
}

function formatAddress(addr: { email?: string; name?: string } | null | undefined): string {
  if (!addr) return '';
  return addr.name ? `${addr.name} <${addr.email ?? ''}>` : addr.email ?? '';
}

/** The quoted `Date:` line, in the sender's locale and time zone (UTC when unknown or invalid). */
function formatForwardDate(date: Date, timeZone?: string, locale?: string): string {
  const format = (tz: string | undefined, loc: string | undefined) =>
    new Intl.DateTimeFormat(loc || 'en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz || 'UTC',
      timeZoneName: 'short',
    }).format(date);
  try {
    return format(timeZone, locale);
  } catch {
    return format(undefined, undefined);
  }
}

/**
 * The original's own files, minus the ones the sender removed. Inline images
 * stay in the HTML. Through `store.listAttachments` when one is supplied
 * (same reasoning as {@link loadOriginal}), else the direct-Postgres rows.
 */
async function loadOriginalAttachments(
  env: MailSendEnv,
  db: Database,
  store: MailboxStore | undefined,
  originalMessageId: string,
  excludeIds: string[],
): Promise<InlineAttachment[]> {
  const rows = store
    ? await store.listAttachments(originalMessageId)
    : await db
        .select()
        .from(mailAttachments)
        .where(and(eq(mailAttachments.messageId, originalMessageId), isNull(mailAttachments.deletedAt)));
  const wanted = rows.filter((r) => !r.isInline && r.storagePath && !excludeIds.includes(r.id));
  if (wanted.length === 0) return [];
  if (!env.STORAGE && !env.PRIVATE_STORAGE) {
    throw new MailSendError('STORAGE_BINDING_MISSING', 'Storage binding not configured');
  }

  const loaded: InlineAttachment[] = [];
  for (const row of wanted) {
    const obj = await getStoredObject(env, row.storagePath!);
    if (!obj) {
      throw new MailSendError(
        'ATTACHMENT_NOT_IN_STORAGE',
        `Attachment ${row.fileName} not found in storage`,
      );
    }
    loaded.push({
      filename: row.fileName,
      contentType: row.contentType || obj.httpMetadata?.contentType,
      content: await obj.arrayBuffer(),
    });
  }
  return loaded;
}

/**
 * The original as an `.eml` file: R2's raw copy first
 * (docs/plans/weldmail-mailbox-store-design.md decision 4), then the
 * Postgres `rawMessage` column (older messages, or a message a different
 * transport stored it on), then rebuilt from the stored headers, bodies and
 * files. `ref` is null when the caller has no workspace id to look R2 up
 * with (an older call site) — that just skips straight to the next source.
 */
async function buildEmlAttachment(
  env: Pick<MailSendEnv, 'MAIL_STORAGE'>,
  ref: MailBodyRef | null,
  original: OriginalMessage,
  files: InlineAttachment[],
): Promise<InlineAttachment> {
  let content: ArrayBuffer | null = null;
  if (ref && env.MAIL_STORAGE) {
    try {
      content = await getRawMime(env.MAIL_STORAGE, ref);
    } catch (err) {
      console.warn(
        `[mail] Failed to read raw MIME from R2 for ${original.id} (forward as attachment):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!content && original.rawMessage) {
    content = new TextEncoder().encode(original.rawMessage).buffer as ArrayBuffer;
  }
  if (!content) {
    const from = original.from as { email?: string; name?: string } | null;
    content = new TextEncoder().encode(
      buildRfc5322({
        from: { email: from?.email ?? 'unknown@invalid', name: from?.name },
        to: ((original.to as { email?: string; name?: string }[] | null) ?? [])
          .filter((r): r is { email: string; name?: string } => !!r.email)
          .map((r) => ({ email: r.email, name: r.name })),
        cc: ((original.cc as { email?: string; name?: string }[] | null) ?? [])
          .filter((r): r is { email: string; name?: string } => !!r.email)
          .map((r) => ({ email: r.email, name: r.name })),
        subject: original.subject ?? '',
        text: original.textBody ?? undefined,
        html: original.htmlBody ?? undefined,
        messageId: original.messageId,
        headers: { Date: (original.sentDate ?? original.createdAt).toUTCString() },
        attachments: files,
      }).raw,
    ).buffer as ArrayBuffer;
  }
  const name = (original.subject ?? '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return {
    filename: `${name || 'message'}.eml`,
    // Sent base64-encoded, which `message/rfc822` parts may not be; mail
    // clients open the file by its extension.
    contentType: 'application/octet-stream',
    content,
  };
}

/** The subject of a forward: `Fwd: ` once, whatever the original already had (`Fwd:`, `Fw:`, any casing). */
export function forwardSubject(original: string | null | undefined): string {
  const subject = (original ?? '').trim();
  if (/^fwd?:\s*/i.test(subject)) return subject;
  return `Fwd: ${subject || '(No subject)'}`;
}

/**
 * Forward variant — looks up the original message, prepends the standard
 * quoted "Forwarded message" block to the user's body, prefixes the
 * subject with `Fwd:` if absent, and hands off to `sendAndPersist`.
 *
 * The original's attachments travel with it (the sender can leave some out),
 * or the whole original goes as an `.eml` file when `asAttachment` is set.
 *
 * Recipients come from the user (not the original); the forwarded
 * message inherits no threading metadata since it's a fresh thread for
 * the new recipients.
 */
export async function forwardAndPersist(
  env: MailSendEnv,
  db: Database,
  orgId: string,
  caller: MailCaller,
  originalMessageId: string,
  data: ForwardInput,
  opts?: SendOptions,
): Promise<SendResult & { forwardedFrom: string }> {
  const original = await loadOriginal(db, opts?.store, originalMessageId);
  if (!original) {
    throw new MailSendError('ACCOUNT_NOT_FOUND', 'Original message not found');
  }

  const subject = forwardSubject(original.subject);

  const originalFiles = await loadOriginalAttachments(
    env,
    db,
    opts?.store,
    originalMessageId,
    data.excludeAttachmentIds ?? [],
  );

  let composedBody = data.body;
  let composedHtml = data.htmlBody;
  let extraAttachments: InlineAttachment[];
  if (data.asAttachment) {
    // `opts.outbound.workspaceId` (master id) is the same one the outbound
    // guard uses; reused here to look up the original's raw MIME in R2. Null
    // when a caller doesn't pass it — buildEmlAttachment falls back to
    // `rawMessage` / rebuilding from the stored row in that case.
    const ref: MailBodyRef | null = opts?.outbound?.workspaceId
      ? { workspaceId: opts.outbound.workspaceId, accountId: original.accountId, messageId: original.id }
      : null;
    extraAttachments = [await buildEmlAttachment(env, ref, original, originalFiles)];
  } else {
    extraAttachments = originalFiles;
    const senderLabel =
      formatAddress(original.from as { email?: string; name?: string } | null) || 'Unknown';
    const toLabel = ((original.to as { email?: string; name?: string }[] | null) ?? [])
      .map(formatAddress)
      .filter(Boolean)
      .join(', ');
    const dateLabel = formatForwardDate(
      original.sentDate ?? original.receivedDate ?? original.createdAt ?? new Date(),
      data.timeZone,
      data.locale,
    );
    const originalSubject = original.subject ?? '';
    const originalText = original.textBody || (original.htmlBody ? htmlToText(original.htmlBody) : '');

    const headerLines = [
      `From: ${senderLabel}`,
      `Date: ${dateLabel}`,
      `Subject: ${originalSubject}`,
      ...(toLabel ? [`To: ${toLabel}`] : []),
    ];
    const quotedTextBody = `\n\n---------- Forwarded message ----------\n${headerLines.join('\n')}\n\n${originalText}`;
    // Header values come from the original mail: escaped, or `<sender@x>` is
    // swallowed as a tag (and a crafted name could inject markup).
    const quotedHeader = [
      `<b>From:</b> ${escapeHtml(senderLabel)}`,
      `<b>Date:</b> ${escapeHtml(dateLabel)}`,
      `<b>Subject:</b> ${escapeHtml(originalSubject)}`,
      ...(toLabel ? [`<b>To:</b> ${escapeHtml(toLabel)}`] : []),
    ].join('<br>');
    const originalHtml =
      original.htmlBody ?? `<div style="white-space:pre-wrap">${escapeHtml(originalText)}</div>`;
    const quotedHtmlBody = `<br><br><div style="border-left:2px solid #ccc;padding-left:1em;color:#555"><p>---------- Forwarded message ----------</p><p>${quotedHeader}</p>${originalHtml}</div>`;

    const noteText = plainTextBody(data.body, data.htmlBody) ?? '';
    composedBody = `${noteText}${quotedTextBody}`;
    composedHtml = `${data.htmlBody ?? escapeHtml(noteText).replace(/\n/g, '<br>')}${quotedHtmlBody}`;
  }

  const result = await sendAndPersist(
    env,
    db,
    orgId,
    caller,
    original.accountId,
    {
      to: data.to,
      subject,
      body: composedBody,
      htmlBody: composedHtml,
      attachments: data.attachments,
      idempotencyKey: data.idempotencyKey,
    },
    {
      ...opts,
      extraAttachments,
      outbound: { ...opts?.outbound, source: opts?.outbound?.source ?? 'forward', kind: 'forward' },
    },
  );
  return { ...result, forwardedFrom: originalMessageId };
}

/**
 * Who a reply goes to: the original sender, and with reply-all everyone who was
 * on the original To/Cc lines — Cc recipients stay on Cc — minus this mailbox,
 * which is already the sender.
 */
function replyRecipients(
  original: OriginalMessage,
  mailbox: string,
  replyAll: boolean,
): { to: string[]; cc: string[] } {
  const originalFrom = original.from as { email?: string; name?: string } | null;
  const to: string[] = originalFrom?.email ? [originalFrom.email] : [];
  const cc: string[] = [];
  if (!replyAll) return { to, cc };
  const isNew = (email: string | undefined): email is string =>
    !!email && email !== mailbox && !to.includes(email) && !cc.includes(email);
  for (const addr of (original.to as { email?: string }[] | null) ?? []) {
    if (isNew(addr.email)) to.push(addr.email);
  }
  for (const addr of (original.cc as { email?: string }[] | null) ?? []) {
    if (isNew(addr.email)) cc.push(addr.email);
  }
  return { to, cc };
}

/**
 * Reply variant — looks up the original message, derives recipients and
 * threading headers, then hands off to `sendAndPersist`.
 */
export async function replyAndPersist(
  env: MailSendEnv,
  db: Database,
  orgId: string,
  caller: MailCaller,
  originalMessageId: string,
  data: ReplyInput,
  opts?: SendOptions,
): Promise<SendResult & { repliedTo: string }> {
  const original = await loadOriginal(db, opts?.store, originalMessageId);
  if (!original) {
    throw new MailSendError('ACCOUNT_NOT_FOUND', 'Original message not found');
  }

  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, original.accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) throw new MailSendError('ACCOUNT_NOT_FOUND', 'Mail account not found');

  const { to: toAddresses, cc: ccAddresses } = replyRecipients(original, account.email, !!data.replyAll);
  const originalSmtpId = original.messageId;
  const existingRefs = (original.references as string[]) || [];
  const references = [...existingRefs, originalSmtpId].filter(Boolean);

  const result = await sendAndPersist(
    env,
    db,
    orgId,
    caller,
    original.accountId,
    {
      to: toAddresses,
      cc: ccAddresses.length ? ccAddresses : undefined,
      subject: `Re: ${(original.subject || '').replace(/^Re:\s*/i, '')}`,
      body: data.body,
      htmlBody: data.htmlBody,
      inReplyTo: originalSmtpId,
      references,
      attachments: data.attachments,
      idempotencyKey: data.idempotencyKey,
    },
    {
      ...opts,
      outbound: {
        ...opts?.outbound,
        source: opts?.outbound?.source ?? 'reply',
        // Following up on the mailbox's own sent mail is not answering anyone.
        kind: original.source === 'sent' ? 'new_thread' : 'reply',
      },
    },
  );
  return { ...result, repliedTo: originalMessageId };
}

/**
 * Send a saved draft from its account, then delete the draft.
 *
 * The draft's own `attachmentIds` are not resolved here: they are ids in
 * whatever upload flow created the draft, so the caller resolves them and
 * passes the files in `extra.attachments`. When the send fails the draft
 * stays, so nothing the user wrote is lost. A draft that was a reply keeps its
 * thread through `inReplyTo`.
 */
export async function sendDraftAndPersist(
  env: MailSendEnv,
  db: Database,
  orgId: string,
  caller: MailCaller,
  draftId: string,
  extra: { attachments?: SendAttachmentInput[]; idempotencyKey?: string },
  opts?: SendOptions,
): Promise<SendResult & { draftId: string }> {
  const draft = await getDraft(db, draftId);
  if (!draft) throw new MailSendError('DRAFT_NOT_FOUND', 'Draft not found');

  const to = (draft.to as string[] | null) ?? [];
  if (to.length === 0) {
    throw new MailSendError('INVALID_RECIPIENTS', 'The draft has no recipients', {
      invalidFormat: [],
      unreachableDomains: [],
    });
  }

  const result = await sendAndPersist(
    env,
    db,
    orgId,
    caller,
    draft.accountId,
    {
      to,
      cc: (draft.cc as string[] | null) ?? undefined,
      bcc: (draft.bcc as string[] | null) ?? undefined,
      replyTo: ((draft.replyTo as string[] | null) ?? [])[0],
      subject: draft.subject ?? undefined,
      body: draft.body ?? undefined,
      htmlBody: draft.htmlBody ?? undefined,
      importance: (draft.importance as SendComposeInput['importance']) ?? undefined,
      inReplyTo: draft.inReplyTo ?? undefined,
      references: draft.inReplyTo ? [draft.inReplyTo] : undefined,
      attachments: extra.attachments,
      idempotencyKey: extra.idempotencyKey,
    },
    opts,
  );

  await softDeleteDraft(db, draftId);
  return { ...result, draftId };
}
