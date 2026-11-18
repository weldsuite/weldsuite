/**
 * forms-api refuses a submit that comes less than a moment after its session
 * started (ADR FORMS-005), measured on the server only. The page starts the
 * session at the first answer; a respondent quicker than the minimum waits out
 * the rest before the submit goes, instead of being refused.
 *
 * The server saw the session start before this page got the answer, and sees
 * the submit after this page sent it, so waiting until the minimum has passed
 * here is always enough there.
 */

/** `FORM_LIMITS.minFillMs` (the portal imports only types from the shared contract). */
export const MIN_FILL_MS = 1500
const MARGIN_MS = 100

/** Milliseconds to wait before sending the submit of a session this page saw start at `startedAt`. */
export function submitWaitMs(startedAt: number, now: number, minFillMs: number = MIN_FILL_MS): number {
  return Math.max(0, startedAt + minFillMs + MARGIN_MS - now)
}
