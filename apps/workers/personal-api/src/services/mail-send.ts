/**
 * Shared "send + persist" helper for personal (consumer WeldMail) outbound mail.
 *
 * Compose, reply and forward all do the same work: enforce the plan's daily
 * limit, short-circuit a replayed idempotency key, sanitize the HTML body, hand
 * the envelope to the Cloudflare `send_email` binding, then persist a SENT copy
 * stitched into the right thread. Keeping it in one place means a change to the
 * send path (a new header, a different limit) lands once rather than three
 * times — the same reason app-api has `services/mail/send.ts`.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { sanitizeEmailHtml } from '@weldsuite/email/sanitize';
import type { PersonalMailEmailAddress } from '@weldsuite/db/schema/personal';
import { personalSchema, type PersonalDatabase } from '../db';
import { generateId } from '../lib/id';
import { sendEmail } from '../lib/cloudflare-email';
import type { Env } from '../types';
import type { PersonalEntitlements } from '../lib/billing';

const { personalMailAccounts, personalMailMessages } = personalSchema;

export type PersonalMailAccountRow = typeof personalMailAccounts.$inferSelect;
export type PersonalMailMessageRow = typeof personalMailMessages.$inferSelect;

export class PersonalMailSendError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'MESSAGE_NOT_FOUND'
      | 'DAILY_LIMIT_REACHED'
      | 'NO_RECIPIENTS'
      | 'DELIVERY_FAILED',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PersonalMailSendError';
  }
}

export interface SendComposeInput {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  /** RFC 5322 Message-ID of the message being answered. */
  inReplyTo?: string;
  /** Full ancestry chain; the first entry roots the thread. */
  references?: string[];
  /** Explicit thread to attach to, when the caller already knows it. */
  threadId?: string;
  idempotencyKey?: string;
}

export interface SendOutcome {
  message: PersonalMailMessageRow;
  pendingVerification: boolean;
}

function toAddresses(values: string[] | undefined): PersonalMailEmailAddress[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((email) => ({ email }));
}

function previewFrom(textBody?: string | null, htmlBody?: string | null): string | null {
  const raw =
    textBody?.trim() ||
    htmlBody?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ||
    '';
  if (!raw) return null;
  return raw.slice(0, 500);
}

/** Normalise a Message-ID to its angle-bracketed form. */
function bracket(messageId: string): string {
  const bare = messageId.replace(/^<|>$/g, '');
  return `<${bare}>`;
}

/** Load an account the caller owns, or throw. */
export async function requireAccount(
  db: PersonalDatabase,
  personalAccountId: string,
  accountId: string,
): Promise<PersonalMailAccountRow> {
  const [account] = await db
    .select()
    .from(personalMailAccounts)
    .where(
      and(
        eq(personalMailAccounts.id, accountId),
        eq(personalMailAccounts.personalAccountId, personalAccountId),
        isNull(personalMailAccounts.deletedAt),
      ),
    )
    .limit(1);

  if (!account) {
    throw new PersonalMailSendError('ACCOUNT_NOT_FOUND', `Mail account '${accountId}' not found`);
  }
  return account;
}

/** Load a message the caller owns, or throw. */
export async function requireMessage(
  db: PersonalDatabase,
  personalAccountId: string,
  messageId: string,
): Promise<PersonalMailMessageRow> {
  const [message] = await db
    .select()
    .from(personalMailMessages)
    .where(
      and(
        eq(personalMailMessages.id, messageId),
        eq(personalMailMessages.personalAccountId, personalAccountId),
        isNull(personalMailMessages.deletedAt),
      ),
    )
    .limit(1);

  if (!message) {
    throw new PersonalMailSendError('MESSAGE_NOT_FOUND', `Message '${messageId}' not found`);
  }
  return message;
}

/**
 * Count today's composed sends for an account.
 *
 * Counted live rather than read off `personal_mail_accounts.sentToday`, because
 * that column has no daily reset job — a stored counter would lock a user out
 * permanently once they hit the cap.
 */
async function countSentToday(db: PersonalDatabase, accountId: string): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(personalMailMessages)
    .where(
      and(
        eq(personalMailMessages.accountId, accountId),
        eq(personalMailMessages.source, 'composed'),
        sql`${personalMailMessages.sentDate} >= ${dayStart}`,
        isNull(personalMailMessages.deletedAt),
      ),
    );

  return Number(row?.count ?? 0);
}

