/**
 * A sent request's lifecycle: void, reminders (by hand and on schedule), a new
 * link for one signer, a corrected email, expiry, the activity list, and a
 * member's own "sign now" link. Permission and ownership checks happen in the
 * routes; the sweep (cron/lifecycle-sweep.ts) runs the scheduled parts.
 *
 * Everything that mails a link goes through `mailNewLinks`, so the outbound
 * guard counts it and a refusal changes nothing. Voiding and expiry revoke
 * every link of the request at once.
 */

import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SignEnvelope, SignRecipient } from '@weldsuite/db/schema';
import type { CorrectSignRecipientInput, SignEventDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { SignError, invalid, notFound } from './errors';
import { recordSignEvent } from './events';
import { isOpenRequest } from './envelopes';
import { createLink, revokeEnvelopeLinks, revokeRecipientLinks, signingLink } from './links';
import { sendExpired, sendVoided, type MailContext } from './mail';
import { allSigned, isCurrentSigner, nextReminderAt, openRequests, scheduleLifecycle } from './schedule';
import { EMAIL_LIMIT_MESSAGE, mailNewLinks, type Actor, type SendContext } from './sending';

const { signEnvelopes, signRecipients, signEvents } = schema;

/** Someone emailed (a link or a reminder) this recently is not reminded again by hand. */
export const MANUAL_REMIND_GAP_MS = 60 * 60 * 1000;

const closed = () => new SignError('conflict', 'This request is no longer open');

function mailContext(ctx: SendContext, envelope: SignEnvelope): MailContext {
  return { env: ctx.env, db: ctx.db, clerkOrgId: ctx.clerkOrgId, envelope, master: ctx.master };
}

async function recipientsOf(db: Database, envelopeId: string): Promise<SignRecipient[]> {
  return db
    .select()
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, envelopeId))
    .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt));
}

/** The request's recipients, or a conflict when it no longer collects signatures. */
async function openRecipients(db: Database, envelope: SignEnvelope): Promise<SignRecipient[]> {
  if (!isOpenRequest(envelope)) throw closed();
  const recipients = await recipientsOf(db, envelope.id);
  if (allSigned(recipients.filter((r) => r.role === 'signer'))) {
    throw new SignError('conflict', 'Everyone has signed; the signed document is being prepared');
  }
  return recipients;
}

const actorFields = (actor: Actor | null) => ({
  actorUserId: actor?.userId ?? null,
  actorName: actor?.name ?? null,
  actorEmail: actor?.email ?? null,
});

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

/** Stop an open request: its links stop at once, and signers who got it hear why. */
export async function voidRequest(ctx: SendContext, envelope: SignEnvelope, actor: Actor, reason: string): Promise<SignEnvelope> {
  const recipients = await openRecipients(ctx.db, envelope);
  const now = new Date();
  const [voided] = await ctx.db
    .update(signEnvelopes)
    .set({ status: 'voided', voidedAt: now, voidedReason: reason, updatedAt: now })
    .where(and(eq(signEnvelopes.id, envelope.id), inArray(signEnvelopes.status, ['sent', 'in_progress'])))
    .returning();
  if (!voided) throw closed();
  await revokeEnvelopeLinks(ctx.master, ctx.workspaceId, envelope.id);
  await recordSignEvent(ctx.db, { envelopeId: envelope.id, type: 'voided', ...actorFields(actor), details: { reason } });
  // Signers still waiting for their turn never heard of the request.
  const told = recipients.filter((r) => r.role === 'signer' && r.status !== 'pending');
  await sendVoided(mailContext(ctx, voided), told, reason);
  return voided;
}

// ---------------------------------------------------------------------------
// Reminders and new links
// ---------------------------------------------------------------------------

async function markReminded(db: Database, ids: string[], at: Date, automatic: boolean): Promise<void> {
  await db
    .update(signRecipients)
    .set({ lastRemindedAt: at, updatedAt: at, ...(automatic ? { remindersSent: sql`${signRecipients.remindersSent} + 1` } : {}) })
    .where(inArray(signRecipients.id, ids));
}

