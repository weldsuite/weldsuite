/**
 * WeldReach warmup network: the numbers reach-api and the warmup worker have
 * to agree on (ramp, health gate, pool minimum). Pure, no I/O.
 *
 * See docs/plans/weldreach-warmup.md.
 */

/** Days of warmup sending before a mailbox may join campaigns. */
export const WARMUP_MIN_DAYS = 14;

/** Inbox placement a mailbox needs over the gate window to join campaigns. */
export const WARMUP_MIN_INBOX_RATE = 0.85;

/** Days the health gate looks back at. */
export const WARMUP_GATE_WINDOW_DAYS = 3;

/** Below this many judged emails in the window a rate is noise (null). */
export const WARMUP_MIN_SAMPLE = 10;

/** The planner needs mailboxes on at least this many domains (pairing never stays within one domain). */
export const WARMUP_MIN_POOL_DOMAINS = 3;

/** Warmup sends on ramp day 1 and the cap reached by day WARMUP_MIN_DAYS. */
export const WARMUP_RAMP_START = 2;
export const WARMUP_RAMP_MAX = 40;

/** Daily warmup sends once a mailbox is maintaining (also sending campaigns). */
export const WARMUP_MAINTAIN_MIN = 10;
export const WARMUP_MAINTAIN_MAX = 15;

/** Share of threads that get replies. */
export const WARMUP_REPLY_RATE_MIN = 0.3;
export const WARMUP_REPLY_RATE_MAX = 0.45;

/** Warmup threads older than this are deleted from both mailboxes. */
export const WARMUP_CLEANUP_AFTER_DAYS = 14;

/**
 * Planned warmup sends for a mailbox on `rampDay` (1-based). Linear from
 * WARMUP_RAMP_START on day 1 to WARMUP_RAMP_MAX on day WARMUP_MIN_DAYS; day 0
 * (not started) plans nothing.
 */
export function warmupRampTarget(rampDay: number): number {
  if (rampDay <= 0) return 0;
  if (rampDay >= WARMUP_MIN_DAYS) return WARMUP_RAMP_MAX;
  const step = (WARMUP_RAMP_MAX - WARMUP_RAMP_START) / (WARMUP_MIN_DAYS - 1);
  return Math.round(WARMUP_RAMP_START + step * (rampDay - 1));
}

/** inbox / (inbox + spam + missing), or null below WARMUP_MIN_SAMPLE judged emails. */
export function inboxRate(counts: { inbox: number; spam: number; missing: number }): number | null {
  const judged = counts.inbox + counts.spam + counts.missing;
  if (judged < WARMUP_MIN_SAMPLE) return null;
  return counts.inbox / judged;
}

export interface WarmupGateInput {
  /** Days of warmup sending so far. */
  rampDay: number;
  /** Inbox rate over WARMUP_GATE_WINDOW_DAYS (null = not enough data yet). */
  inboxRate3d: number | null;
  /** A login failed recently and was not followed by a success. */
  hasLoginError: boolean;
}

export type WarmupGateResult =
  | { ready: true }
  | { ready: false; reason: 'too_early' | 'not_enough_data' | 'low_inbox_rate' | 'login_error' };

/** Whether a mailbox may join campaigns (docs/plans/weldreach-warmup.md, "Health gate"). */
export function warmupGate(input: WarmupGateInput): WarmupGateResult {
  if (input.hasLoginError) return { ready: false, reason: 'login_error' };
  if (input.rampDay < WARMUP_MIN_DAYS) return { ready: false, reason: 'too_early' };
  if (input.inboxRate3d === null) return { ready: false, reason: 'not_enough_data' };
  if (input.inboxRate3d < WARMUP_MIN_INBOX_RATE) return { ready: false, reason: 'low_inbox_rate' };
  return { ready: true };
}

/** Lower-cased domain of an address. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}
