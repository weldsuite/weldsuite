/**
 * Cloudflare Email Sending events (`message.delivered | deferred | bounced |
 * complained | rejected | failed`), delivered through a Queues event
 * subscription per sending domain, applied to the sender's workspace:
 *
 * - the ledger counts them (bounce and complaint rates drive the risk score);
 * - the matching SENT copy gets its `deliveryStatus`;
 * - hard bounces and complaints become suppressions.
 *
 * Cloudflare's event `messageId` is its own id, not the RFC Message-ID the
 * binding path generates, so the SENT copy is matched by account, recipient and
 * time (the latest copy to that recipient in the 3 days before the event).
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import type { MailDeliveryStatus } from '@weldsuite/db/schema/mail-messages';
import { addSuppression } from './correspondents';
import { ledgerKeyFor, type DeliveryEventType, type LedgerSubject } from './ledger-core';
import type { OutboundLedger } from './ledger';

export interface DeliveryEventsEnv extends DbEnv {
  OUTBOUND_LEDGER?: DurableObjectNamespace<OutboundLedger>;
}

export interface ParsedSendingEvent {
  type: DeliveryEventType;
  sender: string;
  recipient: string;
  at: Date;
  /** SMTP response or bounce/complaint type, at most 500 characters. */
  detail: string | null;
}

interface RawSendingEvent {
  type?: unknown;
  payload?: {
    sender?: unknown;
    recipient?: unknown;
    delivery?: { status?: unknown; smtpResponse?: unknown; smtpEnhancedStatusCode?: unknown } | null;
    bounce?: { type?: unknown } | null;
    complaint?: { type?: unknown } | null;
  } | null;
  metadata?: { eventTimestamp?: unknown } | null;
}

const PREFIX = 'cf.email.sending.message.';

/** Parse one queue message body; null for anything that isn't an Email Sending event we use. */
export function parseSendingEvent(body: unknown): ParsedSendingEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const event = body as RawSendingEvent;
  if (typeof event.type !== 'string' || !event.type.startsWith(PREFIX)) return null;
  const payload = event.payload ?? {};
  const sender = typeof payload.sender === 'string' ? payload.sender.trim().toLowerCase() : '';
  const recipient = typeof payload.recipient === 'string' ? payload.recipient.trim().toLowerCase() : '';
  if (!sender.includes('@') || !recipient.includes('@')) return null;

  let type: DeliveryEventType;
  switch (event.type.slice(PREFIX.length)) {
    case 'delivered':
      type = 'delivered';
      break;
    case 'deferred':
      type = 'deferred';
      break;
    case 'bounced':
      type = payload.bounce?.type === 'soft' ? 'soft_bounce' : 'hard_bounce';
      break;
    case 'complained':
      type = 'complained';
      break;
    case 'rejected':
      type = 'rejected';
      break;
    case 'failed':
      type = 'failed';
      break;
    default:
      return null;
  }

  const timestamp = typeof event.metadata?.eventTimestamp === 'string' ? Date.parse(event.metadata.eventTimestamp) : NaN;
  const smtp = payload.delivery?.smtpResponse;
  const detail =
    typeof smtp === 'string' && smtp
      ? smtp
      : type === 'complained' && typeof payload.complaint?.type === 'string'
        ? `complaint: ${payload.complaint.type}`
        : null;
  return {
    type,
    sender,
    recipient,
    at: Number.isNaN(timestamp) ? new Date() : new Date(timestamp),
    detail: detail ? detail.slice(0, 500) : null,
  };
}

const STATUS_FOR: Record<DeliveryEventType, MailDeliveryStatus> = {
  delivered: 'delivered',
  deferred: 'deferred',
  hard_bounce: 'bounced',
  soft_bounce: 'bounced',
  complained: 'complained',
  rejected: 'rejected',
  failed: 'failed',
};

/** A later event may only replace an equal or weaker status (a complaint beats a delivery). */
const STATUS_RANK: Record<MailDeliveryStatus, number> = {
  deferred: 0,
  delivered: 1,
  failed: 2,
  rejected: 2,
  bounced: 3,
  complained: 4,
};

