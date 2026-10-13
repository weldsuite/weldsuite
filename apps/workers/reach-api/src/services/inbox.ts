/**
 * The unified reply inbox: threads, one thread's messages, answering,
 * labelling and read/handled state.
 *
 * A thread is every `reach_messages` row sharing a `thread_key` (the root
 * Message-ID of the conversation we started). The inbox lists threads that
 * have at least one inbound message, summarised by their LATEST inbound
 * message; read and handled state are judged on that message, so a new reply
 * reopens a thread that was handled.
 *
 * Messages that need no person (bounces, auto-replies) are stored already read
 * and handled (`handled_by = 'system'`), so the default "open" view shows only
 * what a person has to look at; filter by `kind` or state `all` to see them.
 */

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import type {
  ReachInboxFilter,
  ReachMessage as ReachMessageDto,
  ReachReplyLabel,
  ReachThreadSummary,
  UpdateReachMessageInput,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaigns,
  reachMailboxes,
  reachMessages,
  reachProspects,
  type ReachCampaign,
  type ReachMailbox,
  type ReachMessage,
  type ReachProspect,
} from '@weldsuite/db/schema';
import { extractMessageText } from '../lib/inbound/mime';
import { replySubject, stripQuotedHistory } from '../lib/inbound/text';
import type { Env } from '../types';
import { applyLabelEffects } from './reply-effects';
import { sendFromMailbox, type OutboundDeps, type SendFromMailboxResult } from './outbound';
import { loadSuppressionIndex } from './suppressions';

export const DEFAULT_PAGE_SIZE = 25;
/** Inbound bodies fetched from R2 per thread view. */
const MAX_BODIES = 30;
/** Message-IDs kept in the `References` header of an answer. */
const MAX_REFERENCES = 20;

const m = reachMessages;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toMessageDto(row: ReachMessage, bodyText: string | null = row.bodyText): ReachMessageDto {
  return {
    id: row.id,
    direction: row.direction,
    campaignId: row.campaignId,
    stepId: row.stepId,
    mailboxId: row.mailboxId,
    prospectId: row.prospectId,
    threadKey: row.threadKey,
    fromEmail: row.fromEmail,
    toEmail: row.toEmail,
    subject: row.subject,
    snippet: row.snippet,
    bodyText,
    status: row.status,
    kind: row.kind,
    label: row.label,
    labelSource: row.labelSource,
    readAt: iso(row.readAt),
    handledAt: iso(row.handledAt),
    sentAt: iso(row.sentAt),
    receivedAt: iso(row.receivedAt),
  };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/** The latest inbound message of every thread, as a subquery the filters run on. */
function latestInbound(db: Database) {
  return db
    .selectDistinctOn([m.threadKey], {
      id: m.id,
      threadKey: m.threadKey,
      receivedAt: m.receivedAt,
      kind: m.kind,
      label: m.label,
      readAt: m.readAt,
      handledAt: m.handledAt,
      campaignId: m.campaignId,
      mailboxId: m.mailboxId,
    })
    .from(m)
    .where(and(eq(m.direction, 'in'), isNotNull(m.threadKey)))
    .orderBy(m.threadKey, desc(m.receivedAt), desc(m.id))
    .as('latest_inbound');
}

type Latest = ReturnType<typeof latestInbound>;

/** `<received-at ms>_<message id>`: ids contain underscores, so only the first one separates. */
export function encodeCursor(receivedAt: Date, id: string): string {
  return `${receivedAt.getTime()}_${id}`;
}

export function decodeCursor(cursor: string | undefined): { receivedAt: Date; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf('_');
  if (at <= 0) return null;
  const ms = Number(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  return Number.isFinite(ms) && id !== '' ? { receivedAt: new Date(ms), id } : null;
}

function filterConditions(latest: Latest, filter: ReachInboxFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.label) conditions.push(eq(latest.label, filter.label));
  if (filter.kind) conditions.push(eq(latest.kind, filter.kind));
  if (filter.campaignId) conditions.push(eq(latest.campaignId, filter.campaignId));
  if (filter.mailboxId) conditions.push(eq(latest.mailboxId, filter.mailboxId));
  switch (filter.state ?? 'open') {
    case 'unread':
      conditions.push(isNull(latest.readAt));
      break;
    case 'open':
      conditions.push(isNull(latest.handledAt));
      break;
    case 'handled':
      conditions.push(isNotNull(latest.handledAt));
      break;
    case 'all':
      break;
  }
  return conditions;
}

type ProspectSummary = NonNullable<ReachThreadSummary['prospect']>;

function toProspectSummary(row: ReachProspect): ProspectSummary {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    companyName: row.companyName,
    personId: row.personId,
  };
}

