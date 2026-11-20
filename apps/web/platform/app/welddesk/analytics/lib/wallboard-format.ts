/**
 * Display helpers for the WeldDesk wallboard: clock-style durations that read
 * from a distance, and the live values derived from `generatedAt`.
 */

import type { TranslationsType } from '@/lib/i18n/types';
import { formatDuration } from './report-labels';

type ReportsT = TranslationsType['helpdesk']['reports'];

const HOUR = 3600;

/**
 * A duration as a clock under an hour ("0:45", "12:05") and as "2h 5m" from an
 * hour on, where the seconds no longer matter. An em dash when there is none.
 */
export function formatClock(seconds: number | null | undefined, t: ReportsT): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s >= HOUR) return formatDuration(s, t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A wait the server measured at `generatedAt`, as it stands at `nowMs`: the
 * measured seconds plus the time since. Never goes backwards when the browser
 * clock is behind the server's.
 */
export function liveSeconds(measured: number | null, generatedAt: string, nowMs: number): number | null {
  if (measured == null) return null;
  const generated = Date.parse(generatedAt);
  if (Number.isNaN(generated)) return measured;
  return measured + Math.max(0, Math.floor((nowMs - generated) / 1000));
}

export interface Countdown {
  overdue: boolean;
  /** Seconds left, or seconds past the due time when overdue. */
  seconds: number;
}

/** How long until `dueAt`, or how long past it. An unreadable date counts as due now. */
export function countdownTo(dueAt: string, nowMs: number): Countdown {
  const due = Date.parse(dueAt);
  const diff = Number.isNaN(due) ? 0 : Math.round((due - nowMs) / 1000);
  return diff >= 0 ? { overdue: false, seconds: diff } : { overdue: true, seconds: -diff };
}
