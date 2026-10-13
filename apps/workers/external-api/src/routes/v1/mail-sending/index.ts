/**
 * Sending mail through the public API: uploads, compose, reply, forward and
 * draft-send.
 *
 * Only the public API mounts this file. The MCP server shares the other mail
 * routes but not these, so an AI agent drafts and a person presses send.
 *
 * Paths are absolute because the routes sit under several resources:
 *   POST /v1/mail-attachments              upload a file for a new message
 *   POST /v1/mail-accounts/:id/send        compose and send
 *   POST /v1/mail-messages/:id/reply       reply (or reply-all)
 *   POST /v1/mail-messages/:id/forward     forward
 *   POST /v1/mail-drafts/:id/send          send a saved draft, then delete it
 *
 * Every send runs the platform's own send path (`@weldsuite/mail-domain/send`)
 * with two policies on top:
 *   - the sending address must be on a verified WeldMail domain, so the mail
 *     authenticates (SPF/DKIM) instead of landing in spam;
 *   - the account's `dailySendLimit` holds, counted from UTC midnight.
 * The send path also runs the outbound guard (sender ownership, recipient
 * limits, first-contact and cold-outreach caps) with source `api`, so a send
 * can be refused with a guard code. `sendErrorResponse` maps those, and
 * Cloudflare's own refusals, to 403 / 422 / 429 / 502 / 503 with `Retry-After`
 * where a retry can succeed (docs/plans/weldmail-outbound-abuse.md).
 * Sending needs `mail_messages:send`, a scope that `*` and `mail_messages:*`
 * do not include (see `lib/scopes.ts`).
 *
 * An `Idempotency-Key` header makes a send safe to retry: a repeat with the
 * same key returns the first result (`replayed: true`) without sending again.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { schema } from '../../../db';
import {
  OUTBOUND_DENIAL_CODES,
  outboundDenialStatus,
  type OutboundDenialCode,
  type OutboundDenialDetails,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { canOpenAccount, emailEventData } from '@weldsuite/mail-domain/access';
import { getDraft } from '@weldsuite/mail-domain/drafts';
import { getMessageAccountId } from '@weldsuite/mail-domain/messages';
import {
  findSentByIdempotencyKey,
  forwardAndPersist,
  MailSendError,
  replyAndPersist,
  sendAndPersist,
  sendDraftAndPersist,
  type SendOptions,
  type SendResult,
} from '@weldsuite/mail-domain/send';
import { MAX_UPLOAD_BYTES, MailUploadError, resolveMailUploads, storeMailUpload } from '@weldsuite/mail-domain/uploads';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, success } from '../../../lib/response';
import { mailPrincipal } from '../../../lib/mail';
import { resolveClerkOrgId } from '../../../lib/social-context';

/** The policies every public-API send runs under. */
const API_SEND_POLICY: SendOptions = { enforceDailyLimit: true, requireVerifiedDomain: true };

/** Seconds a client should wait after Cloudflare's own rate limit. */
const PROVIDER_RATE_LIMIT_RETRY_SECONDS = 60;

const addresses = z.array(z.string().email()).max(100);
const attachmentIds = z.array(z.string()).max(20).optional();

/** A message needs some content: an email with neither part cannot be built. */
const hasContent = (b: { body?: string; htmlBody?: string }) => !!(b.body?.trim() || b.htmlBody?.trim());
const NO_CONTENT = { message: 'Give a body or an htmlBody', path: ['body'] };

const sendBody = z
  .object({
    to: addresses.min(1),
    cc: addresses.optional(),
    bcc: addresses.optional(),
    replyTo: z.string().email().optional(),
    subject: z.string().max(998).optional(),
    body: z.string().max(1_000_000).optional(),
    htmlBody: z.string().max(2_000_000).optional(),
    importance: z.enum(['low', 'normal', 'high']).optional(),
    attachmentIds,
  })
  .refine(hasContent, NO_CONTENT);

const replyBody = z
  .object({
    body: z.string().max(1_000_000).optional(),
    htmlBody: z.string().max(2_000_000).optional(),
    replyAll: z.boolean().default(false),
    attachmentIds,
  })
  .refine(hasContent, NO_CONTENT);

const forwardBody = z.object({
  to: addresses.min(1),
  body: z.string().max(1_000_000).optional(),
  htmlBody: z.string().max(2_000_000).optional(),
  attachmentIds,
  /** Ids of the original's attachments to leave out. */
  excludeAttachmentIds: z.array(z.string()).max(100).optional(),
  /** Attach the original as an `.eml` file instead of quoting it. */
  asAttachment: z.boolean().optional(),
});

