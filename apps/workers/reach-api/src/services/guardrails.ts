/**
 * Auto-pause rules that protect sender reputation (docs/plans/weldreach.md,
 * "Guardrails"):
 *
 * - a mailbox with WELDREACH_SENDING_DEFAULTS.mailboxHardBouncesPerDay hard
 *   bounces in the last 24 hours is paused (`pausedReason: 'bounces'`);
 * - a campaign whose bounce rate over its last campaignBounceWindow sends is
 *   above campaignBounceRate is paused (`pausedReason: 'bounce_rate'`).
 *
 * `recordHardBounce` is the one entry point: the send consumer calls it when a
 * recipient is rejected at send time, and the inbound handler calls it when a
 * bounce notice arrives by email. Call it AFTER the enrollment has been marked
 * `bounced`, because the counts are read from the enrollments.
 */

import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import { WELDREACH_SENDING_DEFAULTS } from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaigns,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  type ReachCampaign,
  type ReachMailbox,
} from '@weldsuite/db/schema';

/** Fewer sends than this say nothing about a rate: one bounce in five is not a trend. */
export const CAMPAIGN_BOUNCE_MIN_SAMPLE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GuardrailHooks {
  /** Called after a mailbox was auto-paused (publish the entity event here). */
  onMailboxPaused?: (mailbox: ReachMailbox) => void | Promise<void>;
  /** Called after a campaign was auto-paused (publish the entity event here). */
  onCampaignPaused?: (campaign: ReachCampaign) => void | Promise<void>;
}

export interface GuardrailResult {
  mailboxPaused: boolean;
  campaignPaused: boolean;
}

/** Hard bounces attributed to a mailbox in the last 24 hours. */
export async function mailboxHardBouncesLastDay(db: Database, mailboxId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reachEnrollments)
    .where(
      and(
        eq(reachEnrollments.mailboxId, mailboxId),
        eq(reachEnrollments.status, 'bounced'),
        gte(reachEnrollments.updatedAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function pauseMailboxOnBounces(
  db: Database,
  mailboxId: string,
  hooks: GuardrailHooks = {},
  now: Date = new Date(),
): Promise<boolean> {
  const bounces = await mailboxHardBouncesLastDay(db, mailboxId, now);
  if (bounces < WELDREACH_SENDING_DEFAULTS.mailboxHardBouncesPerDay) return false;
  const [paused] = await db
    .update(reachMailboxes)
    .set({ status: 'paused', pausedReason: 'bounces', updatedAt: now })
    .where(and(eq(reachMailboxes.id, mailboxId), eq(reachMailboxes.status, 'active')))
    .returning();
  if (!paused) return false;
  await hooks.onMailboxPaused?.(paused);
  return true;
}

/** The bounce rate over the campaign's last `window` sends, and how many sends that was. */
export async function campaignBounceRate(
  db: Database,
  campaignId: string,
  window: number = WELDREACH_SENDING_DEFAULTS.campaignBounceWindow,
): Promise<{ sample: number; bounced: number; rate: number }> {
  const rows = await db
    .select({ enrollmentId: reachMessages.enrollmentId, enrollmentStatus: reachEnrollments.status })
    .from(reachMessages)
    .leftJoin(reachEnrollments, eq(reachEnrollments.id, reachMessages.enrollmentId))
    .where(
      and(
        eq(reachMessages.campaignId, campaignId),
        eq(reachMessages.direction, 'out'),
        or(
          eq(reachMessages.status, 'sent'),
          // A rejected recipient is a bounce too, even though nothing was delivered.
          and(eq(reachMessages.status, 'failed'), eq(reachEnrollments.status, 'bounced')),
        ),
      ),
    )
    .orderBy(desc(reachMessages.createdAt), desc(reachMessages.id))
    .limit(window);
  const bouncedEnrollments = new Set(rows.filter((r) => r.enrollmentStatus === 'bounced').map((r) => r.enrollmentId));
  const bounced = bouncedEnrollments.size;
  return { sample: rows.length, bounced, rate: rows.length === 0 ? 0 : bounced / rows.length };
}

export async function pauseCampaignOnBounceRate(
  db: Database,
  campaignId: string,
  hooks: GuardrailHooks = {},
  now: Date = new Date(),
): Promise<boolean> {
  const { sample, rate } = await campaignBounceRate(db, campaignId);
  if (sample < CAMPAIGN_BOUNCE_MIN_SAMPLE || rate <= WELDREACH_SENDING_DEFAULTS.campaignBounceRate) return false;
  const [paused] = await db
    .update(reachCampaigns)
    .set({ status: 'paused', pausedReason: 'bounce_rate', updatedAt: now })
    .where(and(eq(reachCampaigns.id, campaignId), eq(reachCampaigns.status, 'active')))
    .returning();
  if (!paused) return false;
  await hooks.onCampaignPaused?.(paused);
  return true;
}

export async function recordHardBounce(
  db: Database,
  target: { mailboxId: string | null; campaignId: string | null },
  hooks: GuardrailHooks = {},
  now: Date = new Date(),
): Promise<GuardrailResult> {
  const mailboxPaused = target.mailboxId ? await pauseMailboxOnBounces(db, target.mailboxId, hooks, now) : false;
  const campaignPaused = target.campaignId ? await pauseCampaignOnBounceRate(db, target.campaignId, hooks, now) : false;
  return { mailboxPaused, campaignPaused };
}