/** Remind every signer whose turn it is and who was not emailed in the last hour. Returns how many. */
export async function remindNow(ctx: SendContext, envelope: SignEnvelope, actor: Actor): Promise<number> {
  const recipients = await openRecipients(ctx.db, envelope);
  const cutoff = Date.now() - MANUAL_REMIND_GAP_MS;
  const due = recipients.filter((r) => isCurrentSigner(r) && (r.lastRemindedAt ?? r.sentAt ?? new Date(0)).getTime() <= cutoff);
  if (due.length === 0) throw new SignError('conflict', 'Everyone whose turn it is was emailed less than an hour ago');
  const mailed = await mailNewLinks(ctx, envelope, due, { reminder: true });
  if (mailed === 'refused') throw invalid(EMAIL_LIMIT_MESSAGE);
  await markReminded(ctx.db, due.map((r) => r.id), new Date(), false);
  for (const r of due) {
    await recordSignEvent(ctx.db, {
      envelopeId: envelope.id,
      recipientId: r.id,
      type: 'reminded',
      ...actorFields(actor),
      details: { email: r.email, automatic: false, delivered: mailed.sent.includes(r.email ?? '') },
    });
  }
  return due.length;
}

/** Email one signer whose turn it is a new link (their earlier links keep working). */
export async function resendLink(ctx: SendContext, envelope: SignEnvelope, recipientId: string, actor: Actor): Promise<SignRecipient> {
  const recipients = await openRecipients(ctx.db, envelope);
  const recipient = recipients.find((r) => r.id === recipientId);
  if (!recipient) throw notFound('Recipient', recipientId);
  if (!isCurrentSigner(recipient)) throw new SignError('conflict', 'Only a signer whose turn it is can get a new link');
  const mailed = await mailNewLinks(ctx, envelope, [recipient]);
  if (mailed === 'refused') throw invalid(EMAIL_LIMIT_MESSAGE);
  const now = new Date();
  const [row] = await ctx.db
    .update(signRecipients)
    .set({ lastRemindedAt: now, updatedAt: now })
    .where(eq(signRecipients.id, recipient.id))
    .returning();
  await recordSignEvent(ctx.db, {
    envelopeId: envelope.id,
    recipientId: recipient.id,
    type: 'resent',
    ...actorFields(actor),
    details: { email: recipient.email, delivered: mailed.sent.includes(recipient.email ?? '') },
  });
  return row!;
}

/**
 * Fix a recipient's name or email. A new email revokes their old links; a
 * signer whose turn it is gets a new link at the new address first (so a
 * refusal by the outbound guard changes nothing) and starts over: not
 * opened, no reminders yet, and consent asked again.
 */
export async function correctRecipient(
  ctx: SendContext,
  envelope: SignEnvelope,
  recipientId: string,
  input: CorrectSignRecipientInput,
  actor: Actor,
): Promise<SignRecipient> {
  const recipients = await openRecipients(ctx.db, envelope);
  const recipient = recipients.find((r) => r.id === recipientId);
  if (!recipient) throw notFound('Recipient', recipientId);
  if (recipient.status === 'signed' || recipient.status === 'declined') {
    throw new SignError('conflict', 'A recipient who has signed or declined cannot be changed');
  }
  const name = input.name ?? recipient.name;
  const email = input.email;
  const emailChanged = email !== recipient.email;
  if (!emailChanged && name === recipient.name) throw invalid('Nothing changed');
  if (emailChanged && recipients.some((r) => r.id !== recipient.id && r.email === email)) {
    throw invalid(`${email} is already a recipient of this envelope`);
  }

  const restart = emailChanged && isCurrentSigner(recipient);
  let keep: string | undefined;
  if (restart) {
    const mailed = await mailNewLinks(ctx, envelope, [{ ...recipient, name, email }]);
    if (mailed === 'refused') throw invalid(EMAIL_LIMIT_MESSAGE);
    keep = mailed.tokens.get(recipient.id);
  }
  if (emailChanged) {
    await revokeRecipientLinks(ctx.master, { workspaceId: ctx.workspaceId, envelopeId: envelope.id, recipientId: recipient.id }, keep);
  }
  const now = new Date();
  const [row] = await ctx.db
    .update(signRecipients)
    .set({
      name,
      email,
      ...(restart ? { status: 'sent' as const, sentAt: now, openedAt: null, lastRemindedAt: null, remindersSent: 0 } : {}),
      updatedAt: now,
    })
    .where(eq(signRecipients.id, recipient.id))
    .returning();
  await recordSignEvent(ctx.db, {
    envelopeId: envelope.id,
    recipientId: recipient.id,
    type: 'recipient_corrected',
    ...actorFields(actor),
    details: { from: recipient.email, to: email, fromName: recipient.name, toName: name, newLink: restart },
  });
  if (restart) await scheduleLifecycle(ctx.env, ctx.db, ctx.clerkOrgId);
  return row!;
}