const draftSendBody = z.object({
  /** Overrides the draft's own `attachmentIds` when given. */
  attachmentIds,
});

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `waitUntil` when the runtime gives one (tests and some callers do not). */
function waitUntilOf(c: Context<HonoEnv>): ExecutionContext['waitUntil'] | undefined {
  try {
    const ctx = c.executionCtx;
    return ctx.waitUntil.bind(ctx);
  } catch {
    return undefined;
  }
}

/**
 * The send options for one public-API request: the API policies, plus how the
 * outbound guard labels it. Source `api` weighs more than compose in the risk
 * score; the key's master workspace id saves the guard a lookup.
 */
function sendOptionsFor(c: Context<HonoEnv>): SendOptions {
  return {
    ...API_SEND_POLICY,
    waitUntil: waitUntilOf(c),
    outbound: { source: 'api', workspaceId: c.get('apiSession').workspaceId },
  };
}

function idempotencyKeyOf(c: Context<HonoEnv>): { key?: string; invalid?: true } {
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key) return {};
  if (key.length > 64) return { invalid: true };
  return { key };
}

/**
 * R2 keys and the send path use the Clerk org id, not the master workspace id.
 * The auth middleware carries it on the session; an older cached session
 * entry does not, and then it is looked up.
 */
async function orgIdOf(c: Context<HonoEnv>): Promise<string | null> {
  const session = c.get('apiSession');
  if (session.clerkOrgId !== undefined) return session.clerkOrgId;
  return resolveClerkOrgId(c.env, session.workspaceId);
}

function orgMissing(c: Context<HonoEnv>) {
  return c.json({ error: { code: 'WORKSPACE_NOT_CONFIGURED', message: 'This workspace has no organisation' } }, 503);
}

/** Whole seconds until an ISO time, at least 1; null when it is missing or not a date. */
function secondsUntil(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(1, Math.ceil((at - Date.now()) / 1000));
}

function isOutboundDenialCode(code: string): code is OutboundDenialCode {
  return (OUTBOUND_DENIAL_CODES as readonly string[]).includes(code);
}

/**
 * The outbound guard refused: the status comes from the shared denial table
 * (403 staff or ownership, 422 the message itself, 429 a window is full),
 * `Retry-After` from `details.retryAfter` when a retry can succeed. Which
 * workspace owns a refused sender address is not the caller's to learn, so
 * that one carries no details.
 */
function denialResponse(c: Context<HonoEnv>, err: MailSendError, code: OutboundDenialCode) {
  const details = err.details as OutboundDenialDetails | undefined;
  const retryAfter = secondsUntil(details?.retryAfter);
  if (retryAfter) c.header('Retry-After', String(retryAfter));
  return c.json(
    {
      error: {
        code,
        message: err.message,
        ...(details && code !== 'SENDER_NOT_OWNED' ? { details } : {}),
      },
    },
    outboundDenialStatus(code),
  );
}

function sendErrorResponse(c: Context<HonoEnv>, err: unknown, resource: string, id: string) {
  if (!(err instanceof MailSendError)) throw err;
  const body = (status: 413 | 422 | 429 | 502 | 503) =>
    c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, status);
  switch (err.code) {
    case 'ACCOUNT_NOT_FOUND':
    case 'FORBIDDEN':
      return error.notFound(c, resource, id);
    case 'DRAFT_NOT_FOUND':
      return error.notFound(c, 'MailDraft', id);
    case 'INVALID_RECIPIENTS':
    case 'ATTACHMENT_NOT_IN_WORKSPACE':
    case 'ATTACHMENT_NOT_IN_STORAGE':
    case 'SENDER_DOMAIN_NOT_VERIFIED':
      return body(422);
    case 'EMAIL_TOO_LARGE':
      return body(413);
    case 'DAILY_LIMIT_REACHED': {
      const resetsAt = (err.details as { resetsAt?: string } | undefined)?.resetsAt;
      const retryAfter = resetsAt ? Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1000)) : 3600;
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, 429);
    }
    case 'PROVIDER_RATE_LIMITED':
      // Cloudflare's own rate limit: a minute is enough.
      c.header('Retry-After', String(PROVIDER_RATE_LIMIT_RETRY_SECONDS));
      return body(429);
    case 'PROVIDER_DAILY_LIMIT':
    case 'SEND_BINDING_MISSING':
    case 'STORAGE_BINDING_MISSING':
      return body(503);
    case 'PARTIALLY_SENT':
      // Some recipients got the message before the send failed; details say who.
      return body(502);
    default:
      if (isOutboundDenialCode(err.code)) return denialResponse(c, err, err.code);
      return error.internal(c, err.message);
  }
}

