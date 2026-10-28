/**
 * Sending a request and moving it from one signing group to the next.
 *
 * Without a signing order every signer is emailed at once. With one, signers
 * with the lowest `routing_order` still pending go first; when the last of a
 * group signs, the next group is emailed (`advanceAfterSigning`). Copy
 * recipients get nothing until everyone has signed.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { SignEnvelope, SignRecipient } from '@weldsuite/db/schema';
import type { SignEnv as Env } from './env';
import { invalid, notADraft } from './errors';
import { recordSignEvent } from './events';
import { createLink, revokeTokens, signingLink } from './links';
import { sendRequests, type MailContext } from './mail';
import { scheduleLifecycle } from './schedule';
import { loadSignSettings } from './settings';
import { MeterLimitError, meterUsage, releaseMeterUsage } from '@weldsuite/credits/meters';

const { signEnvelopes, signRecipients, signDocuments, signFields } = schema;

/** Why a request, reminder or new link did not go out. */
export const EMAIL_LIMIT_MESSAGE =
  "The workspace's email limits do not allow sending this right now. Try again later or contact WeldSuite support.";

export interface WorkspaceRef {
  /** Clerk org id (tenant DB, events). */
  clerkOrgId: string;
  /** Master `workspaces.id` (link registry). */
  workspaceId: string;
}

export interface SendContext extends WorkspaceRef {
  env: Env;
  db: Database;
  master: MasterDatabase;
}

export interface Actor {
  userId: string | null;
  name: string | null;
  email: string | null;
}

/** Everything a request needs before it can go out; the first problem found, or null. */
export async function sendProblem(db: Database, envelopeId: string): Promise<string | null> {
  const [docs, recipients, fields] = await Promise.all([
    db.select({ id: signDocuments.id }).from(signDocuments).where(eq(signDocuments.envelopeId, envelopeId)),
    db.select().from(signRecipients).where(eq(signRecipients.envelopeId, envelopeId)),
    db.select({ recipientId: signFields.recipientId, type: signFields.type }).from(signFields).where(eq(signFields.envelopeId, envelopeId)),
  ]);
  if (docs.length === 0) return 'Add at least one document';
  const signers = recipients.filter((r) => r.role === 'signer');
  if (signers.length === 0) return 'Add at least one signer';
  for (const r of recipients) if (!r.email) return 'Every recipient needs an email address';
  for (const s of signers) {
    if (!fields.some((f) => f.recipientId === s.id && f.type === 'signature')) return `${s.name || s.email} has no signature field`;
  }
  return null;
}

/** Signers to email now: the lowest pending routing group, or every pending signer without an order. */
export function nextGroup(envelope: Pick<SignEnvelope, 'signingOrderEnabled'>, recipients: SignRecipient[]): SignRecipient[] {
  const pending = recipients.filter((r) => r.role === 'signer' && r.status === 'pending');
  if (!envelope.signingOrderEnabled || pending.length === 0) return pending;
  const first = Math.min(...pending.map((r) => r.routingOrder));
  return pending.filter((r) => r.routingOrder === first);
}

export interface MailedLinks {
  /** Addresses the mail went out to. */
  sent: string[];
  /** The new link token per recipient id. */
  tokens: Map<string, string>;
}

/**
 * Create a fresh link for each recipient and email it: a signing request, or
 * a reminder. `'refused'` when the outbound guard said no; the new links are
 * taken back then, so nothing changed.
 */
