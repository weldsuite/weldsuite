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
import type { Database } from '../../db';
import { schema } from '../../db';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';
import * as cfEmail from '../../lib/cloudflare-email';
import { sanitizeEmailHtml } from '@weldsuite/email/sanitize';
import { validateRecipients } from './recipient-validation';
import { upsertMailContacts } from './contacts';
import { hasAccessToAccount, isAdminOrOwner } from './access';

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
      | 'SEND_BINDING_MISSING',
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
 * `waitUntil` is taken explicitly (rather than reading from a Hono context)
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
}

/**
 * Look up a previously-sent message by its client idempotency key and rebuild
 * the SendResult from it, so a replayed send returns the original outcome
 * without re-transmitting. Returns null when the key hasn't been seen.
 */
async function findSentByIdempotencyKey(
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

export async function sendAndPersist(
  env: Env,
  db: Database,
  orgId: string,
  userId: string,
  accountId: string,
  data: SendComposeInput,
  waitUntil?: ExecutionContext['waitUntil'],
  opts?: SendOptions,
): Promise<SendResult> {
  if (!opts?.dryRun && !env.SEND_EMAIL) {
    throw new MailSendError(
      'SEND_BINDING_MISSING',
      'Outbound mail is not configured for this environment (SEND_EMAIL binding missing).',
    );
  }

  // ---- Account + access check ------------------------------------------
  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.deletedAt)))
    .limit(1);
  if (!account) throw new MailSendError('ACCOUNT_NOT_FOUND', 'Mail account not found');

  const admin = await isAdminOrOwner(db, userId);
  if (!hasAccessToAccount(account, userId, admin)) {
    throw new MailSendError('ACCOUNT_NOT_FOUND', 'Mail account not found');
  }

  // ---- Idempotency: short-circuit a replayed send ----------------------
  // If this key already produced a SENT message, return it without sending
  // again. This covers the offline-queue flush and the retry-after-dropped-
  // response case (the response was lost but the message was already sent).
  if (data.idempotencyKey) {
    const existing = await findSentByIdempotencyKey(db, accountId, data.idempotencyKey);
    if (existing) return existing;
  }

  // Sanitize the HTML once for both the transmitted and stored copies. Covers
  // reply/forward too (they funnel through here), so a forwarded message can't
  // re-emit script from quoted inbound HTML, and shared-mailbox composers can't
  // store XSS for the next reader. Inbound mail is also sanitized at ingest.
  const htmlBody = sanitizeEmailHtml(data.htmlBody) || undefined;

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
  const resolvedAttachments = await resolveAttachments(env, orgId, data);

  // ---- Send via Cloudflare ---------------------------------------------
  const fromAddress = account.displayName
    ? `${account.displayName} <${account.email}>`
    : account.email;

  const extraHeaders: Record<string, string> = {};
  if (data.inReplyTo) extraHeaders['In-Reply-To'] = data.inReplyTo;
  if (data.references?.length) extraHeaders['References'] = data.references.join(' ');

  const sendResult = opts?.dryRun
    ? { messageId: `<dryrun-${generateId('msg')}@e2e.test>`, pendingVerification: false }
    : await cfEmail.sendEmail(env, {
        from: fromAddress,
        to: data.to,
        subject: data.subject || '(No subject)',
        html: htmlBody,
        text: data.body,
        cc: data.cc,
        bcc: data.bcc,
        replyTo: data.replyTo,
        headers: Object.keys(extraHeaders).length ? extraHeaders : undefined,
        attachments: resolvedAttachments.length
          ? resolvedAttachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              content: a.content,
            }))
          : undefined,
      });

  const externalMessageId = sendResult.messageId;
  const smtpMessageIdRaw = externalMessageId.replace(/^<|>$/g, '');
  const smtpMessageId = smtpMessageIdRaw.startsWith('<') ? smtpMessageIdRaw : `<${smtpMessageIdRaw}>`;
  const messageId = generateId('msg');
  const now = new Date();

  // ---- Thread stitching (replies inherit parent thread) ----------------
  let threadId: string = smtpMessageId;
  const lookupIds = [...(data.inReplyTo ? [data.inReplyTo] : []), ...(data.references ?? [])];
  if (lookupIds.length > 0) {
    const providerIds = lookupIds
      .map((id) => id.replace(/^</, '').replace(/@.*>?$/, ''))
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
    if (parent?.threadId) threadId = parent.threadId;
  }

  // ---- Persist SENT copy ------------------------------------------------
  const textPreview = (data.body || (htmlBody ?? '').replace(/<[^>]*>/g, '')).slice(0, 200);
  try {
    await db.insert(mailMessages).values({
      id: messageId,
      accountId,
      labels: ['SENT'],
      messageId: smtpMessageId,
      threadId,
      from: { email: account.email, name: account.displayName || undefined },
      to: data.to.map((email) => ({ email })),
      cc: data.cc?.map((email) => ({ email })),
      bcc: data.bcc?.map((email) => ({ email })),
      subject: data.subject || '(No subject)',
      preview: textPreview,
      textBody: data.body,
      htmlBody,
      sentDate: now,
      isRead: true,
      source: 'sent',
      inReplyTo: data.inReplyTo,
      references: data.references,
      isReply: !!data.inReplyTo,
      externalMessageId,
      idempotencyKey: data.idempotencyKey,
      hasAttachments: resolvedAttachments.length > 0,
      attachmentCount: resolvedAttachments.length,
      createdAt: now,
      updatedAt: now,
    });
  } catch (insertErr) {
    // A concurrent send with the same idempotency key won the unique-index
    // race: return its persisted row instead of double-recording. (The provider
    // send already happened above; a true concurrent double-send is a narrow,
    // documented edge — sequential offline replay is guarded by the pre-check.)
    if (data.idempotencyKey) {
      const existing = await findSentByIdempotencyKey(db, accountId, data.idempotencyKey);
      if (existing) return existing;
    }
    throw insertErr;
  }

  // ---- Persist attachment pointers (best-effort) -----------------------
  if (resolvedAttachments.length > 0) {
    for (const att of resolvedAttachments) {
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
    }
  }

  // ---- Bump daily counter ----------------------------------------------
  await db
    .update(mailAccounts)
    .set({ sentToday: sql`${mailAccounts.sentToday} + 1`, updatedAt: now })
    .where(eq(mailAccounts.id, accountId));

  // ---- Background: upsert recipients into contacts ---------------------
  // Skipped under dry-run so test sends don't create real `people` rows that
  // /reset can't find (they carry no test marker).
  if (!opts?.dryRun) {
    const upsertJob = upsertMailContacts(env, db, orgId, {
      to: data.to.map((email) => ({ email })),
      cc: data.cc?.map((email) => ({ email })),
      bcc: data.bcc?.map((email) => ({ email })),
    });
    if (waitUntil) {
      waitUntil(upsertJob);
    } else {
      // Falls back to inline await — slower send response but correct.
      await upsertJob;
    }
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

async function resolveAttachments(
  env: Env,
  orgId: string,
  data: SendComposeInput,
): Promise<{ filename: string; contentType?: string; content: ArrayBuffer; fileKey: string }[]> {
  if (!data.attachments?.length) return [];
  if (!env.STORAGE) {
    throw new MailSendError('STORAGE_BINDING_MISSING', 'Storage binding not configured');
  }

  const workspacePrefix = `workspaces/${orgId}/`;
  let totalBytes =
    (data.body ? new TextEncoder().encode(data.body).byteLength : 0) +
    (data.htmlBody ? new TextEncoder().encode(data.htmlBody).byteLength : 0);

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
    if (totalBytes > MAX_EMAIL_SIZE_BYTES) {
      throw new MailSendError(
        'EMAIL_TOO_LARGE',
        `Email exceeds the ${MAX_EMAIL_SIZE_BYTES / (1024 * 1024)} MB limit (body + attachments).`,
      );
    }
    resolved.push({
      filename: att.filename,
      contentType: att.contentType || obj.httpMetadata?.contentType,
      content: buf,
      fileKey: att.fileKey,
    });
  }
  return resolved;
}