/** Set the delivery status on the latest SENT copy from this account to this recipient. */
export async function markSentCopy(db: Database, accountId: string, event: ParsedSendingEvent): Promise<boolean> {
  const { mailMessages } = schema;
  const recipientMatch = sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      COALESCE(CASE WHEN jsonb_typeof(${mailMessages.to}) = 'array' THEN ${mailMessages.to} END, '[]'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(${mailMessages.cc}) = 'array' THEN ${mailMessages.cc} END, '[]'::jsonb)
      || COALESCE(CASE WHEN jsonb_typeof(${mailMessages.bcc}) = 'array' THEN ${mailMessages.bcc} END, '[]'::jsonb)
    ) AS r WHERE lower(r->>'email') = ${event.recipient}
  )`;
  const [row] = await db
    .select({ id: mailMessages.id, deliveryStatus: mailMessages.deliveryStatus })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.accountId, accountId),
        eq(mailMessages.source, 'sent'),
        gte(mailMessages.sentDate, new Date(event.at.getTime() - 3 * 86_400_000)),
        lte(mailMessages.sentDate, new Date(event.at.getTime() + 3_600_000)),
        recipientMatch,
      ),
    )
    .orderBy(desc(mailMessages.sentDate))
    .limit(1);
  if (!row) return false;
  const next = STATUS_FOR[event.type];
  if (row.deliveryStatus && STATUS_RANK[row.deliveryStatus] > STATUS_RANK[next]) return false;
  await db
    .update(mailMessages)
    .set({ deliveryStatus: next, deliveryUpdatedAt: event.at, deliveryDetail: event.detail })
    .where(eq(mailMessages.id, row.id));
  return true;
}

interface SenderRoute {
  subject: LedgerSubject;
  accountId: string;
  clerkOrgId: string | null;
}

async function resolveSender(env: DeliveryEventsEnv, sender: string): Promise<SenderRoute | null> {
  const db = getMasterDb(env);
  const { mailAccountRegistry, workspaces } = masterSchema;
  const [row] = await db
    .select({
      workspaceId: mailAccountRegistry.workspaceId,
      personalAccountId: mailAccountRegistry.personalAccountId,
      accountId: mailAccountRegistry.accountId,
      clerkOrgId: workspaces.clerkOrgId,
    })
    .from(mailAccountRegistry)
    .leftJoin(workspaces, eq(workspaces.id, mailAccountRegistry.workspaceId))
    .where(eq(mailAccountRegistry.email, sender))
    .limit(1);
  if (!row) return null;
  if (row.workspaceId) {
    return {
      subject: { kind: 'workspace', workspaceId: row.workspaceId, clerkOrgId: row.clerkOrgId },
      accountId: row.accountId,
      clerkOrgId: row.clerkOrgId,
    };
  }
  if (row.personalAccountId) {
    // The plan only matters for limits, which this path doesn't apply.
    return {
      subject: { kind: 'personal', personalAccountId: row.personalAccountId, plan: 'free' },
      accountId: row.accountId,
      clerkOrgId: null,
    };
  }
  return null;
}

/**
 * Apply a batch of parsed events. Events from an unknown sender (system mail,
 * a deleted mailbox) are skipped. Throws only on infrastructure failure, so
 * the queue retries the batch.
 */
export async function applySendingEvents(env: DeliveryEventsEnv, events: ParsedSendingEvent[]): Promise<number> {
  const bySender = new Map<string, ParsedSendingEvent[]>();
  for (const event of events) bySender.set(event.sender, [...(bySender.get(event.sender) ?? []), event]);

  let applied = 0;
  for (const [sender, senderEvents] of bySender) {
    const route = await resolveSender(env, sender);
    if (!route) continue;

    if (env.OUTBOUND_LEDGER) {
      const stub = env.OUTBOUND_LEDGER.get(env.OUTBOUND_LEDGER.idFromName(ledgerKeyFor(route.subject)));
      for (const event of senderEvents) await stub.recordDelivery(route.subject, event.type, event.at.getTime());
    }

    if (route.subject.kind === 'workspace' && route.clerkOrgId) {
      const db = await getTenantDbForWorkspace(env, route.clerkOrgId);
      for (const event of senderEvents) {
        try {
          await markSentCopy(db, route.accountId, event);
          if (event.type === 'hard_bounce' || event.type === 'complained') {
            await addSuppression(db, {
              email: event.recipient,
              reason: event.type === 'complained' ? 'complaint' : 'hard_bounce',
              senderEmail: sender,
              source: 'cloudflare_event',
              details: event.detail ? { detail: event.detail } : undefined,
            });
          }
        } catch (err) {
          // A tenant that hasn't run the migration yet: the ledger still counted it.
          console.warn('[outbound-events] tenant update failed:', err instanceof Error ? err.message : err);
        }
      }
    }
    applied += senderEvents.length;
  }
  return applied;
}