/** A fresh link for a member whose turn it is to sign (by their email), for "Sign now". */
export async function memberSigningLink(ctx: SendContext, envelope: SignEnvelope, email: string | null): Promise<string> {
  const notYourTurn = new SignError('conflict', 'It is not your turn to sign this request');
  if (!email || !isOpenRequest(envelope)) throw notYourTurn;
  const [recipient] = await ctx.db
    .select()
    .from(signRecipients)
    .where(
      and(
        eq(signRecipients.envelopeId, envelope.id),
        eq(signRecipients.email, email),
        eq(signRecipients.role, 'signer'),
        inArray(signRecipients.status, ['sent', 'opened']),
      ),
    )
    .limit(1);
  if (!recipient) throw notYourTurn;
  const token = await createLink(ctx.master, {
    workspaceId: ctx.workspaceId,
    clerkOrgId: ctx.clerkOrgId,
    envelopeId: envelope.id,
    recipientId: recipient.id,
    expiresAt: envelope.expiresAt,
  });
  return signingLink(ctx.env.SIGN_PORTAL_URL, token);
}

// ---------------------------------------------------------------------------
// Scheduled: expiry and automatic reminders
// ---------------------------------------------------------------------------

/**
 * Close open requests whose expiry has passed: status `expired`, every link
 * revoked, the sender told who had not signed. A request where everyone
 * signed is left to finalizing.
 */
export async function expireDue(ctx: SendContext, now: Date): Promise<SignEnvelope[]> {
  const due = await ctx.db
    .select()
    .from(signEnvelopes)
    .where(
      and(
        eq(signEnvelopes.kind, 'envelope'),
        inArray(signEnvelopes.status, ['sent', 'in_progress']),
        isNull(signEnvelopes.deletedAt),
        lte(signEnvelopes.expiresAt, now),
      ),
    );
  const expired: SignEnvelope[] = [];
  for (const envelope of due) {
    const signers = (await recipientsOf(ctx.db, envelope.id)).filter((r) => r.role === 'signer');
    if (allSigned(signers)) continue;
    const [row] = await ctx.db
      .update(signEnvelopes)
      .set({ status: 'expired', updatedAt: now })
      .where(and(eq(signEnvelopes.id, envelope.id), inArray(signEnvelopes.status, ['sent', 'in_progress'])))
      .returning();
    if (!row) continue;
    await revokeEnvelopeLinks(ctx.master, ctx.workspaceId, envelope.id);
    await recordSignEvent(ctx.db, { envelopeId: envelope.id, type: 'expired', details: { expiresAt: envelope.expiresAt?.toISOString() ?? null } });
    const unsigned = signers.filter((s) => s.status !== 'signed').map((s) => s.name || s.email || '');
    await sendExpired(mailContext(ctx, row), unsigned.filter(Boolean));
    expired.push(row);
  }
  return expired;
}

/** Send the automatic reminders that are due. Returns how many signers were reminded. */
export async function sendDueReminders(ctx: SendContext, now: Date): Promise<number> {
  let reminded = 0;
  for (const { envelope, signers } of await openRequests(ctx.db)) {
    if (!isOpenRequest(envelope, now) || allSigned(signers)) continue;
    const due = signers.filter((s) => {
      const at = nextReminderAt(envelope, s);
      return at !== null && at.getTime() <= now.getTime();
    });
    if (due.length === 0) continue;
    const mailed = await mailNewLinks(ctx, envelope, due, { reminder: true });
    if (mailed === 'refused') {
      // Try again a full interval later rather than on every tick; it does not count.
      console.warn(`[sign-api] reminders for ${envelope.id} refused by the outbound guard`);
      await markReminded(ctx.db, due.map((s) => s.id), now, false);
      continue;
    }
    await markReminded(ctx.db, due.map((s) => s.id), now, true);
    for (const s of due) {
      await recordSignEvent(ctx.db, {
        envelopeId: envelope.id,
        recipientId: s.id,
        type: 'reminded',
        details: { email: s.email, automatic: true, delivered: mailed.sent.includes(s.email ?? '') },
      });
    }
    reminded += due.length;
  }
  return reminded;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/** The request's evidence trail, oldest first, with recipient names for display. */
export async function listEvents(db: Database, envelopeId: string): Promise<SignEventDto[]> {
  const [events, recipients] = await Promise.all([
    db.select().from(signEvents).where(eq(signEvents.envelopeId, envelopeId)).orderBy(asc(signEvents.createdAt), asc(signEvents.id)),
    recipientsOf(db, envelopeId),
  ]);
  const names = new Map(recipients.map((r) => [r.id, r.name || r.email]));
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    recipientId: e.recipientId,
    recipientName: e.recipientId ? (names.get(e.recipientId) ?? null) : null,
    actorName: e.actorName,
    actorEmail: e.actorEmail,
    ip: e.ip,
    createdAt: e.createdAt.toISOString(),
    details: e.details,
  }));
}
