/**
 * Send one email from a WeldReach mailbox and record it in `reach_messages`.
 *
 * The single outbound path: the send queue consumer uses it for campaign
 * steps and the reply inbox uses it for answers typed by a user. It writes the
 * `reach_messages` row (status `sending`, pre-generated Message-ID) BEFORE the
 * SMTP transaction, so a crash can never cause a silent double send: a row
 * left in `sending` is marked `unknown` later and never retried.
 *
 * Every message gets the workspace opt-out line + sender footer (campaign
 * steps) and a `List-Unsubscribe: <mailto:{mailbox}?subject=unsubscribe>`
 * header. Nothing in it references a WeldSuite domain.
 *
 * Who may send: a campaign step needs an `active` mailbox. An answer typed by
 * a person in the reply inbox (`sentBy` set) is also allowed from a `warming`
 * or `paused` mailbox, because the prospect wrote to that address first.
 *
 * CONTRACT (the reply inbox codes against it):
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import { generateId } from '@weldsuite/worker-kit/id';
import { emailDomain } from '@weldsuite/app-api-client/schemas/reach';
import { reachMailboxes, reachMessages, reachSettings, type ReachMessage } from '@weldsuite/db/schema';
import { buildMimeMessage, generateMessageId, sendMail, type SmtpSocketFactory } from '@weldsuite/smtp';
import type { Env } from '../types';
import { openMailServerCredentials } from '../lib/credentials';
import { buildEmailFooter, snippetOf } from './render';

export interface SendFromMailboxInput {
  mailboxId: string;
  to: { email: string; name?: string };
  subject: string;
  /** Final text (already rendered). The footer/opt-out is added when `appendFooter` is true. */
  text: string;
  appendFooter: boolean;
  /** Threading, without angle brackets. */
  inReplyTo?: string | null;
  references?: string[];
  /** Root Message-ID of the conversation (reach_messages.thread_key); defaults to this message's own id. */
  threadKey?: string | null;
  campaignId?: string | null;
  enrollmentId?: string | null;
  stepId?: string | null;
  prospectId?: string | null;
  /** Clerk user id when a person sent it from the reply inbox. */
  sentBy?: string | null;
}

export type SendFromMailboxResult =
  | { ok: true; message: ReachMessage }
  | {
      ok: false;
      message: ReachMessage | null;
      /** Do not retry: hard bounce, auth failure, missing credentials, mailbox not usable. */
      permanent: boolean;
      recipientRejected: boolean;
      authFailed: boolean;
      error: string;
    };

export interface OutboundDeps {
  env: Env;
  db: Database;
  /** Injected in tests; defaults to cloudflare:sockets. */
  connect?: SmtpSocketFactory;
  now?: () => Date;
}

/**
 * `error` values of a failure that happened before any message row existed
 * (`message: null`): a problem with the mailbox, not with this recipient.
 */
export const MAILBOX_NOT_FOUND = 'mailbox_not_found';
export const MAILBOX_NOT_USABLE = 'mailbox_not_usable';
export const CREDENTIALS_UNAVAILABLE = 'credentials_unavailable';

const REPLY_SEND_STATUSES: ReadonlySet<string> = new Set(['active', 'warming', 'paused']);

function notSent(error: string): SendFromMailboxResult {
  return { ok: false, message: null, permanent: true, recipientRejected: false, authFailed: false, error };
}