/**
 * Forward variant — looks up the original message, prepends the standard
 * quoted "Forwarded message" block to the user's body, prefixes the
 * subject with `Fwd:` if absent, and hands off to `sendAndPersist`.
 *
 * Recipients come from the user (not the original); the forwarded
 * message inherits no threading metadata since it's a fresh thread for
 * the new recipients.
 */
export async function forwardAndPersist(
  env: Env,
  db: Database,
  orgId: string,
  userId: string,
  originalMessageId: string,
  data: { to: string[]; body?: string; htmlBody?: string; attachments?: SendAttachmentInput[] },
  waitUntil?: ExecutionContext['waitUntil'],
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

  const originalFrom = original.from as { email?: string; name?: string } | null;
  const senderLabel = originalFrom?.name
    ? `${originalFrom.name} <${originalFrom.email ?? ''}>`
    : originalFrom?.email ?? 'Unknown';
  const dateLabel = (original.sentDate ?? original.receivedDate ?? original.createdAt ?? new Date()).toString();

  const quotedTextBody = original.textBody
    ? `\n\n---------- Forwarded message ----------\nFrom: ${senderLabel}\nDate: ${dateLabel}\nSubject: ${original.subject ?? ''}\n\n${original.textBody}`
    : undefined;
  const quotedHtmlBody = original.htmlBody
    ? `<br><br><div style="border-left:2px solid #ccc;padding-left:1em;color:#555"><p>---------- Forwarded message ----------</p><p><b>From:</b> ${senderLabel}<br><b>Date:</b> ${dateLabel}<br><b>Subject:</b> ${original.subject ?? ''}</p>${original.htmlBody}</div>`
    : undefined;

  const composedBody = quotedTextBody ? `${data.body ?? ''}${quotedTextBody}` : data.body;
  const composedHtml = quotedHtmlBody ? `${data.htmlBody ?? ''}${quotedHtmlBody}` : data.htmlBody;

  const result = await sendAndPersist(
    env,
    db,
    orgId,
    userId,
    original.accountId,
    {
      to: data.to,
      subject,
      body: composedBody,
      htmlBody: composedHtml,
      attachments: data.attachments,
    },
    waitUntil,
    opts,
  );
  return { ...result, forwardedFrom: originalMessageId };
}

