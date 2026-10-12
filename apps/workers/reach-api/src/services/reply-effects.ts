/**
 * What an inbound message does to the rest of WeldReach: stop the sequence,
 * suppress the address, move the campaign counters.
 *
 * Shared by the `email()` pipeline (replies, bounces, rule-detected opt-outs),
 * the AI classifier and the inbox when a person changes a label, so every path
 * stops a sequence and suppresses an address the same way. All writes are
 * idempotent: a status only changes when the enrollment is still in one of the
 * states the change may start from, and counters move only on that transition,
 * so a redelivered message never counts twice.
 */

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import { generateId } from '@weldsuite/worker-kit/id';
import { isConsumerEmail, type ReachReplyLabel } from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaigns,
  reachEnrollments,
  reachProspects,
  reachSettings,
  reachSuppressions,
  type ReachEnrollmentStatus,
  type ReachSuppressionReason,
} from '@weldsuite/db/schema';

export type CampaignStatKey = 'prospects' | 'sent' | 'replied' | 'interested' | 'bounced' | 'unsubscribed';

/** Enrollment states a stop may start from. `completed`: a late reply or bounce still counts. */
export const STOPPABLE: ReachEnrollmentStatus[] = ['queued', 'active', 'paused', 'completed'];
/** States in which an enrollment can still send something. */
export const LIVE: ReachEnrollmentStatus[] = ['queued', 'active', 'paused'];

const POSITIVE_LABELS = new Set<ReachReplyLabel>(['interested', 'meeting_request']);

export function isPositiveLabel(label: ReachReplyLabel | null | undefined): boolean {
  return !!label && POSITIVE_LABELS.has(label);
}

/** Add `by` to one denormalised campaign counter (never below zero). */
export async function bumpCampaignStat(
  db: Database,
  campaignId: string | null | undefined,
  key: CampaignStatKey,
  by = 1,
): Promise<void> {
  if (!campaignId || by === 0) return;
  // `key` is a closed union of constants, so it is safe to inline.
  const path = sql.raw(`'{${key}}'`);
  const current = sql.raw(`(coalesce(stats->>'${key}', '0'))::int`);
  await db
    .update(reachCampaigns)
    .set({
      stats: sql`jsonb_set(${reachCampaigns.stats}, ${path}, to_jsonb(greatest(0, ${current} + ${by})))`,
      updatedAt: new Date(),
    })
    .where(eq(reachCampaigns.id, campaignId));
}

/**
 * Move one enrollment to a final status if it is still in a state that allows
 * it. True when this call did the move.
 */
export async function transitionEnrollment(
  db: Database,
  enrollmentId: string,
  to: Extract<ReachEnrollmentStatus, 'replied' | 'bounced' | 'unsubscribed'>,
  reason: string,
  from: ReachEnrollmentStatus[] = STOPPABLE,
): Promise<boolean> {
  const rows = await db
    .update(reachEnrollments)
    .set({ status: to, stoppedReason: reason.slice(0, 100), nextSendAt: null, claimedAt: null, updatedAt: new Date() })
    .where(and(eq(reachEnrollments.id, enrollmentId), inArray(reachEnrollments.status, from)))
    .returning({ id: reachEnrollments.id });
  return rows.length > 0;
}

/** `reach_settings.stopOnReplyScope`; `prospect` until settings exist. */
export async function readStopScope(db: Database): Promise<'prospect' | 'company'> {
  const [row] = await db.select({ scope: reachSettings.stopOnReplyScope }).from(reachSettings).limit(1);
  return row?.scope ?? 'prospect';
}

function stoppedReasonFor(status: 'replied' | 'unsubscribed', companyWide: boolean): string {
  if (companyWide) return 'replied_company';
  return status === 'unsubscribed' ? 'unsubscribed' : 'replied_elsewhere';
}

/**
 * Stop the queued/active enrollments next to the one that replied: the same
 * prospect in other campaigns and, with company scope, everyone at the same
 * company domain (never for free-mail domains, where "same domain" means
 * nothing). Returns how many were stopped.
 */
