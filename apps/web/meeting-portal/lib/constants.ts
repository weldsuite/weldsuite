/**
 * Meeting-portal-wide constants. Replaces magic literals scattered through
 * `page.tsx` and the API client.
 */

// ── Polling intervals ─────────────────────────────────────────────────────

export const POLLING_INTERVAL_MS = {
  /** While `status === 'waiting'` — we re-call /api/meeting/join until a session opens. */
  waitingForSession: 5000,
  /** While `status === 'waitlisted'` — poll waitlist-status for host approval. */
  waitlist: 3000,
} as const;

// ── Email regex ───────────────────────────────────────────────────────────

/**
 * Same shape used by the join form before we adopted RHF + zodResolver.
 * Kept here so the disabled-state guard in the landing form stays consistent
 * with the schema validation done inside zodResolver. Domain labels exclude
 * `.` so the pattern cannot backtrack super-linearly.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

// ── Person theme palette ──────────────────────────────────────────────────

/**
 * Same palette + hash as packages/design/weldmeet-ui/src/lib/person-theme.ts (the
 * letter-avatar colours of a Google account, with a darker shade for the tile) so
 * the landing preview color matches the in-meeting tile color for the same guest.
 */
export const PERSON_THEMES = [
  { tile: '#6e3a36', avatar: '#e25f51' }, // A
  { tile: '#743a50', avatar: '#f26091' }, // B
  { tile: '#5e3c66', avatar: '#bb65ca' }, // C
  { tile: '#4f4168', avatar: '#9572cf' }, // D
  { tile: '#434968', avatar: '#7884cd' }, // E
  { tile: '#384f79', avatar: '#5b95f9' }, // F
  { tile: '#306179', avatar: '#48c2f9' }, // G
  { tile: '#2f6770', avatar: '#45d0e2' }, // H
  { tile: '#305d5a', avatar: '#48b6ac' }, // I
  { tile: '#345f4c', avatar: '#52bc89' }, // J
  { tile: '#51663c', avatar: '#9bce5f' }, // K
  { tile: '#686f33', avatar: '#d4e34a' }, // L
  { tile: '#796b1c', avatar: '#feda10' }, // M
  { tile: '#766116', avatar: '#f7c000' }, // N
  { tile: '#795716', avatar: '#ffa800' }, // O
  { tile: '#794b3c', avatar: '#ff8a60' }, // P
  { tile: '#616163', avatar: '#c2c2c2' }, // Q, W
  { tile: '#4c555c', avatar: '#8fa4af' }, // R
  { tile: '#544a48', avatar: '#a2887e' }, // S
  { tile: '#545557', avatar: '#a3a3a3' }, // T
  { tile: '#595c70', avatar: '#afb5e2' }, // U
  { tile: '#5b526e', avatar: '#b39bdd' }, // V
  { tile: '#456d74', avatar: '#7cdeeb' }, // X
  { tile: '#5e5857', avatar: '#bcaaa4' }, // Y
  { tile: '#586948', avatar: '#add67d' }, // Z
] as const;

export type PersonTheme = (typeof PERSON_THEMES)[number];

export function getPersonTheme(seed = 'guest'): PersonTheme {
  // 31-multiplier string hash, wrapped to int32 (Math.imul wraps its operands).
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h, 31) + seed.codePointAt(i)!;
  }
  h = Math.imul(h, 1);
  return PERSON_THEMES[Math.abs(h) % PERSON_THEMES.length]!;
}

// ── Preview tile colors ───────────────────────────────────────────────────

/** Dark neutral used for the preview tile when video is on (so the camera image dominates). */
export const PREVIEW_DARK_BG = '#0e0e10';
