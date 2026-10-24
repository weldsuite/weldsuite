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
import type { Env } from '../types';
import { invalid, notADraft } from './errors';
import { recordSignEvent } from './events';
import { createLink, revokeEnvelopeLinks, signingLink } from './links';
import { sendRequests, type MailContext } from './mail';
import { loadSignSettings } from './settings';

const { signEnvelopes, signRecipients, signDocuments, signFields } = schema;

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

/** Create links for `group`, email them, and mark them sent. `'refused'` when the outbound guard said no. */
async function emailGroup(ctx: SendContext, envelope: SignEnvelope, group: SignRecipient[], actor: Actor | null): Promise<'refused' | 'ok'> {
  if (group.length === 0) return 'ok';
  const links = await Promise.all(
    group.map(async (recipient) => ({
      recipient,
      url: signingLink(
        ctx.env.SIGN_PORTAL_URL,
        await createLink(ctx.master, {
          workspaceId: ctx.workspaceId,
          clerkOrgId: ctx.clerkOrgId,
          envelopeId: envelope.id,
          recipientId: recipient.id,
          expiresAt: envelope.expiresAt,
        }),
      ),
    })),
  );
  const mail: MailContext = { env: ctx.env, db: ctx.db, clerkOrgId: ctx.clerkOrgId, envelope, master: ctx.master };
  const result = await sendRequests(mail, links);
  if (result === 'refused') return 'refused';

  const now = new Date();
  await ctx.db
    .update(signRecipients)
    .set({ status: 'sent', sentAt: now, updatedAt: now })
    .where(inArray(signRecipients.id, group.map((r) => r.id)));
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

/**
 * Send a draft. Checks it is complete, sets its expiry, and emails the first
 * signing group. A refusal by the outbound guard changes nothing.
 */
export async function sendEnvelope(ctx: SendContext, draft: SignEnvelope, actor: Actor, expiresAt?: string | null): Promise<SignEnvelope> {
  if (draft.status !== 'draft') throw notADraft();
  const problem = await sendProblem(ctx.db, draft.id);
  if (problem) throw invalid(problem);

  const settings = await loadSignSettings(ctx.db);
  const expiry = expiresAt
    ? new Date(expiresAt)
    : settings.expiryDays
      ? new Date(Date.now() + settings.expiryDays * 86_400_000)
      : null;
  if (expiry && expiry.getTime() <= Date.now()) throw invalid('The expiry date must be in the future');

  const recipients = await ctx.db
    .select()
    .from(signRecipients)
    .where(eq(signRecipients.envelopeId, draft.id))
    .orderBy(asc(signRecipients.routingOrder), asc(signRecipients.createdAt));
  const envelope: SignEnvelope = { ...draft, expiresAt: expiry };
  const outcome = await emailGroup(ctx, envelope, nextGroup(envelope, recipients), actor);
  if (outcome === 'refused') {
    await revokeEnvelopeLinks(ctx.master, ctx.workspaceId, draft.id);
    throw invalid("The workspace's email limits do not allow sending this request right now. Try again later or contact WeldSuite support.");
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
  return sent!;
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
  const group = nextGroup(envelope, recipients);
  // Later groups go out best effort: the request is already in flight.
  const outcome = await emailGroup(ctx, envelope, group, null);
  if (outcome === 'refused') {
    console.warn(`[sign-api] next signing group of ${envelope.id} refused by the outbound guard`);
    return 'waiting';
  }
  return 'next_group';
}