/**
 * Reply variant — looks up the original message, derives recipients and
 * threading headers, then hands off to `sendAndPersist`.
 */
export async function replyAndPersist(
  env: Env,
  db: Database,
  orgId: string,
  userId: string,
  originalMessageId: string,
  data: { body?: string; htmlBody?: string; replyAll?: boolean },
  waitUntil?: ExecutionContext['waitUntil'],
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
  if (data.replyAll && original.to) {
    const origTo = original.to as { email?: string }[];
    for (const addr of origTo) {
      if (addr.email && addr.email !== account.email && !toAddresses.includes(addr.email)) {
        toAddresses.push(addr.email);
      }
    }
  }

  const originalSmtpId = original.messageId;
  const existingRefs = (original.references as string[]) || [];
  const references = [...existingRefs, originalSmtpId].filter(Boolean);

  const result = await sendAndPersist(
    env,
    db,
    orgId,
    userId,
    original.accountId,
    {
      to: toAddresses,
      subject: `Re: ${(original.subject || '').replace(/^Re:\s*/i, '')}`,
      body: data.body,
      htmlBody: data.htmlBody,
      inReplyTo: originalSmtpId,
      references,
    },
    waitUntil,
    opts,
  );
  return { ...result, repliedTo: originalMessageId };
}
