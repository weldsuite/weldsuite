/**
 * Tenant-DB helpers for the outbound guard: who wrote to the workspace before
 * (first contact or not), and who must not be mailed again (suppressions).
 */

import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MailSuppressionReason } from '@weldsuite/db/schema/mail-correspondents';

const { mailCorrespondents, mailSuppressions } = schema;

const CHUNK = 100;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** The addresses (lower-cased) that ever wrote to the workspace. */
export async function findKnownCorrespondents(db: Database, emails: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (const batch of chunks(emails)) {
    const rows = await db
      .select({ email: mailCorrespondents.email })
      .from(mailCorrespondents)
      .where(and(inArray(mailCorrespondents.email, batch), isNotNull(mailCorrespondents.firstInboundAt)));
    for (const row of rows) known.add(row.email);
  }
  return known;
}

/** Record that the workspace wrote to these addresses (every send path). */
export async function recordOutboundCorrespondents(db: Database, emails: string[], at = new Date()): Promise<void> {
  for (const batch of chunks(emails)) {
    await db
      .insert(mailCorrespondents)
      .values(batch.map((email) => ({ email, firstOutboundAt: at, lastOutboundAt: at, outboundCount: 1, updatedAt: at })))
      .onConflictDoUpdate({
        target: mailCorrespondents.email,
        set: {
          firstOutboundAt: sql`COALESCE(${mailCorrespondents.firstOutboundAt}, excluded.first_outbound_at)`,
          lastOutboundAt: sql`excluded.last_outbound_at`,
          outboundCount: sql`${mailCorrespondents.outboundCount} + 1`,
          updatedAt: at,
        },
      });
  }
}

export interface SuppressedRecipient {
  email: string;
  reason: MailSuppressionReason;
}

export async function findSuppressed(db: Database, emails: string[]): Promise<SuppressedRecipient[]> {
  const found: SuppressedRecipient[] = [];
  for (const batch of chunks(emails)) {
    const rows = await db
      .select({ email: mailSuppressions.email, reason: mailSuppressions.reason })
      .from(mailSuppressions)
      .where(inArray(mailSuppressions.email, batch));
    found.push(...rows);
  }
  return found;
}

const REASON_RANK: Record<MailSuppressionReason, number> = { hard_bounce: 1, manual: 2, complaint: 3 };

/** Add or strengthen a suppression; a complaint is never downgraded to a bounce. */
export async function addSuppression(
  db: Database,
  input: {
    email: string;
    reason: MailSuppressionReason;
    senderEmail?: string | null;
    source: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const now = new Date();
  await db
    .insert(mailSuppressions)
    .values({
      id: generateId('msup'),
      email,
      reason: input.reason,
      senderEmail: input.senderEmail ?? null,
      source: input.source,
      details: input.details ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: mailSuppressions.email,
      set: {
        reason: sql`CASE WHEN ${REASON_RANK[input.reason]} >= (CASE ${mailSuppressions.reason} WHEN 'complaint' THEN 3 WHEN 'manual' THEN 2 ELSE 1 END) THEN excluded.reason ELSE ${mailSuppressions.reason} END`,
        senderEmail: sql`COALESCE(excluded.sender_email, ${mailSuppressions.senderEmail})`,
        details: sql`COALESCE(excluded.details, ${mailSuppressions.details})`,
        updatedAt: now,
      },
    });
}
