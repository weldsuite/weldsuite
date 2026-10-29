/**
 * Inbound thread resolution for the Postgres mailbox store (design task B4,
 * docs/plans/weldmail-mailbox-store-design.md §2.1 / §9).
 *
 * Ported from mail-inbound-worker's `email-storage.ts` (`isTenantDuplicate`,
 * `findThreadByReplyIds`, `findThreadBySubject`, `resolveTenantThread`) so the
 * same logic is reachable through `MailboxStore.resolveInbound` without one
 * worker importing another's folder. mail-inbound-worker keeps its own copies
 * for now — wiring it to call through the store instead is a later task (D4).
 *
 * Also hosts the message-identification reads `MailboxStore` needs for the
 * sent/scheduled paths (`findByRfcIds`, `findSentByIdempotencyKey`,
 * `countSentSince`), ported the same way from `../../send.ts`: new code here,
 * `send.ts` itself is untouched (task D1 wires it up later).
 */

import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { InboundThreadQuery } from '../types';
import {
  bareSubject,
  conversationSubjects,
  hasReplyPrefix,
  involvesAddress,
  messageIdVariants,
  providerMessageIds,
} from '../thread-match';

const { mailMessages } = schema;

interface ThreadMatch {
  threadId: string;
  isExistingHamThread: boolean;
}

/** First reference (the conversation root), else `inReplyTo`, else the message's own id — ported from `computeThreadId`. */
function computeThreadId(q: Pick<InboundThreadQuery, 'rfcMessageId' | 'inReplyTo' | 'references'>): string {
  return q.references?.[0] || q.inReplyTo || q.rfcMessageId;
}

/** Both Message-ID spellings (`id@host` / `<id@host>`) of `inReplyTo` and every reference. */
function replyLookupIds(q: InboundThreadQuery): string[] {
  return messageIdVariants([...(q.inReplyTo ? [q.inReplyTo] : []), ...(q.references ?? [])]);
}

/** Find the thread of a reply by the stored Message-ID or the provider message id. Ported from `findThreadByReplyIds`. */
async function findThreadByReplyIds(
  db: Database,
  accountId: string,
  q: InboundThreadQuery,
): Promise<ThreadMatch | null> {
  const lookupIds = replyLookupIds(q);
  if (lookupIds.length === 0) return null;
  const providerIds = providerMessageIds(lookupIds);

  const [existing] = await db
    .select({ threadId: mailMessages.threadId, isSpam: mailMessages.isSpam })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        or(
          inArray(mailMessages.messageId, lookupIds),
          inArray(mailMessages.externalMessageId, lookupIds),
          inArray(mailMessages.mailcowMessageId, providerIds),
        )!,
      ),
    )
    .limit(1);
  if (!existing?.threadId) return null;
  return { threadId: existing.threadId, isExistingHamThread: existing.isSpam === false };
}

/**
 * Fallback: match by subject when the Message-ID lookup fails. Ported from
 * `findThreadBySubject`; `requireParticipant` guards the "reply without
 * headers" path so two strangers' "Re: Hello" never merge.
 */
async function findThreadBySubject(
  db: Database,
  accountId: string,
  q: InboundThreadQuery,
  opts: { requireParticipant: boolean } = { requireParticipant: false },
): Promise<ThreadMatch | null> {
  const subjects = conversationSubjects(q.subject);
  if (subjects.length === 0) return null;

  const candidates = await db
    .select({
      threadId: mailMessages.threadId,
      isSpam: mailMessages.isSpam,
      from: mailMessages.from,
      to: mailMessages.to,
      cc: mailMessages.cc,
    })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        inArray(sql`lower(${mailMessages.subject})`, subjects),
        isNull(mailMessages.deletedAt),
      ),
    )
    .orderBy(desc(mailMessages.sentDate))
    .limit(20);

  const match = candidates.find(
    (c) => c.threadId && (!opts.requireParticipant || involvesAddress(c, q.fromEmail ?? undefined)),
  );
  if (!match?.threadId) return null;
  return { threadId: match.threadId, isExistingHamThread: match.isSpam === false };
}

