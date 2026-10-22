/**
 * WeldStash ships English and Dutch. Any other locale (the phone's or a
 * profile's) falls back to English until it is added here.
 */

export const APP_LANGUAGES = ['en', 'nl'] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: AppLanguage = 'en';

export const INTL_LOCALES: Record<AppLanguage, string> = {
  en: 'en-GB',
  nl: 'nl-NL',
};

export function isAppLanguage(value: string | null | undefined): value is AppLanguage {
  return value === 'en' || value === 'nl';
}

/** Map a locale code ("nl-NL", "en_GB", "nl") onto a language this app can render. */
export function resolveAppLanguage(value: string | null | undefined): AppLanguage {
  if (!value) return DEFAULT_LANGUAGE;
  const normalized = value.trim().toLowerCase().replace('_', '-');
  if (isAppLanguage(normalized)) return normalized;
  const base = normalized.split('-')[0];
  if (isAppLanguage(base)) return base;
  return DEFAULT_LANGUAGE;
}

/** The phone's locale tag, when the JS engine exposes one. */
export function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
