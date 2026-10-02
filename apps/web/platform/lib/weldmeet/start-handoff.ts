/**
 * Transient hand-off for the "instant meeting" fast-path.
 *
 * The /weldmeet/new page calls the new core-api `startInstantMeeting`
 * endpoint, which returns the RTK auth token in the same response.
 * We stash that token here keyed by meetingId, then the room page's
 * call context picks it up and skips the legacy GET /sessions/active +
 * POST /sessions/:id/join round-trips.
 *
 * Module-scoped Map (not Jotai / context) because:
 *   - it has zero subscribers — only one consumer reads it once
 *   - it must survive a navigate() call but not a full page reload
 *   - 30s TTL guards against the consumer never showing up
 */

export interface StartHandoff {
  meetingId: string;
  sessionId: string;
  authToken: string;
  rtkMeetingId: string;
  expiresAt: number;
}

const HANDOFF_TTL_MS = 30_000;
const store = new Map<string, StartHandoff>();

export function setStartHandoff(value: Omit<StartHandoff, 'expiresAt'>): void {
  store.set(value.meetingId, { ...value, expiresAt: Date.now() + HANDOFF_TTL_MS });
}

/**
 * Whether a live (unexpired) hand-off exists for a meetingId, WITHOUT consuming
 * it. The room page uses this to tell a fresh instant start (the host just
 * clicked "Start", already chose their devices, skip the pre-join screen) from a
 * reload or a scheduled start (show the pre-join screen).
 */
export function peekStartHandoff(meetingId: string): boolean {
  const entry = store.get(meetingId);
  return !!entry && entry.expiresAt >= Date.now();
}

/**
 * Read and remove the hand-off for a meetingId. Returns null if missing or
 * expired. Single-use to avoid stale tokens being reused on a reload.
 */
export function consumeStartHandoff(meetingId: string): StartHandoff | null {
  const entry = store.get(meetingId);
  if (!entry) return null;
  store.delete(meetingId);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}
