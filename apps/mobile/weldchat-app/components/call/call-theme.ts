/**
 * Call-screen design tokens — a faithful port of the meeting-portal in-call
 * look (apps/web/meeting-portal → @weldsuite/weldmeet-ui MeetingRoomView).
 *
 * The web experience renders with the Attio dark palette (see
 * apps/web/meeting-portal/app/globals.css `.dark`) plus the shadcn neutral light
 * theme. These tokens mirror those exact values so the React-Native call screen
 * is visually identical to the web meeting room.
 */

import type { ThemeMode } from '@/constants/colors';

export interface CallColors {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  secondary: string;
  secondaryForeground: string;
  accent: string;
  primary: string;
  primaryForeground: string;
  destructive: string;
  border: string;
  /** Red treatment for a muted mic / off camera (web: bg-red-100/red-500-20). */
  offBg: string;
  offFg: string;
  offRing: string;
  /** Ring colors for tile state (web: ring-green-500 / ring-yellow-500). */
  speakingRing: string;
  handRing: string;
  /** Hand-raise corner badge (web: bg-yellow-500). */
  handBadge: string;
}

// Attio dark — matches apps/web/meeting-portal/app/globals.css `.dark`.
const dark: CallColors = {
  background: '#1c1d1f',
  foreground: '#ffffff',
  muted: '#232529',
  mutedForeground: '#b5bdc9',
  secondary: '#2e3238',
  secondaryForeground: '#edeff3',
  accent: '#2e3238',
  primary: '#266df0',
  primaryForeground: '#ffffff',
  destructive: '#ff5b59',
  border: '#2e3238',
  // dark:bg-red-500/20  dark:text-red-400  ring-red-400/40
  offBg: 'rgba(239,68,68,0.2)',
  offFg: '#f87171',
  offRing: 'rgba(248,113,113,0.4)',
  speakingRing: '#22c55e', // green-500
  handRing: '#eab308', // yellow-500
  handBadge: '#eab308', // yellow-500
};

// shadcn neutral light — matches packages/design/ui/src/styles/globals.css `:root`.
const light: CallColors = {
  background: '#ffffff',
  foreground: '#0a0a0a',
  muted: '#f5f5f5',
  mutedForeground: '#737373',
  secondary: '#f5f5f5',
  secondaryForeground: '#1f1f1f',
  accent: '#f5f5f5',
  primary: '#266df0',
  primaryForeground: '#ffffff',
  destructive: '#ef4444',
  border: '#e5e5e5',
  // bg-red-100  text-red-500  ring-red-400/40
  offBg: '#fee2e2',
  offFg: '#ef4444',
  offRing: 'rgba(248,113,113,0.4)',
  speakingRing: '#22c55e',
  handRing: '#eab308',
  handBadge: '#eab308',
};

export function getCallColors(mode: ThemeMode): CallColors {
  return mode === 'light' ? light : dark;
}

// ─── Camera-off tile palette ─────────────────────────────────────────────────
// Deterministic colored background per participant, à la Google Meet — a direct
// port of @weldsuite/weldmeet-ui participant-tile PERSON_THEMES. The tile gets
// the darker shade; the centered avatar square gets the lighter shade so the
// initials stay legible.

const PERSON_THEMES = [
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

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function getPersonTheme(seed: string) {
  return PERSON_THEMES[hashString(seed || 'guest') % PERSON_THEMES.length]!;
}

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}