export async function stopOtherEnrollments(
  db: Database,
  input: {
    prospectId: string;
    companyDomain: string | null;
    scope: 'prospect' | 'company';
    exceptEnrollmentId: string | null;
    reason?: 'replied' | 'unsubscribed';
  },
): Promise<number> {
  const status = input.reason === 'unsubscribed' ? 'unsubscribed' : 'replied';
  const domain = input.companyDomain?.toLowerCase() ?? '';
  const companyWide = input.scope === 'company' && domain !== '' && !isConsumerEmail(`x@${domain}`);

  const prospectFilter = companyWide
    ? inArray(
        reachEnrollments.prospectId,
        sql`(select ${reachProspects.id} from ${reachProspects} where ${reachProspects.companyDomain} = ${domain} and ${reachProspects.deletedAt} is null)`,
      )
    : eq(reachEnrollments.prospectId, input.prospectId);

  const rows = await db
    .update(reachEnrollments)
    .set({
      status,
      stoppedReason: stoppedReasonFor(status, companyWide),
      nextSendAt: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        prospectFilter,
        inArray(reachEnrollments.status, LIVE),
        input.exceptEnrollmentId ? ne(reachEnrollments.id, input.exceptEnrollmentId) : undefined,
      ),
    )
    .returning({ id: reachEnrollments.id });
  return rows.length;
}

/** Put one address on the suppression list. Idempotent. */
export async function suppressAddress(
  db: Database,
  email: string,
  reason: ReachSuppressionReason,
  source: string | null,
): Promise<void> {
  const value = email.trim().toLowerCase();
  if (!value.includes('@')) return;
  await db
    .insert(reachSuppressions)
    .values({ id: generateId('rsup'), value, type: 'email', reason, source: source?.slice(0, 255) ?? null, createdBy: null })
    .onConflictDoNothing({ target: reachSuppressions.value });
}

/** Mark prospects `suppressed` (the denormalised flag the prospect list shows). */
export async function flagProspectsSuppressed(db: Database, emails: string[]): Promise<void> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
  if (unique.length === 0) return;
  await db
    .update(reachProspects)
    .set({ validation: 'suppressed', updatedAt: new Date() })
    .where(and(inArray(reachProspects.email, unique), isNull(reachProspects.deletedAt)));
}

export interface UnsubscribeTarget {
  /** The message that carried the opt-out (suppression source). */
  messageId: string;
  /** The address that asked. */
  senderEmail: string;
  prospect: { id: string; email: string; companyDomain: string | null } | null;
  enrollmentId: string | null;
  campaignId: string | null;
}

/**
 * An opt-out: suppress the sender (and the prospect they answered for, when
 * that is another address), mark the prospect, and end every live sequence
 * of the prospect. Counts one `unsubscribed` per enrollment that actually
 * changed.
 */
export async function applyUnsubscribe(db: Database, target: UnsubscribeTarget): Promise<void> {
  const emails = [target.senderEmail];
  if (target.prospect && target.prospect.email !== target.senderEmail) emails.push(target.prospect.email);
  for (const email of emails) await suppressAddress(db, email, 'unsubscribed', target.messageId);
  await flagProspectsSuppressed(db, emails);

  if (target.enrollmentId) {
    const moved = await transitionEnrollment(db, target.enrollmentId, 'unsubscribed', 'unsubscribed', [...STOPPABLE, 'replied']);
    if (moved) await bumpCampaignStat(db, target.campaignId, 'unsubscribed');
  }
  if (target.prospect) {
    await stopOtherEnrollments(db, {
      prospectId: target.prospect.id,
      companyDomain: target.prospect.companyDomain,
      scope: 'prospect',
      exceptEnrollmentId: target.enrollmentId,
      reason: 'unsubscribed',
    });
  }
}

export interface LabelEffectTarget extends UnsubscribeTarget {
  /** The label before this change, for the `interested` counter. */
  previousLabel: ReachReplyLabel | null;
}

/**
 * The consequences of a label, whoever chose it: `unsubscribe` is an opt-out,
 * `interested` and `meeting_request` count as interested for the campaign.
 */
export async function applyLabelEffects(db: Database, target: LabelEffectTarget, label: ReachReplyLabel): Promise<void> {
  if (label === 'unsubscribe') await applyUnsubscribe(db, target);

  const wasPositive = isPositiveLabel(target.previousLabel);
  const isPositive = isPositiveLabel(label);
  if (isPositive && !wasPositive) await bumpCampaignStat(db, target.campaignId, 'interested', 1);
  if (!isPositive && wasPositive) await bumpCampaignStat(db, target.campaignId, 'interested', -1);
}
