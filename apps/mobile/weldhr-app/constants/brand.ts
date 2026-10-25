/** WeldHR teal, the same as the platform's WeldHR icon. */
export const BRAND = '#0D9488';

/** Soft fills for status pills and cards, readable in light and dark mode. */
export const TONES = {
  brand: { fg: '#0F766E', bg: 'rgba(13, 148, 136, 0.12)' },
  success: { fg: '#047857', bg: 'rgba(16, 185, 129, 0.14)' },
  warning: { fg: '#B45309', bg: 'rgba(245, 158, 11, 0.16)' },
  danger: { fg: '#B91C1C', bg: 'rgba(220, 38, 38, 0.12)' },
  info: { fg: '#1D4ED8', bg: 'rgba(59, 130, 246, 0.12)' },
  neutral: { fg: '#6B7280', bg: 'rgba(107, 114, 128, 0.12)' },
} as const;

/** Dark mode keeps the fills but needs lighter text. */
export const DARK_TONE_FG: Record<keyof typeof TONES, string> = {
  brand: '#5EEAD4',
  success: '#6EE7B7',
  warning: '#FCD34D',
  danger: '#FCA5A5',
  info: '#93C5FD',
  neutral: '#D1D5DB',
};

export type Tone = keyof typeof TONES;

/** Text colour for a tone on its own tinted fill. */
export function toneFg(tone: Tone, theme: 'light' | 'dark'): string {
  return theme === 'dark' ? DARK_TONE_FG[tone] : TONES[tone].fg;
}
