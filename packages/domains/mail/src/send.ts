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
import * as cfEmail from '@weldsuite/worker-email';
import { sanitizeEmailHtml } from '@weldsuite/email/sanitize';
import { buildRfc5322 } from '@weldsuite/email/core/mime';
import { escapeHtml, htmlToText, looksLikeHtml, plainTextBody } from './text';
import { validateRecipients, type RecipientValidationEnv } from './recipient-validation';
import { upsertMailContacts, type MailContactsEnv } from './contacts';
import { principalHasAccess, principalIsAdmin, toPrincipal, type MailCaller } from './access';
import { isSenderDomainVerified } from './accounts';
import { getDraft, softDeleteDraft } from './drafts';

/**
 * The bindings the send helpers read: the Cloudflare send binding
 * (@weldsuite/worker-email), the MX-lookup cache, and the R2 bucket for
 * attachments and contact avatars. Any worker Env with them fits.
 */
export interface MailSendEnv extends cfEmail.WorkerEmailEnv, RecipientValidationEnv, MailContactsEnv {}

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
      | 'DRAFT_NOT_FOUND',
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

/** Messages the account sent since UTC midnight, deleted ones included. */
export async function countSentToday(db: Database, accountId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        eq(mailMessages.source, 'sent'),
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
async function assertSendPolicy(db: Database, account: MailAccountRow, opts: SendOptions | undefined): Promise<void> {
  if (opts?.requireVerifiedDomain && !(await isSenderDomainVerified(db, account.email))) {
    throw new MailSendError(
      'SENDER_DOMAIN_NOT_VERIFIED',
      `This account's address (${account.email}) is not on a verified WeldMail domain, so it can't send through the API.`,
    );
  }
  if (opts?.enforceDailyLimit) {
    const limit = account.dailySendLimit ?? 500;
    const sent = await countSentToday(db, account.id);
    if (sent >= limit) {
      throw new MailSendError('DAILY_LIMIT_REACHED', `This account reached its daily send limit of ${limit}.`, {
        limit,
        sent,
        resetsAt: new Date(utcDayStart().getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
    }
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

/** Thread stitching: replies inherit the parent's thread, anything else starts its own. */
async function resolveThreadId(
  db: Database,
  accountId: string,
  data: SendComposeInput,
  fallbackThreadId: string,
): Promise<string> {
  const lookupIds = [...(data.inReplyTo ? [data.inReplyTo] : []), ...(data.references ?? [])];
  if (lookupIds.length === 0) return fallbackThreadId;

  const providerIds = lookupIds
    .map((id) => id.replace(/^</, '').replace(/@[\s\S]*/, ''))
    .filter(Boolean);
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
  attachmentCount: number;
  now: Date;
}

/**
 * Persist the SENT copy. Returns the already-persisted result when a concurrent
 * send with the same idempotency key won the unique-index race, otherwise null.
 */
async function persistSentCopy(
  db: Database,
  account: MailAccountRow,
  data: SendComposeInput,
  copy: SentCopyInput,
): Promise<SendResult | null> {
  const { messageId, smtpMessageId, externalMessageId, threadId, htmlBody, textBody, attachmentCount, now } = copy;
  const textPreview = (textBody ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
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
      hasAttachments: attachmentCount > 0,
      attachmentCount,
      createdAt: now,
      updatedAt: now,
    });
    return null;
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

  // ---- Idempotency: short-circuit a replayed send ----------------------
  // If this key already produced a SENT message, return it without sending
  // again. This covers the offline-queue flush and the retry-after-dropped-
  // response case (the response was lost but the message was already sent).
  if (data.idempotencyKey) {
    const existing = await findSentByIdempotencyKey(db, accountId, data.idempotencyKey);
    if (existing) return existing;
  }

  // ---- Opt-in policies (public API): verified sender, daily limit ------
  await assertSendPolicy(db, account, opts);

  // Sanitize the HTML once for both the transmitted and stored copies. Covers
  // reply/forward too (they funnel through here), so a forwarded message can't
  // re-emit script from quoted inbound HTML, and shared-mailbox composers can't
  // store XSS for the next reader. Inbound mail is also sanitized at ingest.
  // A client that put its editor HTML in `body` still gets a real HTML part,
  // and the text/plain part is always tag-free (see ./text).
  const rawHtml = data.htmlBody ?? (data.body && looksLikeHtml(data.body) ? data.body : undefined);
  const htmlBody = sanitizeEmailHtml(rawHtml) || undefined;
  const textBody = plainTextBody(data.body, htmlBody);

  // ---- Recipient validation (format + MX) ------------------------------
  // Dry-run keeps the format check but skips the network MX lookup.
  const check = await validateRecipients(data.to, data.cc, data.bcc, env, {
    skipMx: opts?.dryRun,
  });
  if (!check.ok) {
    throw new MailSendError('INVALID_RECIPIENTS', 'One or more recipient addresses are invalid', {
      invalidFormat: check.invalidFormat,
      unreachableDomains: check.unreachableDomains,
    });
  }

  // ---- Attachment resolution (R2) --------------------------------------
  const extraAttachments = opts?.extraAttachments ?? [];
  const resolvedAttachments = await resolveAttachments(
    env,
    orgId,
    data,
    extraAttachments.reduce((total, att) => total + att.content.byteLength, 0),
  );

  // ---- Send via Cloudflare ---------------------------------------------
  const sendResult = await transmitEmail(
    env,
    account,
    data,
    { html: htmlBody, text: textBody },
    [...resolvedAttachments, ...extraAttachments],
    opts?.dryRun,
  );

  const externalMessageId = sendResult.messageId;
  const smtpMessageId = toSmtpMessageId(externalMessageId);
  const messageId = generateId('msg');
  const now = new Date();

  // ---- Thread stitching (replies inherit parent thread) ----------------
  const threadId = await resolveThreadId(db, accountId, data, smtpMessageId);

  // ---- Persist SENT copy ------------------------------------------------
  const replayed = await persistSentCopy(db, account, data, {
    messageId,
    smtpMessageId,
    externalMessageId,
    threadId,
    htmlBody,
    textBody,
    attachmentCount: resolvedAttachments.length + extraAttachments.length,
    now,
  });
  if (replayed) return replayed;

  // ---- Persist attachment pointers (best-effort) -----------------------
  const storedExtras = await storeExtraAttachments(env, orgId, messageId, extraAttachments);
  await persistAttachmentPointers(db, messageId, [...resolvedAttachments, ...storedExtras], now);

  // ---- Bump daily counter ----------------------------------------------
  await db
    .update(mailAccounts)
    .set({ sentToday: sql`${mailAccounts.sentToday} + 1`, updatedAt: now })
    .where(eq(mailAccounts.id, accountId));

  // ---- Background: upsert recipients into contacts ---------------------
  // Skipped under dry-run so test sends don't create real `people` rows that
  // /reset can't find (they carry no test marker).
  if (!opts?.dryRun) await upsertRecipientContacts(env, db, orgId, data, opts?.waitUntil);

  return {
    messageId,
    smtpMessageId,
    externalMessageId,
    accountId,
    subject: data.subject || '(No subject)',
    pendingVerification: sendResult.pendingVerification ?? false,
  };
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
  if (!env.STORAGE) {
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
    const obj = await env.STORAGE.get(att.fileKey);
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

type OriginalMessage = typeof mailMessages.$inferSelect;

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

/** The original's own files, minus the ones the sender removed. Inline images stay in the HTML. */
async function loadOriginalAttachments(
  env: MailSendEnv,
  db: Database,
  originalMessageId: string,
  excludeIds: string[],
): Promise<InlineAttachment[]> {
  const rows = await db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.messageId, originalMessageId), isNull(mailAttachments.deletedAt)));
  const wanted = rows.filter((r) => !r.isInline && r.storagePath && !excludeIds.includes(r.id));
  if (wanted.length === 0) return [];
  if (!env.STORAGE) {
    throw new MailSendError('STORAGE_BINDING_MISSING', 'Storage binding not configured');
  }

  const loaded: InlineAttachment[] = [];
  for (const row of wanted) {
    const obj = await env.STORAGE.get(row.storagePath!);
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
 * The original as an `.eml` file: the raw message when inbound stored it,
 * otherwise rebuilt from the stored headers, bodies and files.
 */
function buildEmlAttachment(original: OriginalMessage, files: InlineAttachment[]): InlineAttachment {
  const from = original.from as { email?: string; name?: string } | null;
  const raw =
    original.rawMessage ||
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
    }).raw;
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
    content: new TextEncoder().encode(raw).buffer as ArrayBuffer,
  };
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
  const [original] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, originalMessageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!original) {
    throw new MailSendError('ACCOUNT_NOT_FOUND', 'Original message not found');
  }

  const subject = original.subject?.match(/^(Fwd|Fw):\s*/i)
    ? original.subject
    : `Fwd: ${original.subject ?? ''}`;

  const originalFiles = await loadOriginalAttachments(
    env,
    db,
    originalMessageId,
    data.excludeAttachmentIds ?? [],
  );

  let composedBody = data.body;
  let composedHtml = data.htmlBody;
  let extraAttachments: InlineAttachment[];
  if (data.asAttachment) {
    // A stored raw message already carries its files; a rebuilt one gets them
    // from the attachment rows.
    extraAttachments = [buildEmlAttachment(original, original.rawMessage ? [] : originalFiles)];
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
    { ...opts, extraAttachments },
  );
  return { ...result, forwardedFrom: originalMessageId };
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
  const [original] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.id, originalMessageId), isNull(mailMessages.deletedAt)))
    .limit(1);
  if (!original) {
    throw new MailSendError('ACCOUNT_NOT_FOUND', 'Original message not found');
  }

  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, original.accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) throw new MailSendError('ACCOUNT_NOT_FOUND', 'Mail account not found');

  const originalFrom = original.from as { email?: string; name?: string } | null;
  const toAddresses: string[] = [];
  if (originalFrom?.email) toAddresses.push(originalFrom.email);
  // Reply-all keeps everyone who was on the original To/Cc lines — Cc
  // recipients stay on Cc — minus this mailbox, which is already the sender.
  const ccAddresses: string[] = [];
  if (data.replyAll) {
    const isNew = (email: string | undefined): email is string =>
      !!email && email !== account.email && !toAddresses.includes(email) && !ccAddresses.includes(email);
    for (const addr of (original.to as { email?: string }[] | null) ?? []) {
      if (isNew(addr.email)) toAddresses.push(addr.email);
    }
    for (const addr of (original.cc as { email?: string }[] | null) ?? []) {
      if (isNew(addr.email)) ccAddresses.push(addr.email);
    }
  }

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
    opts,
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