export async function sendFromMailbox(deps: OutboundDeps, input: SendFromMailboxInput): Promise<SendFromMailboxResult> {
  const { env, db } = deps;
  const now = deps.now ?? (() => new Date());

  const [mailbox] = await db
    .select()
    .from(reachMailboxes)
    .where(and(eq(reachMailboxes.id, input.mailboxId), isNull(reachMailboxes.deletedAt)))
    .limit(1);
  if (!mailbox) return notSent(MAILBOX_NOT_FOUND);

  const allowed = input.sentBy ? REPLY_SEND_STATUSES.has(mailbox.status) : mailbox.status === 'active';
  if (!allowed) return notSent(`${MAILBOX_NOT_USABLE}: ${mailbox.status}`);

  const credentials = await openMailServerCredentials(env, mailbox.smtpCredentials);
  if (!credentials) return notSent(CREDENTIALS_UNAVAILABLE);

  let text = input.text;
  if (input.appendFooter) {
    const [settings] = await db.select().from(reachSettings).limit(1);
    text += buildEmailFooter(settings ?? null);
  }

  const messageId = generateMessageId(emailDomain(mailbox.email));
  const references = input.references ?? [];
  const fromName = `${mailbox.firstName} ${mailbox.lastName}`.trim();

  let raw: string;
  try {
    raw = buildMimeMessage({
      from: { email: mailbox.email, name: fromName === '' ? undefined : fromName },
      to: [{ email: input.to.email, name: input.to.name }],
      subject: input.subject,
      text,
      messageId,
      inReplyTo: input.inReplyTo ?? undefined,
      references: references.length > 0 ? references : undefined,
      headers: { 'List-Unsubscribe': `<mailto:${mailbox.email}?subject=unsubscribe>` },
      date: now(),
    });
  } catch (err) {
    return notSent(`message_build_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The row exists before the SMTP transaction starts: whatever happens next
  // (crash, timeout, lost reply) leaves a trace that blocks a second send.
  const [row] = await db
    .insert(reachMessages)
    .values({
      id: generateId('rmsg'),
      direction: 'out',
      campaignId: input.campaignId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      stepId: input.stepId ?? null,
      mailboxId: mailbox.id,
      prospectId: input.prospectId ?? null,
      threadKey: input.threadKey ?? messageId,
      messageIdHeader: messageId,
      inReplyTo: input.inReplyTo ?? null,
      references: references.length > 0 ? references.join(' ') : null,
      fromEmail: mailbox.email,
      toEmail: input.to.email,
      subject: input.subject,
      snippet: snippetOf(input.text),
      bodyText: text,
      status: 'sending',
      sentBy: input.sentBy ?? null,
    })
    .returning();
  if (!row) return notSent('message_insert_failed');

  const finish = async (patch: Partial<typeof reachMessages.$inferInsert>): Promise<ReachMessage> => {
    const [updated] = await db
      .update(reachMessages)
      .set({ ...patch, updatedAt: now() })
      .where(eq(reachMessages.id, row.id))
      .returning();
    return updated ?? row;
  };

  let result: Awaited<ReturnType<typeof sendMail>>;
  try {
    result = await sendMail(
      {
        host: credentials.host,
        port: credentials.port,
        secure: credentials.port === 465,
        username: credentials.username,
        password: credentials.password,
      },
      { from: mailbox.email, to: [input.to.email] },
      raw,
      { connect: deps.connect },
    );
  } catch (err) {
    // sendMail reports network and server errors as results; an exception means
    // something unexpected, and the message may or may not have left.
    const reason = err instanceof Error ? err.message : String(err);
    const message = await finish({ status: 'unknown', error: `send_threw: ${reason}` });
    return { ok: false, message, permanent: true, recipientRejected: false, authFailed: false, error: `send_threw: ${reason}` };
  }

  if (result.ok) {
    const sentAt = now();
    const message = await finish({ status: 'sent', sentAt, smtpResponse: result.response, error: null });
    await db
      .update(reachMailboxes)
      .set({ lastSentAt: sentAt, updatedAt: sentAt })
      .where(eq(reachMailboxes.id, mailbox.id));
    return { ok: true, message };
  }

  const uncertain = result.deliveryUncertain === true;
  const error = `${result.stage}: ${result.response}`;
  const message = await finish({ status: uncertain ? 'unknown' : 'failed', smtpResponse: result.response, error });
  return {
    ok: false,
    message,
    // A reply that may already be delivered must never be retried either.
    permanent: result.permanent || uncertain,
    recipientRejected: result.recipientRejected,
    authFailed: result.authFailed,
    error,
  };
}