async function findByIdempotencyKey(
  db: PersonalDatabase,
  accountId: string,
  idempotencyKey: string,
): Promise<PersonalMailMessageRow | null> {
  const [prior] = await db
    .select()
    .from(personalMailMessages)
    .where(
      and(
        eq(personalMailMessages.accountId, accountId),
        eq(personalMailMessages.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return prior ?? null;
}

/**
 * Resolve the thread a new outbound message belongs to.
 *
 * Prefers an explicit `threadId`, then the thread of whichever ancestor
 * (In-Reply-To or any References entry) we already store, and finally falls
 * back to the message's own id so a fresh conversation roots itself.
 */
async function resolveThreadId(
  db: PersonalDatabase,
  accountId: string,
  input: SendComposeInput,
  fallback: string,
): Promise<string> {
  if (input.threadId) return input.threadId;

  const lookupIds = [
    ...(input.inReplyTo ? [bracket(input.inReplyTo)] : []),
    ...(input.references ?? []).map(bracket),
  ];
  if (lookupIds.length === 0) return fallback;

  const [parent] = await db
    .select({ threadId: personalMailMessages.threadId })
    .from(personalMailMessages)
    .where(
      and(
        eq(personalMailMessages.accountId, accountId),
        or(
          inArray(personalMailMessages.messageId, lookupIds),
          inArray(personalMailMessages.threadId, lookupIds),
        ),
      ),
    )
    .limit(1);

  return parent?.threadId || lookupIds[0] || fallback;
}

/**
 * Send a composed message and persist the SENT copy.
 *
 * Throws `PersonalMailSendError` for every expected failure so route handlers
 * map one error type to one response shape.
 */
export async function sendAndPersist(
  env: Env,
  db: PersonalDatabase,
  personalAccountId: string,
  entitlements: PersonalEntitlements,
  input: SendComposeInput,
): Promise<SendOutcome> {
  const account = await requireAccount(db, personalAccountId, input.accountId);

  if (input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) === 0) {
    throw new PersonalMailSendError('NO_RECIPIENTS', 'At least one recipient is required');
  }

  // Replayed send (offline-queue flush, retry after a dropped response) —
  // return the original outcome instead of delivering a second copy.
  if (input.idempotencyKey) {
    const prior = await findByIdempotencyKey(db, account.id, input.idempotencyKey);
    if (prior) return { message: prior, pendingVerification: false };
  }

  const sentToday = await countSentToday(db, account.id);
  if (sentToday >= entitlements.dailySendLimit) {
    throw new PersonalMailSendError(
      'DAILY_LIMIT_REACHED',
      `Daily send limit of ${entitlements.dailySendLimit} reached. Upgrade to Pro for a higher limit.`,
      { plan: entitlements.plan, dailySendLimit: entitlements.dailySendLimit },
    );
  }

  // Sanitize once for both the transmitted and the stored copy. A reply quotes
  // inbound HTML, so without this a hostile sender's script would be echoed
  // back out and then re-rendered in the sender's own Sent view.
  const htmlBody = sanitizeEmailHtml(input.htmlBody) || undefined;

  const fromHeader = account.displayName
    ? `"${account.displayName}" <${account.email}>`
    : account.email;

  let providerMessageId: string;
  let pendingVerification = false;
  try {
    const sent = await sendEmail(env, {
      from: fromHeader,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.textBody,
      html: htmlBody,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });
    providerMessageId = sent.messageId;
    pendingVerification = !!sent.pendingVerification;
  } catch (err) {
    throw new PersonalMailSendError(
      'DELIVERY_FAILED',
      err instanceof Error ? err.message : 'Email delivery failed',
    );
  }

  const id = generateId('msg');
  const now = new Date();
  const messageId = providerMessageId.includes('@')
    ? bracket(providerMessageId)
    : `<${providerMessageId}@weldmail.com>`;

  const threadId = await resolveThreadId(db, account.id, input, messageId);

  const values = {
    id,
    personalAccountId,
    accountId: account.id,
    messageId,
    threadId,
    from: {
      email: account.email,
      name: account.displayName ?? account.name,
    } satisfies PersonalMailEmailAddress,
    to: toAddresses(input.to) ?? [],
    cc: toAddresses(input.cc) ?? null,
    bcc: toAddresses(input.bcc) ?? null,
    subject: input.subject,
    preview: previewFrom(input.textBody, htmlBody),
    textBody: input.textBody ?? null,
    htmlBody: htmlBody ?? null,
    sentDate: now,
    receivedDate: now,
    isRead: true,
    isStarred: false,
    isDraft: false,
    isSpam: false,
    isTrash: false,
    hasAttachments: false,
    inReplyTo: input.inReplyTo ? bracket(input.inReplyTo) : null,
    references: input.references?.map(bracket) ?? null,
    isReply: Boolean(input.inReplyTo),
    labels: ['SENT'],
    sendStatus: pendingVerification ? 'pending_verification' : 'sent',
    sendProvider: 'cloudflare',
    providerMessageId,
    source: 'composed',
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt: now,
    updatedAt: now,
  };

  let created: PersonalMailMessageRow;
  try {
    const [row] = await db.insert(personalMailMessages).values(values).returning();
    created = row!;
  } catch (insertErr) {
    // A concurrent send with the same key won the unique-index race. The
    // delivery above already happened, so return the row that won rather than
    // recording a duplicate.
    if (input.idempotencyKey) {
      const prior = await findByIdempotencyKey(db, account.id, input.idempotencyKey);
      if (prior) return { message: prior, pendingVerification };
    }
    throw insertErr;
  }

  // Best-effort display counter — the enforced limit is the live count above.
  try {
    await db
      .update(personalMailAccounts)
      .set({ sentToday: (account.sentToday ?? 0) + 1, updatedAt: now })
      .where(eq(personalMailAccounts.id, account.id));
  } catch (counterErr) {
    console.error('[personal-api/mail-send] sentToday bump failed:', counterErr);
  }

  return { message: created, pendingVerification };
}

/**
 * Work out who a reply goes to.
 *
 * The original sender goes on To. `replyAll` additionally keeps the original
 * To/Cc participants — Cc stays Cc — minus this mailbox, which is the one
 * sending. Comparison is case-insensitive because address casing is not
 * meaningful and duplicate rows would otherwise slip through.
 *
 * Exported for tests: this is the part of a reply that is easy to get subtly
 * wrong (self on the list, an address on both To and Cc) and cheap to pin down.
 */
export function deriveReplyRecipients(
  selfEmail: string,
  original: Pick<PersonalMailMessageRow, 'from' | 'to' | 'cc' | 'replyTo'>,
  replyAll = false,
): { to: string[]; cc: string[] } {
  const self = selfEmail.toLowerCase();
  const to: string[] = [];
  const cc: string[] = [];

  // Reply-To wins over From when the sender asked for it.
  const replyTarget = original.replyTo?.email || original.from?.email;
  if (replyTarget && replyTarget.toLowerCase() !== self) to.push(replyTarget);

  if (replyAll) {
    const isNew = (email: string | undefined): email is string =>
      !!email &&
      email.toLowerCase() !== self &&
      !to.some((e) => e.toLowerCase() === email.toLowerCase()) &&
      !cc.some((e) => e.toLowerCase() === email.toLowerCase());

    for (const addr of original.to ?? []) {
      if (isNew(addr.email)) to.push(addr.email);
    }
    for (const addr of original.cc ?? []) {
      if (isNew(addr.email)) cc.push(addr.email);
    }
  }

  // Replying to your own message (e.g. from the Sent view) leaves no target
  // above; fall back to the original recipients so the reply still goes out.
  if (to.length === 0 && cc.length === 0) {
    for (const addr of original.to ?? []) {
      if (addr.email) to.push(addr.email);
    }
  }

  return { to, cc };
}

/** `Re:` a subject exactly once, however many times it has been replied to. */
export function deriveReplySubject(subject: string | null | undefined): string {
  const base = (subject ?? '').trim();
  if (/^re:\s*/i.test(base)) return base;
  return `Re: ${base}`.trim();
}

/** `Fwd:` a subject exactly once, accepting either `Fwd:` or `Fw:` as present. */
export function deriveForwardSubject(subject: string | null | undefined): string {
  const base = (subject ?? '').trim();
  if (/^(fwd|fw):\s*/i.test(base)) return base;
  return `Fwd: ${base}`.trim();
}

/**
 * Build the References chain for a reply: the original's own chain plus the
 * message being answered, de-duplicated so a long thread doesn't accumulate
 * repeats that some clients use to mis-group the conversation.
 */
export function deriveReplyReferences(
  original: Pick<PersonalMailMessageRow, 'references' | 'messageId'>,
): string[] {
  const chain = [...(original.references ?? []), original.messageId]
    .filter((id): id is string => Boolean(id))
    .map(bracket);
  return [...new Set(chain)];
}

/**
 * Reply to a stored message.
 *
 * Recipients, subject and threading headers all come from the helpers above so
 * the rules are testable without a database.
 */
export async function replyAndPersist(
  env: Env,
  db: PersonalDatabase,
  personalAccountId: string,
  entitlements: PersonalEntitlements,
  originalMessageId: string,
  data: {
    textBody?: string;
    htmlBody?: string;
    replyAll?: boolean;
    idempotencyKey?: string;
  },
): Promise<SendOutcome & { repliedTo: string }> {
  const original = await requireMessage(db, personalAccountId, originalMessageId);
  const account = await requireAccount(db, personalAccountId, original.accountId);

  const { to, cc } = deriveReplyRecipients(account.email, original, data.replyAll);

  if (to.length === 0 && cc.length === 0) {
    throw new PersonalMailSendError(
      'NO_RECIPIENTS',
      'The original message has no address to reply to',
    );
  }

  const outcome = await sendAndPersist(env, db, personalAccountId, entitlements, {
    accountId: original.accountId,
    to,
    cc: cc.length ? cc : undefined,
    subject: deriveReplySubject(original.subject),
    textBody: data.textBody,
    htmlBody: data.htmlBody,
    inReplyTo: original.messageId,
    references: deriveReplyReferences(original),
    threadId: original.threadId ?? undefined,
    idempotencyKey: data.idempotencyKey,
  });

  return { ...outcome, repliedTo: originalMessageId };
}

/**
 * Forward a stored message to new recipients.
 *
 * The quoted original is appended to whatever the user wrote, matching the
 * "---------- Forwarded message ----------" convention every mail client
 * renders. A forward starts a fresh thread for its new recipients, so no
 * In-Reply-To/References are carried over.
 */
export async function forwardAndPersist(
  env: Env,
  db: PersonalDatabase,
  personalAccountId: string,
  entitlements: PersonalEntitlements,
  originalMessageId: string,
  data: {
    to: string[];
    cc?: string[];
    textBody?: string;
    htmlBody?: string;
    idempotencyKey?: string;
  },
): Promise<SendOutcome & { forwardedFrom: string }> {
  const original = await requireMessage(db, personalAccountId, originalMessageId);

  const subject = deriveForwardSubject(original.subject);

  const senderLabel = original.from?.name
    ? `${original.from.name} <${original.from.email}>`
    : original.from?.email || 'Unknown';
  const dateLabel = (original.sentDate ?? original.createdAt).toUTCString();
  const recipientLabel = (original.to ?? []).map((a) => a.email).join(', ');

  const textBody = original.textBody
    ? `${data.textBody ?? ''}\n\n---------- Forwarded message ----------\nFrom: ${senderLabel}\nDate: ${dateLabel}\nSubject: ${original.subject ?? ''}\nTo: ${recipientLabel}\n\n${original.textBody}`
    : data.textBody;

  const htmlBody = original.htmlBody
    ? `${data.htmlBody ?? ''}<br><br><div style="border-left:2px solid #ccc;padding-left:1em;color:#555"><p>---------- Forwarded message ----------</p><p><b>From:</b> ${senderLabel}<br><b>Date:</b> ${dateLabel}<br><b>Subject:</b> ${original.subject ?? ''}<br><b>To:</b> ${recipientLabel}</p>${original.htmlBody}</div>`
    : data.htmlBody;

  const outcome = await sendAndPersist(env, db, personalAccountId, entitlements, {
    accountId: original.accountId,
    to: data.to,
    cc: data.cc,
    subject,
    textBody,
    htmlBody,
    idempotencyKey: data.idempotencyKey,
  });

  return { ...outcome, forwardedFrom: originalMessageId };
}
