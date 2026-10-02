/**
 * WeldMeet recording helpers: error classification for the paid / destructive
 * recording routes, and the credit estimate shown before the user spends.
 *
 * Pure functions, no React, so they are unit-testable and shared by the
 * overlay, the history list and the meeting detail page.
 */

import { isApiError } from '@weldsuite/api-client';
import type {
  RecordingPartSummary,
  RecordingStatus,
} from '@weldsuite/app-api-client/schemas/weldmeet-recordings';

// ============================================================================
// Errors
// ============================================================================

export interface InsufficientCreditsDetails {
  currentBalance?: number;
  required?: number;
  shortfall?: number;
}

/**
 * The 402 `INSUFFICIENT_CREDITS` details when `err` is that error, else null.
 * meet-api answers `{ error: { code, message, details: { currentBalance,
 * required, shortfall } } }`; the api client keeps the parsed body on the error.
 */
export function parseInsufficientCredits(err: unknown): InsufficientCreditsDetails | null {
  if (!isApiError(err) || err.status !== 402) return null;
  const body = err.body as { error?: { details?: InsufficientCreditsDetails } } | undefined;
  const details = body?.error?.details;
  return details && typeof details === 'object' ? details : {};
}

/** True for an HTTP error with the given status (404, 409, ...). */
export function hasApiStatus(err: unknown, status: number): boolean {
  return isApiError(err) && err.status === status;
}

// ============================================================================
// State helpers
// ============================================================================

/** A recording that has (or will get) files: anything but never-recorded / deleted. */
export function isLiveRecordingStatus(status: RecordingStatus | null | undefined): boolean {
  return status === 'recording' || status === 'processing';
}

/** Statuses a host may delete a recording in (the API refuses while the recorder runs). */
export function isDeletableRecordingStatus(status: RecordingStatus | null | undefined): boolean {
  return status === 'ready' || status === 'failed' || status === 'processing' || status === 'unavailable';
}

// ============================================================================
// Credit estimate
// ============================================================================

/** Billed meeting minutes for a duration in seconds (every started minute counts). */
export function billedMinutes(seconds: number | null | undefined): number {
  if (!seconds || seconds <= 0) return 0;
  return Math.ceil(seconds / 60);
}

/** Credits for `minutes` at `ratePerMinute`; the server charges whole credits. */
export function estimateCredits(minutes: number, ratePerMinute: number): number {
  if (minutes <= 0 || ratePerMinute <= 0) return 0;
  return Math.ceil(minutes * ratePerMinute);
}

/**
 * Seconds a "transcribe afterwards" run is billed for: every ready part's
 * duration, summed, capped at the session duration when that is known.
 */
export function billableRecordingSeconds(input: {
  parts?: RecordingPartSummary[];
  durationSeconds?: number | null;
  sessionDurationSeconds?: number | null;
}): number {
  const readyParts = (input.parts ?? []).filter((p) => p.status === 'ready' && p.durationSeconds);
  const summed = readyParts.reduce((sum, p) => sum + (p.durationSeconds ?? 0), 0);
  const total = summed > 0 ? summed : (input.durationSeconds ?? 0);
  const cap = input.sessionDurationSeconds;
  return cap && cap > 0 ? Math.min(total, cap) : total;
}

/** "1,234" style number for credit amounts (credits can be fractional rates; amounts are whole). */
export function formatCredits(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

/** Fill `{name}` placeholders in a translated string. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
