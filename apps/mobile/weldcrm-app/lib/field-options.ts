/**
 * Option lists for the person and company pickers, the same values the
 * platform's record panel offers (`components/objects/_shared/crm-field-options.ts`).
 */

import type { AppLanguage } from './i18n/language';

/** Lifecycle stages in funnel order; the API validates writes against this list. */
export const LIFECYCLE_STAGES = [
  'subscriber',
  'lead',
  'marketing_qualified',
  'sales_qualified',
  'opportunity',
  'customer',
  'evangelist',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** Built-in customer statuses; a workspace adds its own in Settings > WeldCRM. */
export const BUILT_IN_STATUSES = [
  { value: 'prospect', color: '#3B82F6' },
  { value: 'active', color: '#10B981' },
  { value: 'inactive', color: '#9CA3AF' },
  { value: 'churned', color: '#EF4444' },
  { value: 'blacklisted', color: '#52525B' },
] as const;

/** Tailwind-ish colour names the settings page stores, as hex for the app. */
const NAMED_COLORS: Record<string, string> = {
  blue: '#3B82F6',
  green: '#10B981',
  gray: '#9CA3AF',
  grey: '#9CA3AF',
  red: '#EF4444',
  zinc: '#52525B',
  yellow: '#EAB308',
  orange: '#F97316',
  purple: '#A855F7',
  pink: '#EC4899',
  indigo: '#6366F1',
  teal: '#14B8A6',
  cyan: '#06B6D4',
  amber: '#F59E0B',
  emerald: '#10B981',
  lime: '#84CC16',
  sky: '#0EA5E9',
  violet: '#8B5CF6',
  rose: '#F43F5E',
  fuchsia: '#D946EF',
  slate: '#64748B',
};

/** A stored colour (name, `bg-blue-500` class or hex) as hex; undefined when unknown. */
export function toHexColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  if (color.startsWith('#')) return color;
  const name = /^(?:bg-)?([a-z]+)/.exec(color)?.[1];
  return name ? NAMED_COLORS[name] : undefined;
}

/** ISO 639-1 codes offered by the preferred-language picker (same list as the web). */
export const PREFERRED_LANGUAGE_CODES = [
  'en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'sv', 'da', 'nb', 'fi',
  'cs', 'sk', 'hu', 'ro', 'bg', 'el', 'hr', 'sl', 'sr', 'lt', 'lv', 'et',
  'tr', 'ru', 'uk', 'ar', 'he', 'fa', 'hi', 'zh', 'ja', 'ko', 'th', 'vi',
  'id', 'ms',
] as const;

/**
 * Language names in the app's languages. Hermes has no `Intl.DisplayNames`, so
 * they are spelled out here.
 */
const LANGUAGE_NAMES: Record<AppLanguage, Record<string, string>> = {
  en: {
    en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
    pl: 'Polish', sv: 'Swedish', da: 'Danish', nb: 'Norwegian', fi: 'Finnish', cs: 'Czech', sk: 'Slovak',
    hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian', el: 'Greek', hr: 'Croatian', sl: 'Slovenian', sr: 'Serbian',
    lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', tr: 'Turkish', ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic',
    he: 'Hebrew', fa: 'Persian', hi: 'Hindi', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', th: 'Thai',
    vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay',
  },
  nl: {
    en: 'Engels', nl: 'Nederlands', de: 'Duits', fr: 'Frans', es: 'Spaans', it: 'Italiaans', pt: 'Portugees',
    pl: 'Pools', sv: 'Zweeds', da: 'Deens', nb: 'Noors', fi: 'Fins', cs: 'Tsjechisch', sk: 'Slowaaks',
    hu: 'Hongaars', ro: 'Roemeens', bg: 'Bulgaars', el: 'Grieks', hr: 'Kroatisch', sl: 'Sloveens', sr: 'Servisch',
    lt: 'Litouws', lv: 'Lets', et: 'Estisch', tr: 'Turks', ru: 'Russisch', uk: 'Oekraïens', ar: 'Arabisch',
    he: 'Hebreeuws', fa: 'Perzisch', hi: 'Hindi', zh: 'Chinees', ja: 'Japans', ko: 'Koreaans', th: 'Thai',
    vi: 'Vietnamees', id: 'Indonesisch', ms: 'Maleis',
  },
};

/** "Dutch" / "Nederlands" for "nl"; the code itself when it isn't in the list. */
export function languageName(code: string | null | undefined, language: AppLanguage): string {
  if (!code) return '';
  return LANGUAGE_NAMES[language][code] ?? code.toUpperCase();
}

/** The language options sorted by name in the app's language. */
export function languageOptions(language: AppLanguage): { value: string; label: string }[] {
  return PREFERRED_LANGUAGE_CODES.map((code) => ({ value: code, label: languageName(code, language) })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}
