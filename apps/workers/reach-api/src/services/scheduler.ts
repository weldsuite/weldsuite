/**
 * Who sends what, and when: the pure planning half of the send engine.
 *
 * Everything here works on plain data (no database, no clock of its own), so
 * the rules from docs/plans/weldreach.md ("Sending engine") are unit-testable:
 *
 * - a mailbox sends at most ONE email per tick, only while `active`, only
 *   under min(ramp, daily cap), and only after its minimum gap (+ random-looking
 *   jitter of 0-50%) since the previous send;
 * - a campaign sends only inside its window, on its send days, up to its daily
 *   limit; the workspace has one `maxDailySends` across all campaigns;
 * - a prospect's first email picks the campaign mailbox with the most capacity
 *   left today and that mailbox is sticky for the whole sequence.
 *
 * `services/send-tick.ts` loads the data, calls this and does the I/O.
 */

import {
  isWithinWindow,
  snapIntoWindow,
  startOfNextZonedDay,
  type SendSchedule,
} from '../lib/send-window';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** How long a claim on an enrollment holds before another consumer may take it over. */
export const CLAIM_STALE_MS = 10 * MINUTE_MS;
/** An outbound row still `sending` after this long belongs to a crashed send. */
export const STUCK_SENDING_MS = 15 * MINUTE_MS;
/** Retry after a temporary SMTP error. */
export const TEMPORARY_RETRY_MS = 15 * MINUTE_MS;
/** Retry when a mailbox is unusable (paused, in error, deleted). */
export const UNAVAILABLE_RETRY_MS = HOUR_MS;
/** The smallest wait between two ticks of one workspace. */
export const MIN_RETRY_MS = MINUTE_MS;

// ---------------------------------------------------------------------------
// Mailbox pacing
// ---------------------------------------------------------------------------

/** FNV-1a, 32 bit: a stable pseudo-random number from text. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Jitter, 0..0.5 of the gap, derived from the previous send so that it is
 * stable across the ticks that wait for it (a fresh random number per tick
 * would collapse the jitter into "the shortest draw wins").
 */
export function jitterFraction(seed: string): number {
  return (hash32(seed) % 51) / 100;
}

export interface PlanMailbox {
  id: string;
  status: string;
  dailyCap: number;
  rampCurrent: number;
  lastSentAt: Date | null;
  /** Outbound emails from this mailbox since the start of today. */
  sentToday: number;
}

/** Sends this mailbox may still do today. */
export function mailboxCapacity(m: Pick<PlanMailbox, 'dailyCap' | 'rampCurrent' | 'sentToday'>): number {
  return Math.max(0, Math.min(m.rampCurrent, m.dailyCap) - m.sentToday);
}

/** When the gap since the last send is over; null when the mailbox never sent. */
export function gapEndsAt(m: Pick<PlanMailbox, 'id' | 'lastSentAt'>, minGapMinutes: number): Date | null {
  if (!m.lastSentAt) return null;
  const jitter = jitterFraction(`${m.id}:${m.lastSentAt.getTime()}`);
  return new Date(m.lastSentAt.getTime() + minGapMinutes * MINUTE_MS * (1 + jitter));
}