export interface ResolveInboundResult {
  duplicate: boolean;
  threadId: string;
  isExistingHamThread: boolean;
}

/**
 * Resolve the thread a new inbound message belongs to, and whether it is a
 * duplicate of one already stored (by RFC Message-ID, within this account).
 * Ported verbatim from `resolveTenantThread` + `isTenantDuplicate`
 * (`MailboxStore.resolveInbound`).
 */
export async function resolveInbound(
  db: Database,
  accountId: string,
  q: InboundThreadQuery,
): Promise<ResolveInboundResult> {
  if (q.rfcMessageId) {
    const [existing] = await db
      .select({ id: mailMessages.id, threadId: mailMessages.threadId })
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.messageId, q.rfcMessageId)))
      .limit(1);
    if (existing) {
      return { duplicate: true, threadId: existing.threadId ?? existing.id, isExistingHamThread: false };
    }
  }

  // No threading headers. A "Re: ..." from a sender that never set them
  // still belongs to the conversation it answers, when we hold it and the
  // sender took part in it.
  if (!q.isReply) {
    if (hasReplyPrefix(q.subject) && bareSubject(q.subject)) {
      const bySubject = await findThreadBySubject(db, accountId, q, { requireParticipant: true });
      if (bySubject) return { duplicate: false, ...bySubject };
    }
    return { duplicate: false, threadId: q.rfcMessageId, isExistingHamThread: false };
  }

  const byIds = await findThreadByReplyIds(db, accountId, q);
  if (byIds) return { duplicate: false, ...byIds };

  const bySubject = await findThreadBySubject(db, accountId, q);
  if (bySubject) return { duplicate: false, ...bySubject };

  return { duplicate: false, threadId: computeThreadId(q), isExistingHamThread: false };
}

/** Messages matching any of the RFC Message-IDs or provider/external ids — de-dup lookups for the send/ingest paths. */
export async function findByRfcIds(
  db: Database,
  accountId: string,
  rfcIds: string[],
  providerIds: string[],
): Promise<Array<{ id: string; threadId: string | null; source: string | null }>> {
  if (rfcIds.length === 0 && providerIds.length === 0) return [];
  const conditions = [];
  if (rfcIds.length > 0) conditions.push(inArray(mailMessages.messageId, rfcIds));
  if (providerIds.length > 0) {
    conditions.push(inArray(mailMessages.externalMessageId, providerIds));
    conditions.push(inArray(mailMessages.providerMessageId, providerIds));
  }
  return db
    .select({ id: mailMessages.id, threadId: mailMessages.threadId, source: mailMessages.source })
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), or(...conditions)!));
}

/**
 * Rebuild a sent message's identity from its client idempotency key, so a
 * replayed send returns the original outcome without re-transmitting. Ported
 * from `send.ts`'s `findSentByIdempotencyKey`.
 */
export async function findSentByIdempotencyKey(
  db: Database,
  accountId: string,
  idempotencyKey: string,
): Promise<{ id: string; rfcMessageId: string; externalMessageId: string | null; subject: string | null } | null> {
  const [existing] = await db
    .select({
      id: mailMessages.id,
      rfcMessageId: mailMessages.messageId,
      externalMessageId: mailMessages.externalMessageId,
      subject: mailMessages.subject,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.idempotencyKey, idempotencyKey)))
    .limit(1);
  return existing ?? null;
}

/**
 * Messages the account sent since `since`, deleted ones included — the
 * store's generalisation of `send.ts`'s UTC-day `countSentToday`.
 */
export async function countSentSince(db: Database, accountId: string, since: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        eq(mailMessages.source, 'sent'),
        or(isNull(mailMessages.sendStatus), eq(mailMessages.sendStatus, 'sent'))!,
        gte(mailMessages.sentDate, new Date(since)),
      ),
    );
  return Number(row?.count ?? 0);
}