function sentResponse(c: Context<HonoEnv>, result: SendResult, replayed: boolean, extra: Record<string, unknown> = {}) {
  return success(c, {
    messageId: result.messageId,
    accountId: result.accountId,
    subject: result.subject,
    smtpMessageId: result.smtpMessageId,
    pendingVerification: result.pendingVerification,
    replayed,
    ...extra,
  });
}

async function publishSent(
  c: Context<HonoEnv>,
  result: SendResult,
  action: 'email_sent' | 'reply_sent',
  fields: { to?: string[] | null; conversationId?: string } = {},
) {
  publishEntityEvent({
    c,
    entityType: 'email',
    entityId: result.messageId,
    action,
    data: await emailEventData(c.get('tenantDb'), {
      id: result.messageId,
      accountId: result.accountId,
      subject: result.subject,
      from: null,
      to: fields.to ?? null,
      conversationId: fields.conversationId,
    }),
  });
}

/** A replay: return the earlier send without sending or publishing again. */
async function replayOf(c: Context<HonoEnv>, accountId: string, key: string | undefined) {
  if (!key) return null;
  return findSentByIdempotencyKey(c.get('tenantDb'), accountId, key);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

app.post('/mail-attachments', requireScope('mail_attachments:write'), async (c) => {
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return c.json({ error: { code: 'FILE_TOO_LARGE', message: 'Files are limited to 5 MB' } }, 413);
  }

  let file: { filename: string; contentType?: string; content: ArrayBuffer };
  const type = c.req.header('Content-Type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await c.req.parseBody();
    const part = form['file'];
    if (!(part instanceof File)) return error.badRequest(c, 'Send the file in a form field named "file"');
    file = { filename: part.name, contentType: part.type || undefined, content: await part.arrayBuffer() };
  } else {
    const filename = c.req.query('filename')?.trim();
    if (!filename) return error.badRequest(c, 'Name the file with ?filename=, or upload it as multipart/form-data');
    file = { filename, contentType: type || undefined, content: await c.req.arrayBuffer() };
  }

  const orgId = await orgIdOf(c);
  if (!orgId) return orgMissing(c);
  try {
    return success(c, await storeMailUpload(c.env, orgId, file), 201);
  } catch (err) {
    if (!(err instanceof MailUploadError)) throw err;
    if (err.code === 'FILE_TOO_LARGE') return c.json({ error: { code: err.code, message: err.message } }, 413);
    if (err.code === 'EMPTY_FILE') return error.badRequest(c, err.message);
    return c.json({ error: { code: err.code, message: err.message } }, 503);
  }
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

app.post('/mail-accounts/:id/send', requireScope('mail_messages:send'), zValidator('json', sendBody), async (c) => {
  const db = c.get('tenantDb');
  const accountId = c.req.param('id');
  const principal = mailPrincipal(c);
  const idem = idempotencyKeyOf(c);
  if (idem.invalid) return error.badRequest(c, 'Idempotency-Key is limited to 64 characters');
  if (!(await canOpenAccount(db, accountId, principal))) return error.notFound(c, 'MailAccount', accountId);

  const replay = await replayOf(c, accountId, idem.key);
  if (replay) return sentResponse(c, replay, true);

  const orgId = await orgIdOf(c);
  if (!orgId) return orgMissing(c);
  const { attachmentIds: uploadIds, ...data } = c.req.valid('json');
  try {
    const attachments = await resolveMailUploads(c.env, orgId, uploadIds ?? []);
    const result = await sendAndPersist(
      c.env,
      db,
      orgId,
      principal,
      accountId,
      { ...data, attachments, idempotencyKey: idem.key },
      sendOptionsFor(c),
    );
    await publishSent(c, result, 'email_sent', { to: data.to });
    return sentResponse(c, result, false);
  } catch (err) {
    return sendErrorResponse(c, err, 'MailAccount', accountId);
  }
});

app.post('/mail-messages/:id/reply', requireScope('mail_messages:send'), zValidator('json', replyBody), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const principal = mailPrincipal(c);
  const idem = idempotencyKeyOf(c);
  if (idem.invalid) return error.badRequest(c, 'Idempotency-Key is limited to 64 characters');
  const accountId = await getMessageAccountId(db, id);
  if (!accountId || !(await canOpenAccount(db, accountId, principal))) return error.notFound(c, 'Message', id);

  const replay = await replayOf(c, accountId, idem.key);
  if (replay) return sentResponse(c, replay, true, { repliedTo: id });

  const orgId = await orgIdOf(c);
  if (!orgId) return orgMissing(c);
  const { attachmentIds: uploadIds, ...data } = c.req.valid('json');
  try {
    const attachments = await resolveMailUploads(c.env, orgId, uploadIds ?? []);
    const result = await replyAndPersist(
      c.env,
      db,
      orgId,
      principal,
      id,
      { ...data, attachments, idempotencyKey: idem.key },
      sendOptionsFor(c),
    );
    await publishSent(c, result, 'reply_sent', { conversationId: result.repliedTo });
    return sentResponse(c, result, false, { repliedTo: result.repliedTo });
  } catch (err) {
    return sendErrorResponse(c, err, 'Message', id);
  }
});

app.post('/mail-messages/:id/forward', requireScope('mail_messages:send'), zValidator('json', forwardBody), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const principal = mailPrincipal(c);
  const idem = idempotencyKeyOf(c);
  if (idem.invalid) return error.badRequest(c, 'Idempotency-Key is limited to 64 characters');
  const accountId = await getMessageAccountId(db, id);
  if (!accountId || !(await canOpenAccount(db, accountId, principal))) return error.notFound(c, 'Message', id);

  const replay = await replayOf(c, accountId, idem.key);
  if (replay) return sentResponse(c, replay, true, { forwardedFrom: id });

  const orgId = await orgIdOf(c);
  if (!orgId) return orgMissing(c);
  const { attachmentIds: uploadIds, ...data } = c.req.valid('json');
  try {
    const attachments = await resolveMailUploads(c.env, orgId, uploadIds ?? []);
    const result = await forwardAndPersist(
      c.env,
      db,
      orgId,
      principal,
      id,
      { ...data, attachments, idempotencyKey: idem.key },
      sendOptionsFor(c),
    );
    await publishSent(c, result, 'email_sent', { to: data.to, conversationId: result.forwardedFrom });
    return sentResponse(c, result, false, { forwardedFrom: result.forwardedFrom });
  } catch (err) {
    return sendErrorResponse(c, err, 'Message', id);
  }
});

