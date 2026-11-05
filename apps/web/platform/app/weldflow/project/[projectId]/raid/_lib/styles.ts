/**
 * Tailwind classes of the RAID screens: one place for the band colours of the
 * matrix, score badges and trend chart, and the tones of status pills. The
 * matrix cells keep the classic flat risk-matrix colours (green, yellow,
 * orange, red) in both themes; every other entry has a dark-mode variant.
 */

import type { RiskBand } from '@weldsuite/app-api-client/domains/project-control';
import type { Tone } from './raid';

export interface BandStyle {
  /** A matrix cell: the flat classic colour, the same in both themes (its text is black). */
  cell: string;
  /** A score badge. */
  badge: string;
  /** A band stripe behind the trend chart. */
  stripe: string;
}

export const BAND_STYLES: Readonly<Record<RiskBand, BandStyle>> = {
  low: {
    cell: 'bg-[#70ad47]',
    badge: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
    stripe: 'fill-green-50 dark:fill-green-950/40',
  },
  medium: {
    cell: 'bg-[#ffff00]',
    badge: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    stripe: 'fill-amber-50 dark:fill-amber-950/40',
  },
  high: {
    cell: 'bg-[#ffc000]',
    badge: 'bg-orange-200 text-orange-900 dark:bg-orange-900/70 dark:text-orange-100',
    stripe: 'fill-orange-50 dark:fill-orange-950/40',
  },
  critical: {
    cell: 'bg-[#ff0000]',
    badge: 'bg-red-600 text-white dark:bg-red-700',
    stripe: 'fill-red-50 dark:fill-red-950/40',
  },
};

export const TONE_PILL: Readonly<Record<Tone, string>> = {
  neutral: 'bg-muted text-foreground/80',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

export const TONE_DOT: Readonly<Record<Tone, string>> = {
  neutral: 'bg-muted-foreground/60',
  blue: 'bg-blue-500',
  orange: 'bg-orange-500',
  green: 'bg-green-600',
  red: 'bg-red-600',
};

/** Issue severities share the band scale and its colours. */
export const SEVERITY_BAND: Readonly<Record<string, RiskBand>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'critical',
};
