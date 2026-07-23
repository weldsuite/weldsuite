import type { SpeakerColor } from './types';

export const SPEAKER_COLORS: SpeakerColor[] = [
  { bg: 'bg-blue-500', ring: 'ring-blue-500/20', text: 'text-blue-600', light: 'bg-blue-50 dark:bg-blue-950/30' },
  { bg: 'bg-emerald-500', ring: 'ring-emerald-500/20', text: 'text-emerald-600', light: 'bg-emerald-50 dark:bg-emerald-950/30' },
  { bg: 'bg-violet-500', ring: 'ring-violet-500/20', text: 'text-violet-600', light: 'bg-violet-50 dark:bg-violet-950/30' },
  { bg: 'bg-amber-500', ring: 'ring-amber-500/20', text: 'text-amber-600', light: 'bg-amber-50 dark:bg-amber-950/30' },
  { bg: 'bg-rose-500', ring: 'ring-rose-500/20', text: 'text-rose-600', light: 'bg-rose-50 dark:bg-rose-950/30' },
  { bg: 'bg-cyan-500', ring: 'ring-cyan-500/20', text: 'text-cyan-600', light: 'bg-cyan-50 dark:bg-cyan-950/30' },
];

export const SPEAKER_COLOR_HEX_MAP: Record<string, string> = {
  'bg-blue-500': '#3b82f6',
  'bg-emerald-500': '#10b981',
  'bg-violet-500': '#8b5cf6',
  'bg-amber-500': '#f59e0b',
  'bg-rose-500': '#f43f5e',
  'bg-cyan-500': '#06b6d4',
};

export function getSpeakerColor(speakerId: number): SpeakerColor {
  return SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length];
}

export function getSpeakerHex(speakerId: number): string {
  const color = getSpeakerColor(speakerId);
  return SPEAKER_COLOR_HEX_MAP[color.bg] || '#3b82f6';
}
