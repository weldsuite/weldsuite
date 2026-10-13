// ─── Camera-off tile palette ─────────────────────────────────────────────────
// One colour per participant, picked by hashing a stable id, so every surface
// (in-call tile, People panel, admission pill, the portal's pre-join preview)
// shows the same person in the same colour.
//
// `avatar` is the letter-avatar palette of a Google account (the Inbox / Gmail
// letter colours, one per initial A–Z; Q and W share a grey). `tile` is the
// same hue mixed 60% towards #202124, for the area behind the avatar.

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

function hashString(input: string): number {
  // An Int32Array slot wraps on every write, exactly like `h |= 0` did.
  const h = new Int32Array(1);
  for (let i = 0; i < input.length; i++) {
    h[0] = Math.imul(h[0]!, 31) + input.codePointAt(i)!;
  }
  return Math.abs(h[0]!);
}

export function getPersonTheme(seed: string): PersonTheme {
  return PERSON_THEMES[hashString(seed || 'guest') % PERSON_THEMES.length]!;
}

/** One or two initials for a name: first and last word. */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts.at(-1)!.charAt(0)).toUpperCase();
}

/**
 * The id a participant's colour hangs on. `customParticipantId` is stable
 * across sessions (set by the host app), `userId` is the auth-token identity
 * and `id` the per-session one, so every client viewing this participant
 * hashes the same value, on the tile and in every list.
 */
export function getPeerColorSeed(peer: {
  customParticipantId?: string;
  userId?: string;
  id?: string;
  name?: string;
}): string {
  return String(peer.customParticipantId ?? peer.userId ?? peer.id ?? peer.name ?? '');
}

const DARK_INITIALS = '#202124';

function channelLuminance(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * Colour for initials drawn on an avatar colour: white, as Google draws them,
 * except on the light ones (yellows, light greens, cyan, light grey) where
 * white is too faint to read at People-panel size.
 */
export function getInitialsColor(background: string): string {
  const hex = /^#?([0-9a-f]{6})$/i.exec(background)?.[1];
  if (!hex) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map((i) => channelLuminance(Number.parseInt(hex.slice(i, i + 2), 16)));
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  // Contrast of white on this colour; below 2.2 the letter washes out.
  return 1.05 / (luminance + 0.05) < 2.2 ? DARK_INITIALS : '#ffffff';
}