export function isGapOver(m: Pick<PlanMailbox, 'id' | 'lastSentAt'>, minGapMinutes: number, now: Date): boolean {
  const end = gapEndsAt(m, minGapMinutes);
  return end === null || end.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Campaign gates
// ---------------------------------------------------------------------------

export interface PlanCampaign {
  id: string;
  schedule: SendSchedule;
  dailyLimit: number;
  minGapMinutes: number;
  /** Outbound campaign emails since the start of today. */
  sentToday: number;
  /** Mailboxes assigned to the campaign. */
  mailboxIds: readonly string[];
}

export interface PlanContext {
  now: Date;
  /** The zone that decides where "today" starts (the workspace default timezone). */
  dayTimezone: string;
  /** Workspace-wide ceiling per day across all campaigns (limits.maxDailySends). */
  maxDailySends: number;
  /** Outbound emails of every kind since the start of today. */
  workspaceSentToday: number;
}

export type GateClosedReason = 'window' | 'daily_limit' | 'workspace_limit';
export type CampaignGate = { open: true } | { open: false; reason: GateClosedReason; reopensAt: Date };

/** The first sending window of the campaign after today ends. */
export function nextDayWindowStart(campaign: Pick<PlanCampaign, 'schedule'>, ctx: Pick<PlanContext, 'now' | 'dayTimezone'>): Date {
  return snapIntoWindow(startOfNextZonedDay(ctx.now, ctx.dayTimezone), campaign.schedule);
}

export function evaluateCampaignGate(campaign: PlanCampaign, ctx: PlanContext): CampaignGate {
  if (ctx.workspaceSentToday >= ctx.maxDailySends) {
    return { open: false, reason: 'workspace_limit', reopensAt: nextDayWindowStart(campaign, ctx) };
  }
  if (!isWithinWindow(ctx.now, campaign.schedule)) {
    return { open: false, reason: 'window', reopensAt: snapIntoWindow(ctx.now, campaign.schedule) };
  }
  if (campaign.sentToday >= campaign.dailyLimit) {
    return { open: false, reason: 'daily_limit', reopensAt: nextDayWindowStart(campaign, ctx) };
  }
  return { open: true };
}

// ---------------------------------------------------------------------------
// Claim readiness
// ---------------------------------------------------------------------------

export interface Readiness {
  /** Mailboxes that could send right now: usable, under cap, gap over. */
  readyMailboxIds: Set<string>;
  /** Mailboxes `active` and under cap that are only waiting for their gap. */
  gapBlockedUntil: Date | null;
  /** Mailboxes that are not `active` (or gone). */
  unusableMailboxIds: Set<string>;
  /** `active` mailboxes with no capacity left today. */
  cappedMailboxIds: Set<string>;
}

/**
 * Which mailboxes the claim query should pull enrollments for. Judged with
 * the SMALLEST gap of the open campaigns: the planner re-checks with the
 * claimed campaign's own gap, this only keeps blocked mailboxes' rows from
 * crowding the claim.
 */
export function assessMailboxes(
  mailboxes: Iterable<PlanMailbox>,
  openCampaigns: readonly PlanCampaign[],
  now: Date,
): Readiness {
  const floorGap = openCampaigns.length > 0 ? Math.min(...openCampaigns.map((c) => c.minGapMinutes)) : 0;
  const out: Readiness = {
    readyMailboxIds: new Set(),
    gapBlockedUntil: null,
    unusableMailboxIds: new Set(),
    cappedMailboxIds: new Set(),
  };
  for (const m of mailboxes) {
    if (m.status !== 'active') {
      out.unusableMailboxIds.add(m.id);
    } else if (mailboxCapacity(m) <= 0) {
      out.cappedMailboxIds.add(m.id);
    } else if (isGapOver(m, floorGap, now)) {
      out.readyMailboxIds.add(m.id);
    } else {
      const ends = gapEndsAt(m, floorGap);
      if (ends && (!out.gapBlockedUntil || ends < out.gapBlockedUntil)) out.gapBlockedUntil = ends;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanEnrollment {
  id: string;
  campaignId: string;
  /** Sticky sender; null until the first email. */
  mailboxId: string | null;
}

export interface PlannedSend {
  enrollmentId: string;
  campaignId: string;
  mailboxId: string;
}

export type DeferReason =
  | 'campaign_inactive'
  | 'campaign_limit'
  | 'workspace_limit'
  | 'mailbox_unavailable'
  | 'mailbox_capacity'
  | 'mailbox_busy'
  | 'mailbox_gap'
  | 'no_mailbox';

export interface PlannedDeferral {
  enrollmentId: string;
  /** New `next_send_at`; null keeps the current one (the row only gets un-claimed). */
  until: Date | null;
  reason: DeferReason;
}

export interface TickPlan {
  sends: PlannedSend[];
  deferrals: PlannedDeferral[];
  /** Earliest moment a deferred-but-still-due enrollment could be sent. */
  retryAt: Date | null;
}

function earlier(a: Date | null, b: Date): Date {
  return a && a.getTime() <= b.getTime() ? a : b;
}

/**
 * Decide, for the enrollments this tick claimed (oldest due first), which ones
 * send from which mailbox and which wait. Limits are applied as sends are
 * planned, so one tick never overshoots a cap.
 */
export function planSends(
  ctx: PlanContext,
  campaigns: ReadonlyMap<string, PlanCampaign>,
  mailboxes: ReadonlyMap<string, PlanMailbox>,
  claimed: readonly PlanEnrollment[],
): TickPlan {
  const plan: TickPlan = { sends: [], deferrals: [], retryAt: null };
  const usedMailboxes = new Set<string>();
  const campaignRemaining = new Map<string, number>();
  let workspaceRemaining = Math.max(0, ctx.maxDailySends - ctx.workspaceSentToday);

  const defer = (e: PlanEnrollment, until: Date | null, reason: DeferReason) => {
    plan.deferrals.push({ enrollmentId: e.id, until, reason });
  };
  const retrySoon = (at: Date) => {
    plan.retryAt = earlier(plan.retryAt, at);
  };
  const tomorrow = (campaign: PlanCampaign) => nextDayWindowStart(campaign, ctx);
  const inAnHour = new Date(ctx.now.getTime() + UNAVAILABLE_RETRY_MS);
  const inAMinute = new Date(ctx.now.getTime() + MIN_RETRY_MS);

  for (const e of claimed) {
    const campaign = campaigns.get(e.campaignId);
    if (!campaign) {
      defer(e, null, 'campaign_inactive');
      continue;
    }
    if (!campaignRemaining.has(campaign.id)) {
      campaignRemaining.set(campaign.id, Math.max(0, campaign.dailyLimit - campaign.sentToday));
    }
    if (workspaceRemaining <= 0) {
      defer(e, tomorrow(campaign), 'workspace_limit');
      continue;
    }
    if ((campaignRemaining.get(campaign.id) ?? 0) <= 0) {
      defer(e, tomorrow(campaign), 'campaign_limit');
      continue;
    }

    let chosen: PlanMailbox | null = null;

    if (e.mailboxId) {
      const m = mailboxes.get(e.mailboxId);
      if (!m || m.status !== 'active') {
        defer(e, inAnHour, 'mailbox_unavailable');
        continue;
      }
      if (mailboxCapacity(m) <= 0) {
        defer(e, tomorrow(campaign), 'mailbox_capacity');
        continue;
      }
      if (usedMailboxes.has(m.id)) {
        defer(e, null, 'mailbox_busy');
        retrySoon(inAMinute);
        continue;
      }
      const ends = gapEndsAt(m, campaign.minGapMinutes);
      if (ends && ends > ctx.now) {
        defer(e, null, 'mailbox_gap');
        retrySoon(ends);
        continue;
      }
      chosen = m;
    } else {
      const usable = campaign.mailboxIds
        .map((id) => mailboxes.get(id))
        .filter((m): m is PlanMailbox => !!m && m.status === 'active');
      if (usable.length === 0) {
        defer(e, inAnHour, 'no_mailbox');
        continue;
      }
      const withCapacity = usable.filter((m) => mailboxCapacity(m) > 0);
      if (withCapacity.length === 0) {
        defer(e, tomorrow(campaign), 'mailbox_capacity');
        continue;
      }
      const free = withCapacity.filter((m) => !usedMailboxes.has(m.id));
      if (free.length === 0) {
        defer(e, null, 'mailbox_busy');
        retrySoon(inAMinute);
        continue;
      }
      const ready = free.filter((m) => isGapOver(m, campaign.minGapMinutes, ctx.now));
      if (ready.length === 0) {
        defer(e, null, 'mailbox_gap');
        for (const m of free) {
          const ends = gapEndsAt(m, campaign.minGapMinutes);
          if (ends) retrySoon(ends);
        }
        continue;
      }
      // Most capacity left first; then the one that has rested longest.
      ready.sort(
        (a, b) =>
          mailboxCapacity(b) - mailboxCapacity(a) ||
          (a.lastSentAt?.getTime() ?? 0) - (b.lastSentAt?.getTime() ?? 0) ||
          a.id.localeCompare(b.id),
      );
      chosen = ready[0] ?? null;
    }

    if (!chosen) {
      defer(e, null, 'no_mailbox');
      continue;
    }
    usedMailboxes.add(chosen.id);
    workspaceRemaining -= 1;
    campaignRemaining.set(campaign.id, (campaignRemaining.get(campaign.id) ?? 1) - 1);
    plan.sends.push({ enrollmentId: e.id, campaignId: campaign.id, mailboxId: chosen.id });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Following up
// ---------------------------------------------------------------------------

export interface StepTiming {
  delayDays: number;
  delayHours: number;
}

/** When the next step is due: its delay after `sentAt`, moved into the campaign window. */
export function nextStepDueAt(sentAt: Date, next: StepTiming, schedule: SendSchedule): Date {
  const delayMs = next.delayDays * 24 * HOUR_MS + next.delayHours * HOUR_MS;
  return snapIntoWindow(new Date(sentAt.getTime() + delayMs), schedule);
}
