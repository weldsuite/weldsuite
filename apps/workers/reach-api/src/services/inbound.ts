/**
 * Processing one inbound message of a WeldReach mailbox.
 *
 * Each Mailpool mailbox forwards its incoming mail to
 * `reply+<token>@reply.weldreach.com`; `email/handler.ts` resolves the token to a
 * workspace and mailbox and hands the raw message here. In order:
 *
 *   1. parse, de-duplicate on Message-ID, ignore mail from our own mailboxes;
 *   2. decide the kind: `bounce`, `auto_reply` or `reply`;
 *   3. match it to what we sent (In-Reply-To / References / the original
 *      Message-ID of a bounce, else the sender or failed recipient against the
 *      prospects with an enrollment on this mailbox);
 *   4. store the raw message in R2 and a `reach_messages` row;
 *   5. apply the effects: stop the sequence, suppress, move the counters;
 *   6. publish `reach_reply:received`, hand a human reply to the CRM and, for a
 *      reply, classify it with AI in the background.
 *
 * Steps 1-5 are the part that must not be lost: they throw on a database
 * failure (the handler then parks the raw message for replay) and are safe to
 * run twice. Step 6 is best effort.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  reachCampaigns,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  reachProspects,
  type ReachCampaign,
  type ReachEnrollment,
  type ReachInboundKind,
  type ReachMessage,
  type ReachProspect,
  type ReachReplyLabel,
} from '@weldsuite/db/schema';
import { parseInbound } from '../lib/inbound/mime';
import { classifyInbound } from '../lib/inbound/kind';
import { looksLikeBulk } from '../lib/inbound/auto-reply';
import { isUnsubscribeRequest } from '../lib/inbound/intent';
import { syntheticMessageId } from '../lib/inbound/message-id';
import { makeSnippet, stripQuotedHistory } from '../lib/inbound/text';
import type { BounceInfo, ParsedInbound } from '../lib/inbound/types';
import type { Env } from '../types';
import { completeCampaignIfDone } from './campaigns';
import { classifyStoredReply, type ClassifyReplyFn } from './classify';
import { handOffReplyToCrm, resolveCrmOwner } from './crm-handoff';
import { recordHardBounce } from './guardrails';
import { createRawEntitySink, publishReplyClassified, publishReplyReceived, type EntitySink } from './realtime';
import {
  LIVE,
  applyUnsubscribe,
  bumpCampaignStat,
  flagProspectsSuppressed,
  readStopScope,
  stopOtherEnrollments,
  suppressAddress,
  transitionEnrollment,
} from './reply-effects';

export interface InboundMailbox {
  id: string;
  email: string;
}

export interface DeliverInboundInput {
  env: Env;
  db: Database;
  /** Clerk org id of the workspace (opens nothing here; used for R2 keys, AI metering and events). */
  clerkOrgId: string;
  mailbox: InboundMailbox;
  raw: Uint8Array;
  /** `raw` already parsed (the handler parses it once to screen out warmup mail); parsed here when absent. */
  parsed?: ParsedInbound;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => Date;
  /** Injected in tests; defaults to the metered model call. */
  classify?: ClassifyReplyFn;
  /** Injected in tests; defaults to the entity-events hub queue. */
  sink?: EntitySink;
}

export type DeliverInboundResult =
  | {
      status: 'stored';
      messageId: string;
      kind: ReachInboundKind;
      matched: boolean;
      threadKey: string;
      label: ReachReplyLabel | null;
    }
  | { status: 'duplicate'; messageIdHeader: string }
  | { status: 'ignored'; reason: 'own_mailbox' };

export interface InboundMatch {
  /** The stored message the incoming one answers (or reports on). */
  message: ReachMessage | null;
  enrollment: ReachEnrollment | null;
  prospect: ReachProspect | null;
  campaign: ReachCampaign | null;
  /** `header`: In-Reply-To / References / DSN original id; `sender`: address fallback; `none`. */
  how: 'header' | 'sender' | 'none';
}

const MAX_SUBJECT = 500;
const MAX_EMAIL = 320;