/** Summaries for the given latest-inbound message rows, with prospect, campaign, mailbox and message count. */
async function summarize(db: Database, latestRows: ReachMessage[]): Promise<ReachThreadSummary[]> {
  if (latestRows.length === 0) return [];
  const threadKeys = latestRows.map((r) => r.threadKey).filter((k): k is string => k !== null);
  const prospectIds = [...new Set(latestRows.map((r) => r.prospectId).filter((v): v is string => v !== null))];
  const campaignIds = [...new Set(latestRows.map((r) => r.campaignId).filter((v): v is string => v !== null))];
  const mailboxIds = [...new Set(latestRows.map((r) => r.mailboxId))];

  const [counts, prospects, campaigns, mailboxes] = await Promise.all([
    db.select({ threadKey: m.threadKey, n: count() }).from(m).where(inArray(m.threadKey, threadKeys)).groupBy(m.threadKey),
    prospectIds.length > 0 ? db.select().from(reachProspects).where(inArray(reachProspects.id, prospectIds)) : Promise.resolve([]),
    campaignIds.length > 0
      ? db.select({ id: reachCampaigns.id, name: reachCampaigns.name }).from(reachCampaigns).where(inArray(reachCampaigns.id, campaignIds))
      : Promise.resolve([]),
    db.select({ id: reachMailboxes.id, email: reachMailboxes.email }).from(reachMailboxes).where(inArray(reachMailboxes.id, mailboxIds)),
  ]);

  const countByThread = new Map(counts.map((c) => [c.threadKey, Number(c.n)]));
  const prospectById = new Map(prospects.map((p) => [p.id, p]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const mailboxById = new Map(mailboxes.map((b) => [b.id, b]));

  return latestRows.map((row): ReachThreadSummary => {
    const prospect = row.prospectId ? prospectById.get(row.prospectId) : undefined;
    const campaign = row.campaignId ? campaignById.get(row.campaignId) : undefined;
    const mailbox = mailboxById.get(row.mailboxId);
    return {
      threadKey: row.threadKey ?? row.messageIdHeader,
      prospect: prospect ? toProspectSummary(prospect) : null,
      campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
      mailbox: { id: row.mailboxId, email: mailbox?.email ?? row.toEmail },
      lastInbound: {
        id: row.id,
        subject: row.subject,
        snippet: row.snippet,
        kind: row.kind ?? 'reply',
        label: row.label,
        labelSource: row.labelSource,
        receivedAt: iso(row.receivedAt),
        readAt: iso(row.readAt),
        handledAt: iso(row.handledAt),
      },
      messageCount: countByThread.get(row.threadKey) ?? 1,
    };
  });
}

export interface ThreadPage {
  threads: ReachThreadSummary[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export async function listThreads(db: Database, filter: ReachInboxFilter): Promise<ThreadPage> {
  const limit = filter.limit ?? DEFAULT_PAGE_SIZE;
  const latest = latestInbound(db);
  const conditions = filterConditions(latest, filter);

  const cursor = decodeCursor(filter.cursor);
  const pageConditions = cursor
    ? [
        ...conditions,
        or(lt(latest.receivedAt, cursor.receivedAt), and(eq(latest.receivedAt, cursor.receivedAt), lt(latest.id, cursor.id)))!,
      ]
    : conditions;

  const [rows, totals] = await Promise.all([
    db
      .select({ id: latest.id, receivedAt: latest.receivedAt })
      .from(latest)
      .where(and(...pageConditions))
      .orderBy(desc(latest.receivedAt), desc(latest.id))
      .limit(limit + 1),
    db
      .select({ n: count() })
      .from(latest)
      .where(and(...conditions)),
  ]);

  const hasMore = rows.length > limit;
  const pageIds = rows.slice(0, limit).map((r) => r.id);
  const messages = pageIds.length > 0 ? await db.select().from(m).where(inArray(m.id, pageIds)) : [];
  const byId = new Map(messages.map((row) => [row.id, row]));
  const ordered = pageIds.map((id) => byId.get(id)).filter((row): row is ReachMessage => !!row);

  const last = ordered[ordered.length - 1];
  return {
    threads: await summarize(db, ordered),
    totalCount: Number(totals[0]?.n ?? 0),
    hasMore,
    cursor: hasMore && last?.receivedAt ? encodeCursor(last.receivedAt, last.id) : null,
  };
}

/** Threads whose latest inbound message has not been read. */
export async function countUnreadThreads(db: Database): Promise<number> {
  const latest = latestInbound(db);
  const [row] = await db.select({ n: count() }).from(latest).where(isNull(latest.readAt));
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// One thread
// ---------------------------------------------------------------------------

export interface ThreadContext {
  threadKey: string;
  /** Every message of the thread, oldest first. */
  messages: ReachMessage[];
  latestInbound: ReachMessage;
  prospect: ReachProspect | null;
  campaign: ReachCampaign | null;
  mailbox: ReachMailbox | null;
}

/** The thread, or null when it has no inbound message (it is not an inbox thread). */
export async function loadThread(db: Database, threadKey: string): Promise<ThreadContext | null> {
  const messages = await db
    .select()
    .from(m)
    .where(eq(m.threadKey, threadKey))
    .orderBy(asc(sql`coalesce(${m.sentAt}, ${m.receivedAt}, ${m.createdAt})`), asc(m.createdAt), asc(m.id));
  const inbound = messages.filter((row) => row.direction === 'in');
  const latest = inbound[inbound.length - 1];
  if (!latest) return null;

  const [prospect, campaign, mailbox] = await Promise.all([
    latest.prospectId
      ? db.select().from(reachProspects).where(eq(reachProspects.id, latest.prospectId)).limit(1)
      : Promise.resolve([]),
    latest.campaignId ? db.select().from(reachCampaigns).where(eq(reachCampaigns.id, latest.campaignId)).limit(1) : Promise.resolve([]),
    db.select().from(reachMailboxes).where(eq(reachMailboxes.id, latest.mailboxId)).limit(1),
  ]);
  return { threadKey, messages, latestInbound: latest, prospect: prospect[0] ?? null, campaign: campaign[0] ?? null, mailbox: mailbox[0] ?? null };
}

/** The reply text of one stored inbound message: from its raw copy in R2, else the stored snippet. */
async function inboundBody(env: Pick<Env, 'STORAGE'>, row: ReachMessage): Promise<string | null> {
  if (!row.r2Key || !env.STORAGE) return row.snippet;
  try {
    const object = await env.STORAGE.get(row.r2Key);
    if (!object) return row.snippet;
    const text = stripQuotedHistory(await extractMessageText(new Uint8Array(await object.arrayBuffer())));
    return text === '' ? row.snippet : text;
  } catch (err) {
    console.error('[reach-inbox] reading a stored message failed:', err instanceof Error ? err.message : err);
    return row.snippet;
  }
}

export async function getThread(
  db: Database,
  env: Pick<Env, 'STORAGE'>,
  threadKey: string,
): Promise<{ summary: ReachThreadSummary; messages: ReachMessageDto[] } | null> {
  const thread = await loadThread(db, threadKey);
  if (!thread) return null;

  const [summary] = await summarize(db, [thread.latestInbound]);
  if (!summary) return null;

  // R2 reads for the most recent inbound messages only; older ones show their snippet.
  const inboundIds = thread.messages.filter((row) => row.direction === 'in').slice(-MAX_BODIES).map((row) => row.id);
  const bodies = new Map<string, string | null>(
    await Promise.all(
      thread.messages
        .filter((row) => inboundIds.includes(row.id))
        .map(async (row): Promise<[string, string | null]> => [row.id, await inboundBody(env, row)]),
    ),
  );

  return {
    summary,
    messages: thread.messages.map((row) => (row.direction === 'in' ? toMessageDto(row, bodies.get(row.id) ?? row.snippet) : toMessageDto(row))),
  };
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export type ReplyFailure =
  | { ok: false; code: 'NOT_FOUND'; message: string }
  | { ok: false; code: 'NO_REPLY'; message: string }
  | { ok: false; code: 'SUPPRESSED'; message: string }
  | { ok: false; code: 'SEND_FAILED'; message: string };

export type ReplyResult = { ok: true; message: ReachMessage } | ReplyFailure;

export interface ReplyDeps extends OutboundDeps {
  /** Replaced in tests. */
  send?: (deps: OutboundDeps, input: Parameters<typeof sendFromMailbox>[1]) => Promise<SendFromMailboxResult>;
}

/** The Message-IDs to put in `References`: the thread's own chain, newest last, capped. */
export function referenceChain(messages: ReachMessage[]): string[] {
  const ids: string[] = [];
  for (const row of messages) if (!ids.includes(row.messageIdHeader)) ids.push(row.messageIdHeader);
  return ids.slice(-MAX_REFERENCES);
}

function recipientName(prospect: ReachProspect | null, email: string): string | undefined {
  if (!prospect || prospect.email !== email) return undefined;
  const name = [prospect.firstName, prospect.lastName].filter(Boolean).join(' ');
  return name === '' ? undefined : name;
}

/**
 * Send an answer to the latest reply of a thread, from the mailbox that
 * received it, threaded under it. Marks the thread's inbound messages read.
 */
export async function replyToThread(
  deps: ReplyDeps,
  input: { threadKey: string; body: string; userId: string },
): Promise<ReplyResult> {
  const { db } = deps;
  const thread = await loadThread(db, input.threadKey);
  if (!thread) return { ok: false, code: 'NOT_FOUND', message: 'Thread not found' };

  // Answer the latest person-written reply; bounces and auto-replies have nobody to answer.
  const answered = [...thread.messages].reverse().find((row) => row.direction === 'in' && row.kind === 'reply');
  if (!answered) return { ok: false, code: 'NO_REPLY', message: 'This thread has no reply to answer' };

  const to = answered.fromEmail.toLowerCase();
  const suppression = (await loadSuppressionIndex(db, [to])).check(to);
  if (suppression) {
    return { ok: false, code: 'SUPPRESSED', message: 'This address is on the suppression list; it cannot be emailed' };
  }

  const send = deps.send ?? sendFromMailbox;
  let result: SendFromMailboxResult;
  try {
    result = await send(deps, {
      mailboxId: answered.mailboxId,
      to: { email: to, name: recipientName(thread.prospect, to) },
      subject: replySubject(answered.subject ?? thread.messages.find((row) => row.subject)?.subject),
      text: input.body,
      appendFooter: false,
      inReplyTo: answered.messageIdHeader,
      references: referenceChain(thread.messages),
      threadKey: thread.threadKey,
      campaignId: answered.campaignId,
      enrollmentId: answered.enrollmentId,
      prospectId: answered.prospectId,
      sentBy: input.userId,
    });
  } catch (err) {
    console.error('[reach-inbox] reply send threw:', err instanceof Error ? err.message : err);
    return { ok: false, code: 'SEND_FAILED', message: 'The email could not be sent' };
  }
  if (!result.ok) return { ok: false, code: 'SEND_FAILED', message: result.error };

  await db
    .update(m)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(and(eq(m.threadKey, thread.threadKey), eq(m.direction, 'in'), isNull(m.readAt)));
  return { ok: true, message: result.message };
}

// ---------------------------------------------------------------------------
// Labels, read and handled
// ---------------------------------------------------------------------------

export interface MessageUpdate {
  message: ReachMessage;
  /** Set when the label changed; the route publishes `reach_reply:classified` for it. */
  labelChange: { previous: ReachReplyLabel | null; next: ReachReplyLabel } | null;
}

type MessagePatch = Partial<typeof reachMessages.$inferInsert>;

/** The columns a person's read / handled choice changes. */
function stateColumns(existing: ReachMessage, input: UpdateReachMessageInput, userId: string, now: Date): MessagePatch {
  const patch: MessagePatch = {};
  if (input.handled === true) {
    patch.handledAt = existing.handledAt ?? now;
    patch.handledBy = existing.handledAt ? existing.handledBy : userId;
    // Handled implies seen.
    patch.readAt = existing.readAt ?? now;
  } else if (input.handled === false) {
    patch.handledAt = null;
    patch.handledBy = null;
  }
  if (input.read === true) patch.readAt = existing.readAt ?? now;
  else if (input.read === false && input.handled !== true) patch.readAt = null;
  return patch;
}

/** The label columns when the person actually changes the label; null when nothing changes. */
function labelColumns(existing: ReachMessage, input: UpdateReachMessageInput, now: Date): { patch: MessagePatch; change: NonNullable<MessageUpdate['labelChange']> } | null {
  if (input.label === undefined || input.label === existing.label) return null;
  return {
    patch: { label: input.label, labelSource: 'user', classifiedAt: now },
    change: { previous: existing.label, next: input.label },
  };
}

/** Reading a reply means the replies before it in the thread were seen too. */
async function markEarlierRepliesRead(db: Database, existing: ReachMessage, now: Date): Promise<void> {
  if (!existing.threadKey || !existing.receivedAt) return;
  await db
    .update(m)
    .set({ readAt: now, updatedAt: now })
    .where(and(eq(m.threadKey, existing.threadKey), eq(m.direction, 'in'), isNull(m.readAt), lt(m.receivedAt, existing.receivedAt)));
}

async function applyUserLabel(db: Database, message: ReachMessage, change: NonNullable<MessageUpdate['labelChange']>): Promise<void> {
  const [prospect] = message.prospectId
    ? await db
        .select({ id: reachProspects.id, email: reachProspects.email, companyDomain: reachProspects.companyDomain })
        .from(reachProspects)
        .where(eq(reachProspects.id, message.prospectId))
        .limit(1)
    : [];
  await applyLabelEffects(
    db,
    {
      messageId: message.id,
      senderEmail: message.fromEmail,
      prospect: prospect ?? null,
      enrollmentId: message.enrollmentId,
      campaignId: message.campaignId,
      previousLabel: change.previous,
    },
    change.next,
  );
}

/**
 * Apply a person's change to one inbound message. A label chosen by a person
 * is final (the AI never overwrites it) and has the same effects as one chosen
 * by the model: `unsubscribe` suppresses the address and ends the sequence.
 * Marking a message read also marks the earlier inbound messages of its thread.
 */
export async function updateMessage(
  db: Database,
  id: string,
  input: UpdateReachMessageInput,
  userId: string,
): Promise<MessageUpdate | null> {
  const [existing] = await db.select().from(m).where(and(eq(m.id, id), eq(m.direction, 'in'))).limit(1);
  if (!existing) return null;

  const now = new Date();
  const label = labelColumns(existing, input, now);
  const patch: MessagePatch = { updatedAt: now, ...stateColumns(existing, input, userId, now), ...label?.patch };
  const [updated] = await db.update(m).set(patch).where(eq(m.id, id)).returning();
  if (!updated) return null;

  if (input.read === true) await markEarlierRepliesRead(db, existing, now);
  if (label) await applyUserLabel(db, updated, label.change);
  return { message: updated, labelChange: label?.change ?? null };
}
