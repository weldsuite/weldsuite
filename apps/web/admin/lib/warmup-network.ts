// Client-safe helpers for the Warmup network screen: no `server-only`, no
// database imports, so the screen's client components and the unit tests can
// use them.
//
// The numbers and the resume rule mirror `@weldsuite/reach-domain/warmup` and
// `unpausedStatus` in `@weldsuite/reach-domain/warmup-pool`. The admin console
// does not depend on that package (it pulls in the worker kit), so the tiny
// rule is repeated here: change them together
// (docs/plans/weldreach-warmup.md).

/** Days of warmup sending before a mailbox may join campaigns. */
export const WARMUP_MIN_DAYS = 14;

/** Inbox placement over 3 days a mailbox needs before it may join campaigns. */
export const WARMUP_MIN_INBOX_RATE = 0.85;

/** The planner waits while mailboxes that take part span fewer domains than this. */
export const WARMUP_MIN_POOL_DOMAINS = 3;

/** `paused_reason` the console writes when staff pause a mailbox's warmup. */
export const STAFF_PAUSE_REASON = 'paused_by_staff';

export const POOL_STATUSES = ['waiting', 'warming', 'maintaining', 'paused', 'error', 'removed'] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];

/** Statuses of mailboxes that take part in the network (what the planner counts). */
export const PARTICIPATING_STATUSES = ['waiting', 'warming', 'maintaining'] as const satisfies readonly PoolStatus[];

/** Statuses of mailboxes that are in the pool but not taking part. */
export const STALLED_STATUSES = ['paused', 'error'] as const satisfies readonly PoolStatus[];

export const POOL_STATUS_LABELS: Record<PoolStatus, string> = {
  waiting: 'Waiting',
  warming: 'Warming',
  maintaining: 'Maintaining',
  paused: 'Paused',
  error: 'Error',
  removed: 'Removed',
};

export function isPoolStatus(value: unknown): value is PoolStatus {
  return typeof value === 'string' && (POOL_STATUSES as readonly string[]).includes(value);
}

/** Where a paused mailbox's warmup picks up again: the same rule reach-api uses to resume one. */
export function unpausedStatus(row: { startedAt: Date | string | null; rampDay: number }): PoolStatus {
  if (!row.startedAt) return 'waiting';
  return row.rampDay >= WARMUP_MIN_DAYS ? 'maintaining' : 'warming';
}

/** Staff may pause a mailbox that is waiting, warming, maintaining or in error. */
export function canPause(status: PoolStatus): boolean {
  return status === 'waiting' || status === 'warming' || status === 'maintaining' || status === 'error';
}

/** Only a paused mailbox can be resumed. */
export function canResume(status: PoolStatus): boolean {
  return status === 'paused';
}

/** "92%", or a dash when there is no rate (too few judged emails). */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${Math.round(rate * 1000) / 10}%`;
}

/** A rate is `low` below the health gate, `none` when there is no rate yet. */
export function rateTone(rate: number | null | undefined): 'ok' | 'low' | 'none' {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return 'none';
  return rate >= WARMUP_MIN_INBOX_RATE ? 'ok' : 'low';
}

export interface PoolDomainsFlag {
  /** True while the pool is too narrow for the planner to pair mailboxes. */
  belowMinimum: boolean;
  /** How many more domains the pool needs (0 when it has enough). */
  missing: number;
}

/** Whether the mailboxes that take part span enough domains for the planner to start. */
export function poolDomainsFlag(domainCount: number): PoolDomainsFlag {
  const missing = Math.max(0, WARMUP_MIN_POOL_DOMAINS - domainCount);
  return { belowMinimum: missing > 0, missing };
}

/** One UTC day of warmup mail, by where it landed. `pending` is sent but not yet checked. */
export interface PlacementDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  inbox: number;
  spam: number;
  missing: number;
  pending: number;
}

/** inbox / (inbox + spam + missing) of the emails already checked; null when none were. */
export function placementShare(day: Pick<PlacementDay, 'inbox' | 'spam' | 'missing'>): number | null {
  const judged = day.inbox + day.spam + day.missing;
  return judged === 0 ? null : day.inbox / judged;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of the day `now` falls in. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** `YYYY-MM-DD` of the last `count` UTC days ending with today, oldest first. */
export function lastUtcDays(count: number, now: Date): string[] {
  const today = startOfUtcDay(now).getTime();
  return Array.from({ length: count }, (_, index) =>
    new Date(today - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
}

/** One row per day of the window, zeros where nothing was sent, so a quiet day still shows. */
export function fillPlacementDays(rows: readonly PlacementDay[], days: readonly string[]): PlacementDay[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return days.map((day) => byDay.get(day) ?? { day, inbox: 0, spam: 0, missing: 0, pending: 0 });
}

export interface PlacementTotals {
  inbox: number;
  spam: number;
  missing: number;
  pending: number;
}

export function sumPlacement(days: readonly PlacementDay[]): PlacementTotals {
  return days.reduce<PlacementTotals>(
    (total, day) => ({
      inbox: total.inbox + day.inbox,
      spam: total.spam + day.spam,
      missing: total.missing + day.missing,
      pending: total.pending + day.pending,
    }),
    { inbox: 0, spam: 0, missing: 0, pending: 0 },
  );
}

/** `%`, `_` and `\` in what staff type match themselves instead of acting as wildcards in an ILIKE. */
export function likePattern(search: string): string {
  // `$&` is the matched character, so each wildcard gets a backslash in front of it.
  return `%${search.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The long error text of a failed login, cut for a table cell. */
export function shortenError(error: string | null | undefined, max = 120): string | null {
  const text = error?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What staff see as the reason a mailbox is not warming: the staff pause, a stored reason, or the login error. */
export function stalledReason(row: {
  status: PoolStatus;
  pausedReason: string | null;
  lastLoginError: string | null;
}): string {
  if (row.pausedReason === STAFF_PAUSE_REASON) return 'Paused by staff';
  if (row.status === 'error') return row.lastLoginError ? 'Login error' : 'Error';
  if (row.pausedReason) return row.pausedReason.replaceAll('_', ' ');
  return row.lastLoginError ? 'Login error' : '—';
}