app.post('/mail-drafts/:id/send', requireScope('mail_messages:send'), zValidator('json', draftSendBody), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const principal = mailPrincipal(c);
  const idem = idempotencyKeyOf(c);
  if (idem.invalid) return error.badRequest(c, 'Idempotency-Key is limited to 64 characters');
  const draft = await getDraft(db, id);
  if (!draft) {
    // A successful send deleted the draft. A retry with the same key still
    // gets the first result, as long as the caller may open that mailbox.
    if (idem.key) {
      const [sentDraft] = await db
        .select({ accountId: schema.mailDrafts.accountId })
        .from(schema.mailDrafts)
        .where(eq(schema.mailDrafts.id, id))
        .limit(1);
      if (sentDraft && (await canOpenAccount(db, sentDraft.accountId, principal))) {
        const replay = await replayOf(c, sentDraft.accountId, idem.key);
        if (replay) return sentResponse(c, replay, true, { draftId: id });
      }
    }
    return error.notFound(c, 'MailDraft', id);
  }
  if (!(await canOpenAccount(db, draft.accountId, principal))) return error.notFound(c, 'MailDraft', id);

  const replay = await replayOf(c, draft.accountId, idem.key);
  if (replay) return sentResponse(c, replay, true, { draftId: id });
  if (!hasContent({ body: draft.body ?? undefined, htmlBody: draft.htmlBody ?? undefined })) {
    return c.json({ error: { code: 'EMPTY_BODY', message: 'The draft has no body to send' } }, 422);
  }

  const orgId = await orgIdOf(c);
  if (!orgId) return orgMissing(c);
  const uploadIds = c.req.valid('json').attachmentIds ?? (draft.attachmentIds as string[] | null) ?? [];
  try {
    const attachments = await resolveMailUploads(c.env, orgId, uploadIds);
    const result = await sendDraftAndPersist(
      c.env,
      db,
      orgId,
      principal,
      id,
      { attachments, idempotencyKey: idem.key },
      sendOptionsFor(c),
    );
    await publishSent(c, result, 'email_sent', { to: (draft.to as string[] | null) ?? null });
    publishEntityEvent({
      c,
      entityType: 'mail_draft',
      entityId: id,
      action: 'deleted',
      data: { id, accountId: draft.accountId, subject: null },
    });
    return sentResponse(c, result, false, { draftId: id });
  } catch (err) {
    return sendErrorResponse(c, err, 'MailDraft', id);
  }
});

export default app;