export function r2KeyFor(clerkOrgId: string, messageRowId: string): string {
  return `reach/${clerkOrgId}/${messageRowId}.eml`;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Message-IDs that can identify what this message answers, most specific first. */
export function candidateMessageIds(parsed: ParsedInbound, bounce: BounceInfo | null): string[] {
  const ids: string[] = [];
  if (bounce?.originalMessageId) ids.push(bounce.originalMessageId);
  if (parsed.inReplyTo) ids.push(parsed.inReplyTo);
  // References run oldest to newest; the newest is the closest answer.
  ids.push(...[...parsed.references].reverse());
  return [...new Set(ids)];
}

async function findStoredMessage(db: Database, ids: string[]): Promise<ReachMessage | null> {
  if (ids.length === 0) return null;
  const rows = await db.select().from(reachMessages).where(inArray(reachMessages.messageIdHeader, ids));
  for (const id of ids) {
    const hit = rows.find((row) => row.messageIdHeader === id);
    if (hit) return hit;
  }
  return null;
}

async function findProspectById(db: Database, id: string | null): Promise<ReachProspect | null> {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(reachProspects)
    .where(and(eq(reachProspects.id, id), isNull(reachProspects.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function findProspectByEmail(db: Database, emails: string[]): Promise<ReachProspect | null> {
  if (emails.length === 0) return null;
  const rows = await db
    .select()
    .from(reachProspects)
    .where(and(inArray(reachProspects.email, emails), isNull(reachProspects.deletedAt)));
  for (const email of emails) {
    const hit = rows.find((row) => row.email === email);
    if (hit) return hit;
  }
  return null;
}

async function findEnrollmentById(db: Database, id: string | null): Promise<ReachEnrollment | null> {
  if (!id) return null;
  const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, id)).limit(1);
  return row ?? null;
}

async function findEnrollmentOnMailbox(db: Database, prospectId: string, mailboxId: string): Promise<ReachEnrollment | null> {
  const [row] = await db
    .select()
    .from(reachEnrollments)
    .where(and(eq(reachEnrollments.prospectId, prospectId), eq(reachEnrollments.mailboxId, mailboxId)))
    .orderBy(desc(reachEnrollments.updatedAt), desc(reachEnrollments.id))
    .limit(1);
  return row ?? null;
}

async function findCampaign(db: Database, id: string | null | undefined): Promise<ReachCampaign | null> {
  if (!id) return null;
  const [row] = await db.select().from(reachCampaigns).where(eq(reachCampaigns.id, id)).limit(1);
  return row ?? null;
}

/**
 * What this message answers. By header first; when the headers lead nowhere
 * (clients that drop them, a reply typed in a new mail) by the sender, or for a
 * bounce the failed recipient, against the prospects enrolled on this mailbox.
 */
export async function matchInbound(
  db: Database,
  input: { mailboxId: string; parsed: ParsedInbound; bounce: BounceInfo | null; senderEmail: string },
): Promise<InboundMatch> {
  const message = await findStoredMessage(db, candidateMessageIds(input.parsed, input.bounce));
  let enrollment = await findEnrollmentById(db, message?.enrollmentId ?? null);
  let prospect = await findProspectById(db, message?.prospectId ?? enrollment?.prospectId ?? null);
  const headerMatch = message !== null;

  if (!prospect) prospect = await findProspectByEmail(db, addressesToTry(input.bounce, input.senderEmail));
  if (prospect && !enrollment) enrollment = await findEnrollmentOnMailbox(db, prospect.id, input.mailboxId);

  const campaign = await findCampaign(db, enrollment?.campaignId ?? message?.campaignId);
  return { message, enrollment, prospect, campaign, how: howMatched(headerMatch, prospect) };
}

/** Who to look up as the prospect: the failed recipients of a bounce, else the sender. */
function addressesToTry(bounce: BounceInfo | null, senderEmail: string): string[] {
  if (bounce) return bounce.recipients;
  return senderEmail === '' ? [] : [senderEmail];
}

function howMatched(headerMatch: boolean, prospect: ReachProspect | null): InboundMatch['how'] {
  if (headerMatch) return 'header';
  return prospect ? 'sender' : 'none';
}

/** The conversation this message belongs to. */
export function resolveThreadKey(match: InboundMatch, ownMessageId: string): string {
  if (match.message) return match.message.threadKey ?? match.message.messageIdHeader;
  return match.enrollment?.threadRootMessageId ?? ownMessageId;
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

function bounceSnippet(bounce: BounceInfo, text: string): string {
  const target = bounce.recipients[0] ?? 'the recipient';
  const status = bounce.status ? ` (${bounce.status})` : '';
  return makeSnippet(`Delivery to ${target} failed${status}. ${bounce.diagnostic ?? text}`);
}

async function putRaw(env: Env, key: string, raw: Uint8Array): Promise<string | null> {
  if (!env.STORAGE) return null;
  try {
    await env.STORAGE.put(key, raw, { httpMetadata: { contentType: 'message/rfc822' } });
    return key;
  } catch (err) {
    console.error('[reach-inbound] raw message storage failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function messageIdTaken(db: Database, messageIdHeader: string): Promise<boolean> {
  const [row] = await db
    .select({ id: reachMessages.id })
    .from(reachMessages)
    .where(eq(reachMessages.messageIdHeader, messageIdHeader))
    .limit(1);
  return !!row;
}

async function isOwnMailbox(db: Database, email: string): Promise<boolean> {
  if (email === '') return false;
  const [row] = await db.select({ id: reachMailboxes.id }).from(reachMailboxes).where(eq(reachMailboxes.email, email)).limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

interface EffectInput {
  db: Database;
  message: ReachMessage;
  mailbox: InboundMailbox;
  kind: ReachInboundKind;
  match: InboundMatch;
  bounce: BounceInfo | null;
  optOut: boolean;
  senderEmail: string;
}

/** A person answered: end the sequence (or sequences), or honour an opt-out. */
async function applyReplyEffects(input: EffectInput): Promise<void> {
  const { db, match, message } = input;
  if (input.optOut) {
    await applyUnsubscribe(db, {
      messageId: message.id,
      senderEmail: input.senderEmail,
      prospect: match.prospect,
      enrollmentId: match.enrollment?.id ?? null,
      campaignId: match.campaign?.id ?? null,
    });
    return;
  }

  if (match.enrollment) {
    const moved = await transitionEnrollment(db, match.enrollment.id, 'replied', 'replied');
    if (moved) await bumpCampaignStat(db, match.campaign?.id, 'replied');
  }
  if (match.prospect) {
    await stopOtherEnrollments(db, {
      prospectId: match.prospect.id,
      companyDomain: match.prospect.companyDomain,
      scope: await readStopScope(db),
      exceptEnrollmentId: match.enrollment?.id ?? null,
    });
  }
}

/** The addresses a bounce is about: its recipients, else the prospect we sent to. */
function failedAddresses(bounce: BounceInfo, prospect: ReachProspect | null): string[] {
  if (bounce.recipients.length > 0) return bounce.recipients;
  return prospect ? [prospect.email] : [];
}

/** A delivery failure: end the sequence, suppress a bad address, count it against the mailbox and campaign. */
async function applyBounceEffects(input: EffectInput & { bounce: BounceInfo }): Promise<void> {
  const { db, match, bounce, message } = input;
  if (!bounce.permanent) return;

  if (match.enrollment) {
    const moved = await transitionEnrollment(db, match.enrollment.id, 'bounced', `bounced:${bounce.status ?? 'unknown'}`);
    if (moved) await bumpCampaignStat(db, match.campaign?.id, 'bounced');
  }

  if (bounce.addressRejected) {
    const failed = failedAddresses(bounce, match.prospect);
    for (const email of failed) await suppressAddress(db, email, 'bounced', message.id);
    await flagProspectsSuppressed(db, failed);
  }

  // After the enrollment is marked bounced: the guardrail counts bounced enrollments.
  await recordHardBounce(db, { mailboxId: input.mailbox.id, campaignId: match.campaign?.id ?? null });
}

/** An out-of-office or similar: the sequence goes on unless the campaign says to stop on auto-replies. */
async function applyAutoReplyEffects(input: EffectInput): Promise<void> {
  const { db, match } = input;
  if (!match.campaign?.stopOnAutoReply || !match.enrollment) return;
  await transitionEnrollment(db, match.enrollment.id, 'replied', 'auto_reply', LIVE);
}

async function applyEffects(input: EffectInput): Promise<void> {
  if (input.kind === 'bounce' && input.bounce) await applyBounceEffects({ ...input, bounce: input.bounce });
  else if (input.kind === 'auto_reply') await applyAutoReplyEffects(input);
  else await applyReplyEffects(input);
}

/** Complete the campaign if this stop left nothing queued or active; publishes `reach_campaign:completed`. */
async function completeCampaignIfFinished(db: Database, sink: EntitySink, campaignId: string | undefined): Promise<void> {
  if (!campaignId) return;
  try {
    const done = await completeCampaignIfDone(db, campaignId);
    if (done) {
      await sink({
        entityType: 'reach_campaign',
        action: 'completed',
        entityId: done.id,
        data: { id: done.id, name: done.name, status: done.status },
      });
    }
  } catch (err) {
    console.error('[reach-inbound] campaign completion check failed:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Everything decided about a message before anything is written. */
interface Analysis {
  parsed: ParsedInbound;
  messageIdHeader: string;
  senderEmail: string;
  bounce: BounceInfo | null;
  match: InboundMatch;
  kind: ReachInboundKind;
  replyText: string;
  optOut: boolean;
  threadKey: string;
}

type Analyzed = { skip: DeliverInboundResult } | { analysis: Analysis };

/** Newsletters and list mail that answer nothing we sent are noise, not replies. */
function effectiveKind(kind: ReachInboundKind, match: InboundMatch, parsed: ParsedInbound): ReachInboundKind {
  return kind === 'reply' && match.how === 'none' && looksLikeBulk(parsed.headers) ? 'auto_reply' : kind;
}

/** Parse, de-duplicate, classify and match: no writes. */
async function analyze(input: DeliverInboundInput): Promise<Analyzed> {
  const { db, mailbox, raw } = input;
  const parsed = input.parsed ?? (await parseInbound(raw));
  const messageIdHeader = parsed.messageId ?? (await syntheticMessageId(raw));
  if (await messageIdTaken(db, messageIdHeader)) return { skip: { status: 'duplicate', messageIdHeader } };

  const senderEmail = parsed.from?.email ?? '';
  // Mail from our own mailboxes (warmup between them, a loop) is never a reply.
  if (await isOwnMailbox(db, senderEmail)) return { skip: { status: 'ignored', reason: 'own_mailbox' } };

  const classification = classifyInbound(parsed);
  const match = await matchInbound(db, { mailboxId: mailbox.id, parsed, bounce: classification.bounce, senderEmail });
  const kind = effectiveKind(classification.kind, match, parsed);
  const replyText = kind === 'bounce' ? '' : stripQuotedHistory(parsed.text);
  return {
    analysis: {
      parsed,
      messageIdHeader,
      senderEmail,
      bounce: classification.bounce,
      match,
      kind,
      replyText,
      optOut: kind === 'reply' && isUnsubscribeRequest(parsed.subject, replyText),
      threadKey: resolveThreadKey(match, messageIdHeader),
    },
  };
}

/** The columns of the stored message. Notices that need no person (bounces, auto-replies) arrive read and handled. */
function rowValues(input: DeliverInboundInput, a: Analysis, id: string, r2Key: string | null, now: Date): typeof reachMessages.$inferInsert {
  const system = a.kind === 'reply' ? null : { readAt: now, handledAt: now, handledBy: 'system' };
  const rule = a.optOut ? { label: 'unsubscribe' as const, labelSource: 'rule' as const, classifiedAt: now } : null;
  return {
    id,
    direction: 'in',
    campaignId: a.match.campaign?.id ?? a.match.message?.campaignId ?? null,
    enrollmentId: a.match.enrollment?.id ?? null,
    mailboxId: input.mailbox.id,
    prospectId: a.match.prospect?.id ?? null,
    threadKey: a.threadKey.slice(0, 255),
    messageIdHeader: a.messageIdHeader,
    inReplyTo: a.parsed.inReplyTo,
    references: a.parsed.references.length > 0 ? a.parsed.references.join(' ') : null,
    fromEmail: (a.senderEmail || 'unknown').slice(0, MAX_EMAIL),
    toEmail: input.mailbox.email.slice(0, MAX_EMAIL),
    subject: a.parsed.subject === '' ? null : a.parsed.subject.slice(0, MAX_SUBJECT),
    snippet: a.bounce ? bounceSnippet(a.bounce, a.parsed.text) : makeSnippet(a.replyText),
    r2Key,
    kind: a.kind,
    receivedAt: now,
    ...system,
    ...rule,
  };
}

/** Store the raw copy and the row. Null when another delivery of the same message won the race. */
async function storeInbound(input: DeliverInboundInput, a: Analysis, now: Date): Promise<ReachMessage | null> {
  const { env, db, clerkOrgId } = input;
  const id = generateId('rmsg');
  const key = await putRaw(env, r2KeyFor(clerkOrgId, id), input.raw);
  const [stored] = await db
    .insert(reachMessages)
    .values(rowValues(input, a, id, key, now))
    .onConflictDoNothing({ target: reachMessages.messageIdHeader })
    .returning();
  if (!stored && key && env.STORAGE) await env.STORAGE.delete(key).catch(() => undefined);
  return stored ?? null;
}

export async function deliverInbound(input: DeliverInboundInput): Promise<DeliverInboundResult> {
  const { env, db, clerkOrgId, mailbox } = input;
  const now = (input.now ?? (() => new Date()))();
  const sink = input.sink ?? createRawEntitySink(env, clerkOrgId);

  const analyzed = await analyze(input);
  if ('skip' in analyzed) return analyzed.skip;
  const a = analyzed.analysis;

  const stored = await storeInbound(input, a, now);
  // Lost a race with a second delivery of the same message.
  if (!stored) return { status: 'duplicate', messageIdHeader: a.messageIdHeader };

  try {
    await applyEffects({ db, message: stored, mailbox, kind: a.kind, match: a.match, bounce: a.bounce, optOut: a.optOut, senderEmail: a.senderEmail });
  } catch (err) {
    // Not stored means redeliverable: drop the row so a replay is not de-duplicated away.
    await db.delete(reachMessages).where(eq(reachMessages.id, stored.id)).catch(() => undefined);
    throw err;
  }

  await finishInbound({ ...input, sink, message: stored, kind: a.kind, match: a.match, replyText: a.replyText, optOut: a.optOut });
  return {
    status: 'stored',
    messageId: stored.id,
    kind: a.kind,
    matched: a.match.how !== 'none',
    threadKey: a.threadKey,
    label: a.optOut ? 'unsubscribe' : null,
  };
}

interface FinishInput extends DeliverInboundInput {
  sink: EntitySink;
  message: ReachMessage;
  kind: ReachInboundKind;
  match: InboundMatch;
  replyText: string;
  optOut: boolean;
}

/** The best-effort tail: campaign completion, event, CRM hand-off and the AI classification. */
async function finishInbound(input: FinishInput): Promise<void> {
  const { db, sink, message, kind, match } = input;
  await completeCampaignIfFinished(db, sink, match.campaign?.id);
  await publishReplyReceived(sink, message);
  if (input.optOut) await publishReplyClassified(sink, message, 'unsubscribe', 'rule');
  if (kind !== 'reply' || input.optOut) return;

  if (match.prospect) {
    try {
      await handOffReplyToCrm(
        { db, sink, actingUserId: await resolveCrmOwner(db, match.campaign) },
        { prospect: match.prospect, campaign: match.campaign, message },
      );
    } catch (err) {
      console.error('[reach-inbound] CRM hand-off failed:', err instanceof Error ? err.message : err);
    }
  }

  // Only mail that answers something we sent (or comes from a known prospect) is worth the credits:
  // anything else may be spam the mailbox forwarded.
  if (match.how !== 'none') {
    input.waitUntil(
      classifyStoredReply(
        { env: input.env, db, clerkOrgId: input.clerkOrgId, sink, classify: input.classify, now: input.now },
        { ...message, text: input.replyText },
      ),
    );
  }
}