export async function mailNewLinks(
  ctx: SendContext,
  envelope: SignEnvelope,
  recipients: Pick<SignRecipient, 'id' | 'name' | 'email' | 'locale'>[],
  opts: { reminder?: boolean } = {},
): Promise<'refused' | MailedLinks> {
  const tokens = new Map<string, string>();
  for (const recipient of recipients) {
    tokens.set(
      recipient.id,
      await createLink(ctx.master, {
        workspaceId: ctx.workspaceId,
        clerkOrgId: ctx.clerkOrgId,
        envelopeId: envelope.id,
        recipientId: recipient.id,
        expiresAt: envelope.expiresAt,
      }),
    );
  }
  const mail: MailContext = { env: ctx.env, db: ctx.db, clerkOrgId: ctx.clerkOrgId, envelope, master: ctx.master };
  const result = await sendRequests(
    mail,
    recipients.map((recipient) => ({ recipient, url: signingLink(ctx.env.SIGN_PORTAL_URL, tokens.get(recipient.id)!) })),
    opts,
  );
  if (result === 'refused') {
    await revokeTokens(ctx.master, [...tokens.values()]);
    return 'refused';
  }
  return { sent: result, tokens };
}

/** Create links for `group`, email them, and mark them sent. `'refused'` when the outbound guard said no. */
async function emailGroup(ctx: SendContext, envelope: SignEnvelope, group: SignRecipient[], actor: Actor | null): Promise<'refused' | 'ok'> {
  if (group.length === 0) return 'ok';
  const mailed = await mailNewLinks(ctx, envelope, group);
  if (mailed === 'refused') return 'refused';
  const result = mailed.sent;

  const now = new Date();
  await ctx.db
    .update(signRecipients)
    .set({ status: 'sent', sentAt: now, updatedAt: now })
    // Not over a signer who already opened the link (or signed) while the mail went out.
    .where(and(inArray(signRecipients.id, group.map((r) => r.id)), inArray(signRecipients.status, ['pending', 'sent'])));
  for (const r of group) {
    await recordSignEvent(ctx.db, {
      envelopeId: envelope.id,
      recipientId: r.id,
      type: 'sent',
      actorUserId: actor?.userId ?? null,
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
      details: { email: r.email, delivered: result.includes(r.email ?? '') },
    });
  }
  return 'ok';
}

/** The date the sender picked, else the workspace default (days from now), else none. */
function expiryDate(picked: string | null | undefined, defaultDays: number | null | undefined): Date | null {
  if (picked) return new Date(picked);
  return defaultDays ? new Date(Date.now() + defaultDays * 86_400_000) : null;
}

/**
 * Send a draft. Checks it is complete, sets its expiry, counts it against the
 * plan's monthly allowance (`MeterLimitError` when that refuses), and emails
 * the first signing group. A refusal by the outbound guard changes nothing.
 */
export async function sendEnvelope(ctx: SendContext, draft: SignEnvelope, actor: Actor, expiresAt?: string | null): Promise<SignEnvelope> {
  if (draft.status !== 'draft') throw notADraft();
  const problem = await sendProblem(ctx.db, draft.id);
  if (problem) throw invalid(problem);

  const expiry = expiryDate(expiresAt, (await loadSignSettings(ctx.db)).expiryDays);
  if (expiry && expiry.getTime() <= Date.now()) throw invalid('The expiry date must be in the future');

  const recipients = await ctx.db
    .select()
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, draft.id))
    .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt));
  const envelope: SignEnvelope = { ...draft, expiresAt: expiry };

  // A request counts against the plan's monthly allowance; past it the wallet
  // pays, or it is refused. Handed back when it does not go out after all.
  const metered = await meterUsage(ctx.master, {
    workspaceId: ctx.workspaceId,
    meter: 'sign_requests',
    referenceId: draft.id,
    referenceType: 'sign_envelope',
    userId: actor.userId ?? undefined,
  });
  if (!metered.allowed) throw new MeterLimitError(metered);
  let outcome: 'refused' | 'ok';
  try {
    outcome = await emailGroup(ctx, envelope, nextGroup(envelope, recipients), actor);
  } catch (err) {
    await releaseMeterUsage(ctx.master, metered.reservation);
    throw err;
  }
  if (outcome === 'refused') {
    await releaseMeterUsage(ctx.master, metered.reservation);
    throw invalid(EMAIL_LIMIT_MESSAGE);
  }

  const now = new Date();
  const [sent] = await ctx.db
    .update(signEnvelopes)
    .set({ status: 'sent', sentAt: now, expiresAt: expiry, updatedAt: now })
    .where(and(eq(signEnvelopes.id, draft.id), eq(signEnvelopes.status, 'draft')))
    .returning();
  await recordSignEvent(ctx.db, {
    envelopeId: draft.id,
    type: 'sent',
    actorUserId: actor.userId,
    actorName: actor.name,
    actorEmail: actor.email,
    details: { expiresAt: expiry?.toISOString() ?? null, signingOrder: draft.signingOrderEnabled },
  });
  await scheduleLifecycle(ctx.env, ctx.db, ctx.clerkOrgId);
  return sent!;
}

