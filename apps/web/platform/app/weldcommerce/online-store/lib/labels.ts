/**
 * The theme package labels its sections and settings in the platform's two
 * complete languages (`{ en, nl }`); the editor shows the one of the current
 * platform language, English for any other.
 */

import { getLocale } from '@/lib/i18n';

export interface ThemeLabel {
  en: string;
  nl: string;
}

export function pickLabel(label: ThemeLabel | undefined): string {
  if (!label) return '';
  return getLocale() === 'nl' ? label.nl : label.en;
}
