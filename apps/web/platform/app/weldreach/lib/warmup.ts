/**
 * What the WeldReach screens say about a mailbox's warmup: the numbers shown
 * next to every "warms up for at least N days" sentence, which mailboxes have
 * warmup figures worth showing, and the average inbox placement of the
 * overview.
 *
 * The thresholds mirror `@weldsuite/reach-domain/warmup`, which the platform
 * does not depend on; change them together (docs/plans/weldreach-warmup.md).
 */

import {
  WELDREACH_SENDING_DEFAULTS,
  type ReachMailbox,
  type ReachWarmupBlocker,
} from '@weldsuite/app-api-client/schemas/reach';

/** Inbox placement over the last 3 days a mailbox needs before it joins campaigns. */
export const WARMUP_MIN_INBOX_RATE = 0.85;

/** The warmup network pairs mailboxes across domains, so it waits for mailboxes on at least this many. */
export const WARMUP_MIN_POOL_DOMAINS = 3;

/** The `{days}`, `{rate}` and `{domains}` values of the warmup sentences. `rate` is a whole percentage (85). */
export function warmupCopyParams(): { days: number; rate: number; domains: number } {
  return {
    days: WELDREACH_SENDING_DEFAULTS.warmupDays,
    rate: Math.round(WARMUP_MIN_INBOX_RATE * 100),
    domains: WARMUP_MIN_POOL_DOMAINS,
  };
}

/** Whether the blocker is a problem to act on (warning) or just a reason to wait (info). */
export function warmupBlockerSeverity(blocker: ReachWarmupBlocker): 'info' | 'warning' {
  return blocker === 'low_inbox_rate' || blocker === 'login_error' ? 'warning' : 'info';
}


/**
 * A mailbox's warmup numbers. An older reach-api (while a deploy is in flight)
 * leaves them out; they then read as "no data" instead of NaN.
 */
export function warmupFigures(
  mailbox: Pick<ReachMailbox, 'warmupInboxRate' | 'warmupSent7d' | 'warmupSpamRescues7d' | 'warmupBlocker'>,
): { inboxRate: number | null; sent7d: number; spamRescues7d: number; blocker: ReachWarmupBlocker | null } {
  return {
    inboxRate: mailbox.warmupInboxRate ?? null,
    sent7d: mailbox.warmupSent7d ?? 0,
    spamRescues7d: mailbox.warmupSpamRescues7d ?? 0,
    blocker: mailbox.warmupBlocker ?? null,
  };
}

/** Mailboxes whose placement counts towards the overview average: still warming, or ready and kept warm. */
export function takesPartInWarmup(mailbox: Pick<ReachMailbox, 'status'>): boolean {
  return mailbox.status === 'warming' || mailbox.status === 'active';
}

/** Whether the mailbox is in the warmup network at all (a row that was removed from it is not). */
export function isInWarmupPool(mailbox: Pick<ReachMailbox, 'warmupStatus'>): boolean {
  const state = mailbox.warmupStatus ?? null;
  return state !== null && state !== 'removed';
}

/** Whether the Mailboxes screen shows warmup figures for this mailbox (otherwise just a dash). */
export function showsWarmupFigures(mailbox: Pick<ReachMailbox, 'status' | 'warmupStatus'>): boolean {
  return takesPartInWarmup(mailbox) || isInWarmupPool(mailbox);
}

/**
 * The pool state worth naming next to the mailbox status, or null when the
 * status badge and the "Day X of 14" line already say it.
 */
export function warmupStateToShow(mailbox: Pick<ReachMailbox, 'status' | 'warmupStatus'>): string | null {
  switch (mailbox.warmupStatus) {
    case 'waiting':
    case 'maintaining':
    case 'error':
      return mailbox.warmupStatus;
    case 'paused':
      // A paused mailbox already shows a "Paused" badge.
      return mailbox.status === 'paused' ? null : 'paused';
    default:
      return null;
  }
}

/**
 * Mean 3-day inbox placement (0..1) of the warming and ready mailboxes that
 * have one, or null when none has enough data yet.
 */
export function averageInboxPlacement(
  mailboxes: ReadonlyArray<Pick<ReachMailbox, 'status' | 'warmupInboxRate'>>,
): number | null {
  const rates = mailboxes
    .filter(takesPartInWarmup)
    .map((mailbox) => mailbox.warmupInboxRate ?? null)
    .filter((rate): rate is number => rate !== null);
  if (rates.length === 0) return null;
  return rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}