/** Mark `group` sent, only where it is still pending; the rows this call flipped are its to mail. */
async function claimGroup(db: Database, group: SignRecipient[]): Promise<SignRecipient[]> {
  if (group.length === 0) return [];
  const now = new Date();
  return db
    .update(signRecipients)
    .set({ status: 'sent', sentAt: now, updatedAt: now })
    .where(and(inArray(signRecipients.id, group.map((r) => r.id)), eq(signRecipients.status, 'pending')))
    .returning();
}

/** Undo `claimGroup` when the group could not be mailed, so the next signature tries again. */
async function releaseGroup(db: Database, group: SignRecipient[]): Promise<void> {
  if (group.length === 0) return;
  await db
    .update(signRecipients)
    .set({ status: 'pending', sentAt: null, updatedAt: new Date() })
    .where(and(inArray(signRecipients.id, group.map((r) => r.id)), eq(signRecipients.status, 'sent')));
}

/**
 * After a signature: email the next signing group, or report that every
 * signer is done (the caller then finalizes the request).
 */
export async function advanceAfterSigning(ctx: SendContext, envelope: SignEnvelope): Promise<'waiting' | 'next_group' | 'all_signed'> {
  const recipients = await ctx.db
    .select()
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, envelope.id))
    .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt));
  const signers = recipients.filter((r) => r.role === 'signer');
  if (signers.every((r) => r.status === 'signed')) return 'all_signed';
  // Someone already emailed has not signed yet: their group is still open.
  if (signers.some((r) => r.status === 'sent' || r.status === 'opened')) return 'waiting';
  const next = nextGroup(envelope, recipients);
  // Two signers of a group finishing together both get here: only the call that
  // flips the group from pending to sent mails it, the other has nothing to do.
  const group = await claimGroup(ctx.db, next);
  if (group.length < next.length) {
    await releaseGroup(ctx.db, group);
    return 'waiting';
  }
  // Later groups go out best effort: the request is already in flight.
  let outcome: 'refused' | 'ok';
  try {
    outcome = await emailGroup(ctx, envelope, group, null);
  } catch (err) {
    await releaseGroup(ctx.db, group);
    throw err;
  }
  if (outcome === 'refused') {
    await releaseGroup(ctx.db, group);
    console.warn(`[sign-api] next signing group of ${envelope.id} refused by the outbound guard`);
    return 'waiting';
  }
  // The new group's reminders join the schedule.
  await scheduleLifecycle(ctx.env, ctx.db, ctx.clerkOrgId);
  return 'next_group';
}

/**
 * Every signer has signed but the request is not completed: finalizing has
 * not finished, or never started (the caller may start it again; the
 * Workflow's steps are idempotent).
 */
export async function awaitingFinalize(db: Database, envelope: SignEnvelope): Promise<boolean> {
  if (envelope.status !== 'sent' && envelope.status !== 'in_progress') return false;
  const signers = await db
    .select({ status: signRecipients.status })
    .from(signRecipients)
    .where(and(eq(signRecipients.envelopeId, envelope.id), eq(signRecipients.role, 'signer')));
  return signers.length > 0 && signers.every((r) => r.status === 'signed');
}
