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
 * with the schema validation done inside zodResolver.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Person theme palette ──────────────────────────────────────────────────

/**
 * Same palette + hash used by packages/design/weldmeet-ui/participant-tile.tsx so the
 * landing preview color matches the in-meeting tile color for the same guest.
 */
export const PERSON_THEMES = [
  { tile: '#3f6e58', avatar: '#578a72' }, // forest green
  { tile: '#5e4d83', avatar: '#7a67a3' }, // muted purple
  { tile: '#4d6c8f', avatar: '#6788ad' }, // slate blue
  { tile: '#8a5060', avatar: '#a8707e' }, // coral
  { tile: '#3f7878', avatar: '#5d9494' }, // teal
  { tile: '#8a7050', avatar: '#a88a6c' }, // sand
  { tile: '#5b5694', avatar: '#7770ab' }, // indigo
  { tile: '#874660', avatar: '#a26178' }, // rose
  { tile: '#4a6e3f', avatar: '#688a57' }, // moss
  { tile: '#7a4a3f', avatar: '#9c6857' }, // terracotta
] as const;

export type PersonTheme = (typeof PERSON_THEMES)[number];

export function getPersonTheme(seed: string): PersonTheme {
  let h = 0;
  const s = seed || 'guest';
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return PERSON_THEMES[Math.abs(h) % PERSON_THEMES.length]!;
}

// ── Preview tile colors ───────────────────────────────────────────────────

/** Dark neutral used for the preview tile when video is on (so the camera image dominates). */
export const PREVIEW_DARK_BG = '#0e0e10';
