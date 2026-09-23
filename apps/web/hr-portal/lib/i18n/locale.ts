import type { Dictionary } from './en';
import { en } from './en';
import { nl } from './nl';

export type Locale = 'en' | 'nl';
export const LOCALES: Locale[] = ['en', 'nl'];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'hrportal_locale';

export const dictionaries: Record<Locale, Dictionary> = { en, nl };

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'en' || value === 'nl';
}

/** First supported locale in an `Accept-Language` header, else the default. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const tags = header.split(',').map((part) => part.split(';')[0]?.trim().toLowerCase());
  for (const tag of tags) {
    if (!tag) continue;
    const lang = tag.split('-')[0];
    if (isLocale(lang)) return lang;
  }
  return DEFAULT_LOCALE;
}
