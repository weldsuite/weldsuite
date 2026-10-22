/**
 * WeldSocial ships English and Dutch. Any other device language falls back to
 * English until a catalog is added here.
 */

export const APP_LANGUAGES = ['en', 'nl'] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: AppLanguage = 'en';

export function isAppLanguage(value: string | null | undefined): value is AppLanguage {
  return value === 'en' || value === 'nl';
}

/** Map a locale tag ("nl-NL", "en_GB", …) onto a language this app can render. */
export function resolveAppLanguage(value: string | null | undefined): AppLanguage {
  if (!value) return DEFAULT_LANGUAGE;
  const normalized = value.trim().toLowerCase().replace('_', '-');
  if (isAppLanguage(normalized)) return normalized;
  const base = normalized.split('-')[0];
  if (isAppLanguage(base)) return base;
  return DEFAULT_LANGUAGE;
}

/** The phone's preferred locale tag, or undefined when the runtime has none. */
export function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
